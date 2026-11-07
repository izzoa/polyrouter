import type { Logger } from '@nestjs/common';
import type { PlanUsageRecorder, PlanUsageStore } from '@polyrouter/data-plane';

/**
 * Discard a provider's plan-usage snapshot and raise its generation (add-subscription-quota-
 * display, design D8). Called AFTER the credential edit's or reconnect's write has committed, so
 * an observation made with the replaced credential (which carries an older generation) is dropped
 * by the merge. It never touches the refresh cooldown.
 *
 * It NEVER throws: a failed clear is logged with a fixed, secret-free line and must not fail the
 * edit or the reconnect (the failover store has already retried a failed primary clear once). On
 * success the recorder learns the new generation, so this instance's next observation is written
 * at once instead of being dropped once to learn it.
 */
export async function clearPlanUsageSnapshot(
  store: PlanUsageStore | undefined,
  recorder: PlanUsageRecorder | undefined,
  providerId: string,
  logger: Pick<Logger, 'warn'>,
): Promise<void> {
  if (store === undefined) return;
  try {
    const gen = await store.clear(providerId);
    recorder?.noteCleared(providerId, gen);
  } catch {
    logger.warn('plan usage: clearing a provider snapshot failed; it will expire on its own');
  }
}
