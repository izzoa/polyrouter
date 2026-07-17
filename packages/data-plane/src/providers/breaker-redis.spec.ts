import Redis from 'ioredis';
import {
  InMemoryBreakerStore,
  RedisBreakerStore,
  type BreakerConfig,
  type BreakerStore,
} from './breaker';

const REDIS_URL = process.env['REDIS_URL'];
// Real durations: the Lua now reads the Redis SERVER clock (E4.2), so time-based
// transitions can no longer be driven by an injected `now` — they are exercised
// with real `sleep`s past small cooldown/lease windows. Instantaneous transitions
// (open on threshold, generation guard, single-probe at one instant) stay clock-
// independent and are checked for InMemory↔Redis parity.
const cfg: BreakerConfig = {
  threshold: 3,
  cooldownMs: 200,
  probeLeaseMs: 200,
  stateTtlMs: 10_000,
};

// The pure-transition and shared-InMemory suites prove the state machine
// everywhere; this suite pins the Lua to it against a real Redis. It is gated on
// REDIS_URL for local runs, but in CI it MUST run (ci-pipeline spec: env-gated
// suites fail loudly when their infrastructure is missing, never silently skip).
if (REDIS_URL === undefined && process.env['CI'] !== undefined) {
  throw new Error(
    '[breaker-redis] CI is set but REDIS_URL is missing — the real-Redis parity/concurrency ' +
      'suite is required in CI. Provision a redis service and export REDIS_URL ' +
      '(e.g. redis://127.0.0.1:6379); see .github/workflows/ci.yml.',
  );
}
const suite = REDIS_URL !== undefined ? describe : describe.skip;
if (REDIS_URL === undefined) {
  console.warn(
    '[breaker-redis] REDIS_URL not set — skipping the real-Redis parity/concurrency suite',
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Trip the breaker open with `threshold` counted failures at ~one instant. */
async function open(store: BreakerStore, pid: string, now: number): Promise<void> {
  for (let i = 0; i < cfg.threshold; i += 1) {
    const a = await store.decide(pid, now, cfg);
    await store.complete(pid, a.generation, 'trip', now, cfg);
  }
}

suite('RedisBreakerStore against real Redis', () => {
  let redis: Redis;
  const prefix = `test:cb:${String(Date.now())}:`;

  beforeAll(() => {
    redis = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1, lazyConnect: false });
  });
  afterAll(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it('parity (instantaneous): opens on threshold and skips while open, matching InMemory', async () => {
    const mem = new InMemoryBreakerStore();
    const red = new RedisBreakerStore(redis, prefix);
    // Drive InMemory at a single fixed instant so it doesn't cross the cooldown;
    // Redis ignores the passed `now` and uses server time (all within a few ms).
    for (const store of [mem, red] as const) {
      const pid = 'parity';
      await open(store, pid, 0);
      const s1 = await store.decide(pid, 0, cfg);
      expect(s1.decision).toBe('skip'); // open, still in cooldown
      const s2 = await store.decide(pid, 0, cfg);
      expect(s2.decision).toBe('skip');
    }
  });

  it('parity (generation guard): a stale-generation completion is ignored, matching InMemory', async () => {
    for (const store of [new InMemoryBreakerStore(), new RedisBreakerStore(redis, prefix)] as const) {
      const pid = `stale-${store instanceof RedisBreakerStore ? 'red' : 'mem'}`;
      const a = await store.decide(pid, 0, cfg); // closed admission, generation G
      await open(store, pid, 0); // opens under a newer generation
      // The old closed-generation completion must NOT reopen/alter the current state.
      const res = await store.complete(pid, a.generation, 'trip', 0, cfg);
      expect(res.justOpened).toBe(false);
    }
  });

  it('real-time: opens, admits exactly one probe after the cooldown, and closes on its success', async () => {
    const red = new RedisBreakerStore(redis, prefix);
    const pid = 'lifecycle';
    await open(red, pid, 0);
    expect((await red.decide(pid, 0, cfg)).decision).toBe('skip'); // within cooldown

    await sleep(cfg.cooldownMs + 120); // cross the cooldown (server clock)
    const admissions = await Promise.all(Array.from({ length: 8 }, () => red.decide(pid, 0, cfg)));
    const probes = admissions.filter((a) => a.decision === 'allow');
    expect(probes).toHaveLength(1); // single half-open probe
    const probe = probes[0]!;
    expect(probe.isProbe).toBe(true);

    await red.complete(pid, probe.generation, 'success', 0, cfg); // closes
    const after = await red.decide(pid, 0, cfg);
    expect(after).toMatchObject({ decision: 'allow', isProbe: false }); // closed
  });

  it('server-clock authority: a caller passing a far-future `now` cannot defeat the cooldown', async () => {
    const red = new RedisBreakerStore(redis, prefix);
    const pid = 'authority';
    await open(red, pid, 0);
    // A skewed instance passes a `now` 10^13 ms in the future — server time still
    // governs, so the provider stays open (cooldown not elapsed on the server).
    const skewed = await red.decide(pid, 10 ** 13, cfg);
    expect(skewed.decision).toBe('skip');
    // And a caller passing `now = 0` (far past) sees the same server-driven decision.
    const past = await red.decide(pid, 0, cfg);
    expect(past.decision).toBe('skip');
  });

  it('renewal (real-time): renewing keeps a probe alive past the base lease; a stale-gen renew is a no-op', async () => {
    const red = new RedisBreakerStore(redis, prefix);
    const pid = 'renew';
    await open(red, pid, 0);
    await sleep(cfg.cooldownMs + 120);

    const probe = await red.decide(pid, 0, cfg); // admit probe, base lease ~ probeLeaseMs
    expect(probe.isProbe).toBe(true);

    // A stale-generation renew must not extend anything.
    await red.renew(pid, probe.generation - 1, 0, cfg);

    // Renew the live probe within the lease, twice, spanning past the BASE lease.
    await sleep(cfg.probeLeaseMs - 80);
    await red.renew(pid, probe.generation, 0, cfg);
    await sleep(cfg.probeLeaseMs - 80); // total elapsed now exceeds the base lease
    // Still a single live probe (renewal moved the lease forward): concurrent decide skips.
    expect((await red.decide(pid, 0, cfg)).decision).toBe('skip');

    await red.renew(pid, probe.generation, 0, cfg);
    await red.complete(pid, probe.generation, 'success', 0, cfg); // still the current generation → closes
    expect((await red.decide(pid, 0, cfg))).toMatchObject({ decision: 'allow', isProbe: false });
  });
});
