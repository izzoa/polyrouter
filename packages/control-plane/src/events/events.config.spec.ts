import { buildEventsConfig, INTERMEDIARY_REAP_FLOOR_MS, SUPERSEDED_FAST_POLL_MS } from './events.config';

/** phase2-add-dashboard-event-stream: cross-field validation fails boot fast (§12). */

const base = {
  EVENTS_ENABLED: 'true',
  EVENTS_HEARTBEAT_MS: 25_000,
  EVENTS_RECONCILE_MS: 30_000,
  EVENTS_MAX_STREAMS_PER_OWNER: 6,
  EVENTS_QUEUE_LIMIT: 256,
  EVENTS_NUDGE_COALESCE_MS: 1_000,
  EVENTS_REVALIDATE_MS: 15_000,
};

describe('buildEventsConfig', () => {
  it('accepts the defaults', () => {
    const cfg = buildEventsConfig(base);
    expect(cfg.enabled).toBe(true);
    expect(cfg.heartbeatMs).toBeLessThan(INTERMEDIARY_REAP_FLOOR_MS);
  });

  it('rejects a heartbeat at or above the intermediary idle-reap window', () => {
    // Otherwise an idle stream is silently dropped by a proxy/LB/CDN.
    expect(() =>
      buildEventsConfig({ ...base, EVENTS_HEARTBEAT_MS: INTERMEDIARY_REAP_FLOOR_MS }),
    ).toThrow(/idle-reap/);
  });

  it('rejects a revalidation bound looser than the heartbeat', () => {
    // Revalidation IS the revocation-detection bound; it must not lag the heartbeat.
    expect(() => buildEventsConfig({ ...base, EVENTS_REVALIDATE_MS: 30_000 })).toThrow(
      /EVENTS_REVALIDATE_MS/,
    );
  });

  it('rejects a reconciliation read faster than the poll it supersedes', () => {
    // It verifies the stream; it must never become a second fast poll.
    expect(() =>
      buildEventsConfig({ ...base, EVENTS_RECONCILE_MS: SUPERSEDED_FAST_POLL_MS - 1 }),
    ).toThrow(/EVENTS_RECONCILE_MS/);
  });

  it('treats only an explicit "false" as disabled', () => {
    expect(buildEventsConfig({ ...base, EVENTS_ENABLED: 'false' }).enabled).toBe(false);
    expect(buildEventsConfig({ ...base, EVENTS_ENABLED: 'no' }).enabled).toBe(true);
  });
});
