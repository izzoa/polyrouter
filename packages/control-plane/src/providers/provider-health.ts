/**
 * Provider health (add-provider-health-signals): the ONE display rule and the ONE
 * write path, shared by the proxy (traffic transitions), provider management
 * (test/sync), and subscription OAuth (refresh failures). Plain functions over
 * `PersistencePort`, never an injectable — the proxy's test harness wires its
 * dependencies by hand, and the proxy must stay extractable.
 *
 * Two records, each with one ordering authority:
 *  - the CHECK record (`status` + reason/source/time) — deliberate checks;
 *  - the TRAFFIC record — shared-breaker transitions, ordered by the breaker seq.
 * DISPLAYED health is whichever was recorded LAST, by the row-serialized revision
 * the write stamps — never by comparing timestamps taken from different clocks.
 */
import { Logger } from '@nestjs/common';
import type {
  PersistencePort,
  Principal,
  ProviderCheckSource,
  ProviderHealthPatch,
  ProviderIncarnation,
  ProviderRow,
} from '@polyrouter/shared/server';

export type DisplayedHealthState = 'reauthorize_required' | 'ok' | 'error' | 'failing' | 'unknown';
export type DisplayedHealthSource = ProviderCheckSource | 'traffic';

export interface DisplayedHealth {
  readonly state: DisplayedHealthState;
  /** The failure's provider-error kind; null unless the state is a failure. */
  readonly kind: string | null;
  /** Where it was observed; null for a legacy status recorded before sources existed. */
  readonly source: DisplayedHealthSource | null;
  readonly at: Date | null;
}

export type HealthRow = Pick<
  ProviderRow,
  | 'status'
  | 'lastErrorKind'
  | 'statusSource'
  | 'statusChangedAt'
  | 'statusRev'
  | 'trafficState'
  | 'trafficErrorKind'
  | 'trafficAt'
  | 'trafficRev'
  | 'credentialError'
>;

const CHECK_SOURCES: ReadonlySet<string> = new Set([
  'test',
  'sync',
  'refresh',
  'reconnect',
  'edit',
]);

function checkState(status: string): 'ok' | 'error' | 'unknown' {
  return status === 'ok' || status === 'error' ? status : 'unknown';
}

/** The displayed health: the durable reauthorize-required state first, then the
 * record with the higher revision. A legacy `status` (no revision) loses to any
 * traffic record, which can only have been recorded after it. */
export function displayedProviderHealth(row: HealthRow): DisplayedHealth {
  if (row.credentialError === 'reauthorize_required') {
    return {
      state: 'reauthorize_required',
      kind: 'credential',
      source:
        row.statusSource !== null && CHECK_SOURCES.has(row.statusSource)
          ? (row.statusSource as ProviderCheckSource)
          : 'refresh',
      at: row.statusChangedAt,
    };
  }
  const trafficIsNewer =
    row.trafficState !== null && (row.statusRev === null || (row.trafficRev ?? 0) > row.statusRev);
  if (trafficIsNewer) {
    const failing = row.trafficState === 'failing';
    return {
      state: failing ? 'failing' : 'ok',
      kind: failing ? (row.trafficErrorKind ?? 'unavailable') : null,
      source: 'traffic',
      at: row.trafficAt,
    };
  }
  const state = checkState(row.status);
  return {
    state,
    kind: state === 'error' ? row.lastErrorKind : null,
    source:
      row.statusSource !== null && CHECK_SOURCES.has(row.statusSource)
        ? (row.statusSource as ProviderCheckSource)
        : null,
    at: row.statusChangedAt,
  };
}

/** Whether the provider is currently DISPLAYED as healthy — the proxy's
 * transition test for a traffic `ok` write (no write when already displayed ok). */
export function isDisplayedOk(row: HealthRow): boolean {
  return displayedProviderHealth(row).state === 'ok';
}

/** The incarnation a row was loaded with. */
export function incarnationOf(
  row: Pick<ProviderRow, 'encryptedCredentials' | 'baseUrl' | 'protocol'>,
): ProviderIncarnation {
  return { envelope: row.encryptedCredentials, baseUrl: row.baseUrl, protocol: row.protocol };
}

/** The shared check patch every durable `reauthorize_required` write records. */
export function reauthorizeRequiredCheck(): ProviderHealthPatch {
  return { record: 'check', status: 'error', kind: 'credential', source: 'refresh' };
}

const logger = new Logger('ProviderHealth');

/** Record one health observation. NEVER rejects: health is a side effect, so a
 * failed write is dropped with a FIXED message (never the error, which could
 * carry connection detail — invariant 8). Resolves whether a row changed. */
export async function recordProviderHealth(
  db: Pick<PersistencePort, 'providers'>,
  principal: Principal,
  providerId: string,
  patch: ProviderHealthPatch,
  guard: ProviderIncarnation,
): Promise<boolean> {
  try {
    return await db.providers.setHealth(principal, providerId, patch, guard);
  } catch {
    logger.warn('provider health write dropped');
    return false;
  }
}
