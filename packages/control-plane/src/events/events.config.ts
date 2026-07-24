import { loadConfig, registerConfig, z } from '@polyrouter/shared';

/**
 * Dashboard event-stream config (phase2-add-dashboard-event-stream). All knobs are
 * defaulted; cross-field validation fails boot fast (§12).
 */

export const EVENTS_CONFIG = 'polyrouter:events-config';

/** The idle-reap window common to reverse proxies / LBs / CDNs. The heartbeat must
 * stay comfortably under it or an idle stream is silently dropped. */
export const INTERMEDIARY_REAP_FLOOR_MS = 60_000;

registerConfig(
  'events',
  z.object({
    EVENTS_ENABLED: z.string().default('true'),
    EVENTS_HEARTBEAT_MS: z.coerce.number().int().positive().default(25_000),
    EVENTS_RECONCILE_MS: z.coerce.number().int().positive().default(30_000),
    EVENTS_MAX_STREAMS_PER_OWNER: z.coerce.number().int().min(1).max(64).default(6),
    EVENTS_QUEUE_LIMIT: z.coerce.number().int().min(8).max(10_000).default(256),
    EVENTS_NUDGE_COALESCE_MS: z.coerce.number().int().min(1_000).default(1_000),
    /** Server-side authorization revalidation bound; never above the heartbeat. */
    EVENTS_REVALIDATE_MS: z.coerce.number().int().positive().default(15_000),
  }),
);

type EventsEnv = {
  EVENTS_ENABLED: string;
  EVENTS_HEARTBEAT_MS: number;
  EVENTS_RECONCILE_MS: number;
  EVENTS_MAX_STREAMS_PER_OWNER: number;
  EVENTS_QUEUE_LIMIT: number;
  EVENTS_NUDGE_COALESCE_MS: number;
  EVENTS_REVALIDATE_MS: number;
};

export interface EventsConfig {
  readonly enabled: boolean;
  readonly heartbeatMs: number;
  readonly reconcileMs: number;
  readonly maxStreamsPerOwner: number;
  readonly queueLimit: number;
  readonly nudgeCoalesceMs: number;
  readonly revalidateMs: number;
}

/** The fast in-flight poll this stream supersedes — the reconciliation read must
 * never be faster than it (it is a low-rate verifier, not a second poll). */
export const SUPERSEDED_FAST_POLL_MS = 2_500;

export function buildEventsConfig(env: EventsEnv): EventsConfig {
  if (env.EVENTS_HEARTBEAT_MS >= INTERMEDIARY_REAP_FLOOR_MS) {
    throw new Error(
      `EVENTS_HEARTBEAT_MS must be below the ~${String(INTERMEDIARY_REAP_FLOOR_MS)}ms intermediary idle-reap window`,
    );
  }
  if (env.EVENTS_REVALIDATE_MS > env.EVENTS_HEARTBEAT_MS) {
    throw new Error('EVENTS_REVALIDATE_MS must be <= EVENTS_HEARTBEAT_MS (the detection bound)');
  }
  if (env.EVENTS_RECONCILE_MS < SUPERSEDED_FAST_POLL_MS) {
    throw new Error(
      `EVENTS_RECONCILE_MS must be >= ${String(SUPERSEDED_FAST_POLL_MS)}ms — it verifies the stream, it is not a second poll`,
    );
  }
  return {
    enabled: env.EVENTS_ENABLED !== 'false',
    heartbeatMs: env.EVENTS_HEARTBEAT_MS,
    reconcileMs: env.EVENTS_RECONCILE_MS,
    maxStreamsPerOwner: env.EVENTS_MAX_STREAMS_PER_OWNER,
    queueLimit: env.EVENTS_QUEUE_LIMIT,
    nudgeCoalesceMs: env.EVENTS_NUDGE_COALESCE_MS,
    revalidateMs: env.EVENTS_REVALIDATE_MS,
  };
}

export function loadEventsConfig(): EventsConfig {
  return buildEventsConfig(loadConfig<EventsEnv>());
}
