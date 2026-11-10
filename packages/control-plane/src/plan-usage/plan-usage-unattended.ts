/** The outcome of ONE unattended (scheduled) usage read (add-subscription-usage-history, design
 * D1). `read` means the endpoint was called (its result is `ok` or a typed failure `kind`);
 * `skipped` means nothing was sent: the row vanished, it is not eligible (switch off, reconnect
 * needed, no enabled endpoint, drifted), or the shared cooldown is held (a click or another
 * instance read it within the cooldown). */
export type UnattendedUsageOutcome =
  | { readonly status: 'read'; readonly ok: boolean; readonly kind?: string }
  | { readonly status: 'skipped'; readonly reason: 'missing' | 'ineligible' | 'cooldown' };

/** The shared cooldown store could not be reached for a scheduled read: nothing was sent, and the
 * schedule ends its tick rather than burst (a per-instance cooldown would let N instances read). */
export class PlanUsageStoreUnavailableError extends Error {
  constructor() {
    super('plan usage: the shared usage store is unreachable');
    this.name = 'PlanUsageStoreUnavailableError';
  }
}
