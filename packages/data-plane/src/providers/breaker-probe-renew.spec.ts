// E4.1: a long-lived streaming half-open probe renews its lease on stream
// activity so its eventual success closes the breaker — while the silent-probe
// (reclaimed-expired-lease) semantics survive via the renewal expiry guard.
import {
  CircuitBreaker,
  InMemoryBreakerStore,
  applyRenew,
  withBreaker,
  withBreakerStream,
  type BreakerConfig,
  type BreakerRecord,
  type BreakerStore,
} from './breaker';
import { ProviderError } from './errors';
import type { NormalizedStreamEvent } from '../proxy/translate';

const PID = 'prov-1';
const cfg: BreakerConfig = {
  threshold: 1, // one tripping failure opens — sharpest pin
  cooldownMs: 1_000,
  probeLeaseMs: 300, // renewEveryMs = floor(300/3) = 100
  stateTtlMs: 60_000,
};

const trip = (): Promise<never> => Promise.reject(new ProviderError('unavailable', 'boom'));

/** Open the breaker (threshold 1) at the current clock, then jump the clock past
 * the cooldown so the next admission is a half-open probe. */
async function openThenReachCooldown(breaker: CircuitBreaker, clock: { t: number }): Promise<void> {
  await expect(withBreaker(breaker, PID, trip)).rejects.toThrow('boom');
  clock.t += cfg.cooldownMs; // cooldown elapsed → next decide admits a probe
}

/** A probe upstream: message_start, then `deltas` text events, then a terminal
 * `message_delta` (stopReason) so the stream settles success. */
// eslint-disable-next-line @typescript-eslint/require-await -- AsyncGenerator by contract
async function* probeUpstream(deltas: number): AsyncGenerator<NormalizedStreamEvent> {
  yield { type: 'message_start', id: 'm', model: 'x', role: 'assistant' };
  for (let i = 0; i < deltas; i += 1) yield { type: 'text_delta', index: 0, text: 't' };
  yield { type: 'message_delta', stopReason: 'stop' };
}

describe('applyRenew — pure lease renewal with the expiry guard', () => {
  const rec: BreakerRecord = {
    state: 'half_open',
    failures: 0,
    openedAt: 0,
    generation: 3,
    probeExpiresAt: 300,
  };

  it('extends the lease for the current generation while still unexpired', () => {
    expect(applyRenew(rec, 3, 200, cfg).probeExpiresAt).toBe(200 + cfg.probeLeaseMs);
  });

  it('is a no-op at or after expiry (does not revive a lapsed lease)', () => {
    expect(applyRenew(rec, 3, 300, cfg)).toBe(rec); // now === probeExpiresAt
    expect(applyRenew(rec, 3, 350, cfg)).toBe(rec); // now > probeExpiresAt
  });

  it('is a no-op for a stale generation or a non-half-open state', () => {
    expect(applyRenew(rec, 2, 200, cfg)).toBe(rec); // stale generation
    expect(applyRenew({ ...rec, state: 'closed' }, 3, 200, cfg).state).toBe('closed');
  });

  it('never shortens a lease that already extends past now + probeLeaseMs (clock-step safe)', () => {
    const far: BreakerRecord = { ...rec, probeExpiresAt: 5_000 }; // lease already far out
    // now=200 is live (< 5000); now + probeLeaseMs = 500 < 5000 → keep the larger.
    expect(applyRenew(far, 3, 200, cfg).probeExpiresAt).toBe(5_000);
  });
});

