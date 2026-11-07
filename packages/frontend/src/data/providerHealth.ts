/**
 * The provider card's ONE status line (add-provider-health-signals). It renders the
 * server-computed `health` — whichever of the check record and the live-traffic
 * record was recorded last — and never re-derives which one wins. The status is
 * always stated in text, so colour is never its only carrier.
 */
import type { PlanCooldownDto, PlanCooldownKind, ProviderHealthSource } from './api';
import { fmtUntil, fmtWhen } from './format';
import type { Provider } from '../types';

export type HealthTone = 'red' | 'green' | 'neutral' | 'amber';

export interface HealthView {
  readonly tone: HealthTone;
  readonly text: string;
  /** The durable reauthorize-required state: render the distinct banner. */
  readonly banner: boolean;
}

/** Where a recorded observation came from, as the card phrases it. */
const SOURCE_PHRASE: Record<ProviderHealthSource, string> = {
  test: 'Test',
  sync: 'Sync',
  traffic: 'seen in live traffic',
  refresh: 'credential refresh',
  reconnect: 'reconnect',
  edit: 'edit',
};

/** "· <where> <when>" — omitted entirely when the source is unknown (a status
 * recorded before sources existed): never an invented reason or age. */
function provenance(source: ProviderHealthSource | null, at: string | null, now: number): string {
  if (source === null) return '';
  const when = at !== null ? ` ${fmtWhen(at, now)}` : '';
  return ` · ${SOURCE_PHRASE[source]}${when}`;
}

/** What a plan pause is, led by the ACCOUNT condition rather than a bare "paused" state word
 * (classify-plan-quota-errors, design D11): the provider imposed it, so it is not the Ink 2
 * "Paused / off" phrase for configuration the operator chose. */
const PAUSE_LEAD: Record<PlanCooldownKind, string> = {
  quota_exhausted: 'Plan usage limit reached',
  risk_control: 'Provider throttled the account (fair-use policy)',
  plan_inactive: 'No active plan for this key (expired, or not a plan key)',
};

/** The plan pause the card is showing at `now`, or null: absent, expired, or unparseable.
 * The card's Resume now and its expiry timer read the same answer as the status line. */
export function activePause(
  p: { readonly planCooldown?: PlanCooldownDto | null },
  now: number,
): PlanCooldownDto | null {
  const c = p.planCooldown ?? null;
  if (c === null) return null;
  const until = Date.parse(c.until);
  return Number.isNaN(until) || until <= now ? null : c;
}

export function providerHealthView(
  p: Pick<Provider, 'health' | 'oauthPreset'> & { readonly planCooldown?: PlanCooldownDto | null },
  now: number,
  checking: boolean,
  timeZone?: string,
): HealthView {
  const h = p.health;
  if (h.state === 'reauthorize_required') {
    return {
      tone: 'amber',
      text: 'Sign-in expired — reconnect to keep routing through this subscription.',
      banner: true,
    };
  }
  if (checking) return { tone: 'neutral', text: 'Reconnected — checking…', banner: false };
  // A pause outranks the recorded health while it holds (the failure that caused it is in the
  // record, but the provider is not being tried, so "Healthy" or a stale error would mislead).
  // It is amber, never red: the plan is the condition, not a failure of the provider's service.
  const pause = activePause(p, now);
  if (pause !== null) {
    const end = fmtUntil(pause.until, now, timeZone);
    const who = pause.untilSource === 'provider' ? 'resets at' : 'polyrouter retries at';
    return {
      tone: 'amber',
      text: end === null ? PAUSE_LEAD[pause.kind] : `${PAUSE_LEAD[pause.kind]} — ${who} ${end}`,
      banner: false,
    };
  }
  if (h.state === 'error' || h.state === 'failing') {
    const reason = h.message ?? 'Last check failed';
    const hint = h.kind === 'auth' && p.oauthPreset !== null ? ' — reconnect if this persists' : '';
    return {
      tone: 'red',
      text: `${reason}${provenance(h.source, h.at, now)}${hint}`,
      banner: false,
    };
  }
  if (h.state === 'ok') {
    return { tone: 'green', text: `Healthy${provenance(h.source, h.at, now)}`, banner: false };
  }
  return { tone: 'neutral', text: 'Not tested yet', banner: false };
}
