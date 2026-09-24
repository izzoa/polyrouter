/**
 * The provider card's ONE status line (add-provider-health-signals). It renders the
 * server-computed `health` — whichever of the check record and the live-traffic
 * record was recorded last — and never re-derives which one wins. The status is
 * always stated in text, so colour is never its only carrier.
 */
import type { ProviderHealthSource } from './api';
import { fmtWhen } from './format';
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

export function providerHealthView(
  p: Pick<Provider, 'health' | 'oauthPreset'>,
  now: number,
  checking: boolean,
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
