import Redis from 'ioredis';
import {
  DEFAULT_PLAN_COOLDOWN_CONFIG,
  InMemoryPlanCooldownStore,
  RedisPlanCooldownStore,
} from './plan-cooldown';
import type { PlanCooldownConfig } from './plan-cooldown';

const REDIS_URL = process.env['REDIS_URL'];

// Gated on REDIS_URL locally, but in CI it MUST run (ci-pipeline spec: env-gated suites fail
// loudly when their infrastructure is missing, never silently skip).
if (REDIS_URL === undefined && process.env['CI'] !== undefined) {
  throw new Error(
    '[plan-cooldown-redis] CI is set but REDIS_URL is missing — the real-Redis parity suite is ' +
      'required in CI. Provision a redis service and export REDIS_URL ' +
      '(e.g. redis://127.0.0.1:6379); see .github/workflows/ci.yml.',
  );
}
const suite = REDIS_URL !== undefined ? describe : describe.skip;
if (REDIS_URL === undefined) {
  console.warn('[plan-cooldown-redis] REDIS_URL not set — skipping the real-Redis suite');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const HOUR = 3_600_000;

suite('RedisPlanCooldownStore against real Redis', () => {
  let redis: Redis;
  const prefix = `test:pcd:${String(Date.now())}:`;
  const mk = (cfg: PlanCooldownConfig = DEFAULT_PLAN_COOLDOWN_CONFIG): RedisPlanCooldownStore =>
    new RedisPlanCooldownStore(redis, prefix, cfg);

  beforeAll(() => {
    redis = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1, lazyConnect: false });
  });
  afterAll(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it('parity with InMemory: stated reset, defaults, both clamps, extend-only, kind replacement', async () => {
    const red = mk();
    const serverNow = Number((await redis.time())[0]) * 1000;
    const mem = new InMemoryPlanCooldownStore(() => serverNow);
    const slack = 2_000; // the two clocks are read a few ms apart

    const cases = [
      { kind: 'quota_exhausted', abs: serverNow + 2 * HOUR },
      { kind: 'quota_exhausted', abs: serverNow - HOUR }, // past -> 1 minute
      { kind: 'quota_exhausted', abs: serverNow + 90 * 24 * HOUR }, // distant -> 7 days
      { kind: 'risk_control', rel: 120_000 },
      { kind: 'risk_control', rel: 0 },
      { kind: 'risk_control', rel: 90 * 24 * HOUR },
      { kind: 'plan_inactive', default: 60 * 60_000 },
      { kind: 'quota_exhausted', default: 15 * 60_000 },
    ] as const;
    for (const [i, input] of cases.entries()) {
      const id = `parity-${String(i)}`;
      const r = await red.record(id, input);
      const m = await mem.record(id, input);
      expect(r.kind).toBe(m.kind);
      expect(r.source).toBe(m.source);
      expect(Math.abs(r.until - m.until)).toBeLessThan(slack);
      expect(await red.check(id)).toEqual(r);
    }

    // extend-only + the kind replaced only by a later end
    const id = 'parity-extend';
    const first = await red.record(id, { kind: 'plan_inactive', rel: 2 * HOUR });
    const shorter = await red.record(id, { kind: 'quota_exhausted', rel: HOUR });
    expect(shorter).toEqual(first);
    const later = await red.record(id, { kind: 'risk_control', rel: 3 * HOUR });
    expect(later.kind).toBe('risk_control');
    expect(later.until).toBeGreaterThan(first.until);
  });

  it('divergent caller clocks give identical ends, for an abs input and for a rel input', async () => {
    const red = mk();
    const abs = Date.now() + 2 * HOUR;
    // The store has no caller-clock parameter at all: simulate two skewed instances by running
    // the same input while the process clock is shifted a day apart in each direction.
    const realNow = Date.now;
    const ends: number[] = [];
    const relEnds: number[] = [];
    try {
      for (const skew of [-24 * HOUR, 0, 24 * HOUR]) {
        Date.now = () => realNow() + skew;
        const a = await mk().record(`skew-abs-${String(skew)}`, { kind: 'quota_exhausted', abs });
        const r = await mk().record(`skew-rel-${String(skew)}`, {
          kind: 'quota_exhausted',
          rel: 120_000,
        });
        ends.push(a.until);
        relEnds.push(r.until);
      }
    } finally {
      Date.now = realNow;
    }
    expect(new Set(ends).size).toBe(1);
    expect(ends[0]).toBe(abs);
    const spread = Math.max(...relEnds) - Math.min(...relEnds);
    expect(spread).toBeLessThan(2_000); // only the real few ms between the three calls
    expect(red).toBeDefined();
  });

  it('checkMany returns each id record or null in one round trip', async () => {
    const red = mk();
    await red.record('many-a', { kind: 'quota_exhausted', rel: HOUR });
    await red.record('many-b', { kind: 'plan_inactive', rel: HOUR });
    const evalSpy = jest.spyOn(redis, 'eval');
    try {
      const m = await red.checkMany(['many-a', 'many-none', 'many-b']);
      expect(evalSpy).toHaveBeenCalledTimes(1);
      expect(m.get('many-a')?.kind).toBe('quota_exhausted');
      expect(m.get('many-b')?.kind).toBe('plan_inactive');
      expect(m.get('many-none')).toBeNull();
      expect(m.size).toBe(3);
    } finally {
      evalSpy.mockRestore();
    }
    expect((await red.checkMany([])).size).toBe(0);
  });

  it('a real PXAT expiry with small configured windows ends the pause with no write', async () => {
    const cfg: PlanCooldownConfig = { ...DEFAULT_PLAN_COOLDOWN_CONFIG, minMs: 400, maxMs: 5_000 };
    const red = mk(cfg);
    const rec = await red.record('expiry', { kind: 'quota_exhausted', rel: 0 }); // clamps to 400ms
    expect(rec.source).toBe('provider');
    expect(await red.check('expiry')).not.toBeNull();
    const ttl = await redis.pttl(`${prefix}expiry`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(400);
    await sleep(700);
    expect(await red.check('expiry')).toBeNull();
    expect(await redis.exists(`${prefix}expiry`)).toBe(0);
  });

  it('two concurrent records keep the later end', async () => {
    const red = mk();
    const [a, b] = await Promise.all([
      red.record('race', { kind: 'quota_exhausted', rel: 2 * HOUR }),
      red.record('race', { kind: 'risk_control', rel: 5 * HOUR }),
    ]);
    const final = await red.check('race');
    expect(final?.kind).toBe('risk_control');
    expect(final?.until).toBe(Math.max(a.until, b.until));
    expect(final?.until).toBe(b.until);
  });

  it('the stored value holds only { kind, until, source } and the key carries a PXAT ttl', async () => {
    const red = mk();
    await red.record('shape', { kind: 'plan_inactive', rel: HOUR });
    const raw = await redis.get(`${prefix}shape`);
    const parsed = JSON.parse(raw as string) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['kind', 'source', 'until']);
    expect(await redis.pttl(`${prefix}shape`)).toBeGreaterThan(0);
  });

  it('lift deletes the key and is idempotent', async () => {
    const red = mk();
    await red.record('lift', { kind: 'quota_exhausted', rel: HOUR });
    await red.lift('lift');
    await red.lift('lift');
    expect(await red.check('lift')).toBeNull();
  });

  it('a corrupt stored value reads as no pause and is overwritten by the next record', async () => {
    const red = mk();
    await redis.set(`${prefix}corrupt`, 'not json', 'PX', 5_000);
    expect(await red.check('corrupt')).toBeNull();
    const rec = await red.record('corrupt', { kind: 'quota_exhausted', rel: HOUR });
    expect(rec.kind).toBe('quota_exhausted');
  });
});
