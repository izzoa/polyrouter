/**
 * The per-attempt settle hook the proxy gives every chain member
 * (add-provider-health-signals). A plain function, not an injectable: the proxy's
 * test harness wires its dependencies by hand, and ProxyService already holds the
 * two collaborators this needs.
 *
 * It is SYNCHRONOUS and fire-and-forget: every write or refresh starts with `void`
 * and never rejects (both callees swallow their own failures), so a slow or
 * failing health write can never delay, fail, or alter the request (invariant 11).
 * It is created per attempt and reads only that attempt's own state, so two
 * members of the same provider — or two concurrent requests — never share a guard.
 */
import type { BreakerSettleListener } from '@polyrouter/data-plane';
import type {
  PersistencePort,
  Principal,
  ProviderIncarnation,
  ProviderRow,
} from '@polyrouter/shared/server';
import type { SubscriptionOauthService } from '../subscription-oauth/subscription-oauth.service';
import { incarnationOf, isDisplayedOk, recordProviderHealth } from '../providers/provider-health';

/** Filled by the attempt's own adapter build: the incarnation the attempt
 * actually dispatched with (the envelope its OAuth resolution used — the NEWLY
 * written one when the build lazily refreshed). */
export interface AttemptHealthState {
  used?: ProviderIncarnation;
}

export interface AttemptHealthDeps {
  readonly db: Pick<PersistencePort, 'providers'>;
  readonly oauth: Pick<SubscriptionOauthService, 'requestForcedRefresh'>;
}

export function attemptHealthHook(
  deps: AttemptHealthDeps,
  principal: Principal,
  provider: ProviderRow,
  state: AttemptHealthState,
): BreakerSettleListener {
  // The transition test reads the row THIS request loaded — no extra round trip.
  const displayedOk = isDisplayedOk(provider);
  return (info) => {
    // A build that never resolved (e.g. a setup failure) is guarded by the row the
    // request loaded; anything else by what the attempt actually used.
    const guard = state.used ?? incarnationOf(provider);
    if (info.justOpened && info.kind !== null) {
      void recordProviderHealth(
        deps.db,
        principal,
        provider.id,
        { record: 'traffic', state: 'failing', kind: info.kind, seq: info.seq },
        guard,
      );
    } else if (info.outcome === 'success' && info.kind === null && info.applied && !displayedOk) {
      // A genuinely served attempt the shared breaker accepted as current — written
      // only when the provider is not already displayed ok (bounded by construction).
      void recordProviderHealth(
        deps.db,
        principal,
        provider.id,
        { record: 'traffic', state: 'ok', kind: null, seq: info.seq },
        guard,
      );
    }
    // A 401 from an OAuth-connected provider: one bounded, out-of-band forced
    // refresh keyed on the credential this attempt used. Never an in-request retry.
    const envelope = state.used?.envelope ?? null;
    if (info.kind === 'auth' && provider.oauthPreset !== null && envelope !== null) {
      void deps.oauth.requestForcedRefresh(principal, provider.id, envelope).catch(() => undefined);
    }
  };
}
