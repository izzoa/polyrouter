import {
  decide,
  applyComplete,
  INITIAL_RECORD,
  type BreakerConfig,
  type BreakerRecord,
} from './breaker';

const cfg: BreakerConfig = {
  threshold: 3,
  cooldownMs: 1000,
  probeLeaseMs: 200,
  stateTtlMs: 10_000,
};

function trip(rec: BreakerRecord, now: number): BreakerRecord {
  const a = decide(rec, now, cfg);
  return applyComplete(a.next, a.generation, 'trip', now, cfg);
}

describe('breaker transition (pure state machine)', () => {
  it('closed → open after threshold consecutive trips', () => {
    let rec = INITIAL_RECORD;
    rec = trip(rec, 0); // failures 1
    expect(rec.state).toBe('closed');
    rec = trip(rec, 0); // failures 2
    expect(rec.state).toBe('closed');
    rec = trip(rec, 0); // failures 3 → open
    expect(rec.state).toBe('open');
  });

  it('open denies before cooldown, admits a single probe after', () => {
    let rec: BreakerRecord = {
      state: 'open',
      failures: 0,
      openedAt: 0,
      generation: 1,
      probeExpiresAt: 0,
    };
    expect(decide(rec, 500, cfg).decision).toBe('skip');
    const probe = decide(rec, 1000, cfg);
    expect(probe.decision).toBe('allow');
    expect(probe.isProbe).toBe(true);
    expect(probe.generation).toBe(2);
    rec = probe.next;
    // a second caller during half-open is denied (single probe)
    expect(decide(rec, 1001, cfg).decision).toBe('skip');
  });

  it('half_open → closed on probe success, → open on probe failure', () => {
    const open: BreakerRecord = {
      state: 'open',
      failures: 0,
      openedAt: 0,
      generation: 1,
      probeExpiresAt: 0,
    };
    const probe = decide(open, 1000, cfg);
    const closed = applyComplete(probe.next, probe.generation, 'success', 1000, cfg);
    expect(closed.state).toBe('closed');

    const probe2 = decide(open, 1000, cfg);
    const reopened = applyComplete(probe2.next, probe2.generation, 'trip', 1000, cfg);
    expect(reopened.state).toBe('open');
  });

  it('a stale-generation completion is ignored', () => {
    const open: BreakerRecord = {
      state: 'open',
      failures: 0,
      openedAt: 0,
      generation: 1,
      probeExpiresAt: 0,
    };
    const probe = decide(open, 1000, cfg); // generation 2
    // a completion carrying the OLD generation (1) must not transition
    const unchanged = applyComplete(probe.next, 1, 'success', 1000, cfg);
    expect(unchanged).toEqual(probe.next);
    expect(unchanged.state).toBe('half_open');
  });

  it('reclaiming an expired probe lease bumps the generation (probe A can not impersonate B)', () => {
    const open: BreakerRecord = {
      state: 'open',
      failures: 0,
      openedAt: 0,
      generation: 1,
      probeExpiresAt: 0,
    };
    const probeA = decide(open, 1000, cfg); // gen 2, lease expires at 1200
    // A never reports; at t=1300 the lease is expired → B is admitted with a new generation
    const probeB = decide(probeA.next, 1300, cfg);
    expect(probeB.isProbe).toBe(true);
    expect(probeB.generation).toBe(3);
    // A finally completes (success) with its stale generation 2 → ignored
    const afterStaleA = applyComplete(probeB.next, probeA.generation, 'success', 1400, cfg);
    expect(afterStaleA.state).toBe('half_open');
    // only B's completion transitions
    const afterB = applyComplete(probeB.next, probeB.generation, 'success', 1400, cfg);
    expect(afterB.state).toBe('closed');
  });

  it('a success in closed clears accumulated failures', () => {
    let rec = trip(INITIAL_RECORD, 0); // failures 1
    const a = decide(rec, 0, cfg);
    rec = applyComplete(a.next, a.generation, 'success', 0, cfg);
    expect(rec.failures).toBe(0);
  });
});