describe('withBreakerStream — probe lease renewal closes the breaker', () => {
  it('renews across lease windows so a long probe stream closes the breaker, holding single-probe', async () => {
    const clock = { t: 0 };
    const store = new InMemoryBreakerStore();
    const breaker = new CircuitBreaker(store, { config: cfg, now: () => clock.t });
    await openThenReachCooldown(breaker, clock); // clock.t = 1000

    const gen = withBreakerStream(breaker, PID, () => probeUpstream(6), undefined, undefined, () => false);

    // First pull admits the probe (generation bumped, lease = 1000 + 300 = 1300).
    const first = await gen.next();
    expect(first.value).toMatchObject({ type: 'message_start' });

    // Advance INTO the second half of the base lease and pump a delta → renewal
    // fires (150 ≥ renewEveryMs 100), extending the lease well past 1300.
    clock.t = 1150;
    await gen.next(); // text_delta at 1150 → renew → lease = 1450

    // Past the ORIGINAL 1300 expiry: a concurrent admission still SKIPS because the
    // renewal moved the lease to 1450. This is the crux — without renewal it would
    // reclaim here (proven by the revert-pin test below).
    clock.t = 1400;
    const concurrent = await store.decide(PID, clock.t, cfg);
    expect(concurrent.decision).toBe('skip');
    expect(concurrent.isProbe).toBe(false);

    // Keep streaming across further windows, then drain to the terminal stop.
    clock.t = 1550;
    await gen.next(); // renew → lease = 1850
    clock.t = 1800;
    await gen.next(); // renew → lease = 2100
    for (;;) {
      const r = await gen.next();
      if (r.done) break;
      clock.t += 120;
    }

    // The probe's success closed the breaker: a fresh admission is a plain closed
    // allow (not a skip, not a new probe).
    const after = await store.decide(PID, clock.t, cfg);
    expect(after).toMatchObject({ decision: 'allow', isProbe: false });
  });

  it('renews after a BACKWARD clock step instead of stalling until wall time catches up', async () => {
    const clock = { t: 0 };
    const inner = new InMemoryBreakerStore();
    const renews: number[] = [];
    const recording: BreakerStore = {
      decide: (p, n, c) => inner.decide(p, n, c),
      complete: (p, g, o, n, c) => inner.complete(p, g, o, n, c),
      renew: (p, g, n, c) => {
        renews.push(n);
        return inner.renew(p, g, n, c);
      },
    };
    const breaker = new CircuitBreaker(recording, { config: cfg, now: () => clock.t });
    await openThenReachCooldown(breaker, clock); // clock.t = 1000

    const gen = withBreakerStream(breaker, PID, () => probeUpstream(6), undefined, undefined, () => false);
    await gen.next(); // admit at t=1000, lastRenewAt=1000
    clock.t = 1200;
    await gen.next(); // 1200-1000 ≥ 100 → renew
    const beforeBack = renews.length;

    // Wall clock steps BACKWARD below lastRenewAt: the throttle must still renew
    // (a plain `t - lastRenewAt ≥ interval` would stall while the lease elapses).
    clock.t = 900;
    await gen.next();
    expect(renews.length).toBeGreaterThan(beforeBack);

    for (;;) {
      const r = await gen.next();
      if (r.done) break;
      clock.t += 50;
    }
    const after = await inner.decide(PID, clock.t, cfg);
    expect(after).toMatchObject({ decision: 'allow', isProbe: false }); // still closed cleanly
  });

  it('REVERT PIN: with renewal disabled, the same sequence reclaims mid-stream and does NOT close', async () => {
    const clock = { t: 0 };
    const inner = new InMemoryBreakerStore();
    // A store whose renew() is a no-op — simulates the pre-E4.1 behavior.
    const noRenew: BreakerStore = {
      decide: (p, n, c) => inner.decide(p, n, c),
      complete: (p, g, o, n, c) => inner.complete(p, g, o, n, c),
      renew: () => Promise.resolve(),
    };
    const breaker = new CircuitBreaker(noRenew, { config: cfg, now: () => clock.t });
    await openThenReachCooldown(breaker, clock); // clock.t = 1000

    const gen = withBreakerStream(breaker, PID, () => probeUpstream(6), undefined, undefined, () => false);
    await gen.next(); // admit probe, lease = 1300
    clock.t = 1150;
    await gen.next(); // no renewal → lease stays 1300

    // Past 1300 the lease is expired: a concurrent admission RECLAIMS (new probe),
    // bumping the generation and orphaning the in-flight probe.
    clock.t = 1400;
    const concurrent = await inner.decide(PID, clock.t, cfg);
    expect(concurrent.decision).toBe('allow');
    expect(concurrent.isProbe).toBe(true); // reclaimed — NOT skipped

    // Drain the orphaned original stream; its success is a stale generation.
    for (;;) {
      const r = await gen.next();
      if (r.done) break;
      clock.t += 120;
    }
    // Not closed: the current generation is the reclaimed probe, still half-open.
    const after = await inner.decide(PID, clock.t + 5_000, cfg); // even after another cooldown
    expect(after.isProbe).toBe(true); // still probing, never closed by the orphan
  });
});

describe('probe expiry guard — a late/silent probe is reclaimed, its completion ignored', () => {
  it('a renewal after expiry is a no-op; the next decide reclaims and the old completion is stale', async () => {
    const clock = { t: 0 };
    const store = new InMemoryBreakerStore();
    const breaker = new CircuitBreaker(store, { config: cfg, now: () => clock.t });
    await openThenReachCooldown(breaker, clock); // clock.t = 1000

    const probe = await store.decide(PID, clock.t, cfg); // admit probe (gen G1, lease 1300)
    expect(probe.isProbe).toBe(true);
    const g1 = probe.generation;

    // The probe goes silent until AFTER its lease; a late renewal must not revive it.
    clock.t = 1400;
    await store.renew(PID, g1, clock.t, cfg); // expiry guard → no-op

    const reclaim = await store.decide(PID, clock.t, cfg); // reclaims → new generation
    expect(reclaim.isProbe).toBe(true);
    expect(reclaim.generation).not.toBe(g1);

    // The original probe finally completes success — stale generation, ignored.
    const done = await store.complete(PID, g1, 'success', clock.t, cfg);
    expect(done.justOpened).toBe(false);
    const still = await store.decide(PID, clock.t, cfg);
    expect(still.decision).toBe('skip'); // reclaimed probe still holds the lease — not closed
  });
});

describe('renewProbe — fire-and-forget containment', () => {
  it('a rejecting renew store AND a throwing onError never break the probe stream', async () => {
    const clock = { t: 0 };
    const inner = new InMemoryBreakerStore();
    const rejectingRenew: BreakerStore = {
      decide: (p, n, c) => inner.decide(p, n, c),
      complete: (p, g, o, n, c) => inner.complete(p, g, o, n, c),
      renew: () => Promise.reject(new Error('redis down')),
    };
    const rejections: unknown[] = [];
    const onRejection = (e: unknown): void => void rejections.push(e);
    process.on('unhandledRejection', onRejection);
    try {
      const breaker = new CircuitBreaker(rejectingRenew, {
        config: cfg,
        now: () => clock.t,
        onError: () => {
          throw new Error('hook boom'); // a throwing caller-supplied hook
        },
      });
      await openThenReachCooldown(breaker, clock);

      // Drive a probe stream that triggers renewals; it must complete cleanly.
      const gen = withBreakerStream(breaker, PID, () => probeUpstream(6), undefined, undefined, () => false);
      await gen.next();
      clock.t = 1150;
      for (;;) {
        const r = await gen.next();
        if (r.done) break;
        clock.t += 120;
      }
      // Renewal failed every time, yet the terminal success still closed the breaker.
      const after = await inner.decide(PID, clock.t, cfg);
      expect(after).toMatchObject({ decision: 'allow', isProbe: false });
      // Let any (incorrectly) escaped rejection surface on the microtask queue.
      await new Promise((r) => setImmediate(r));
      expect(rejections).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});
