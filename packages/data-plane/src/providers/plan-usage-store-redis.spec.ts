// add-subscription-quota-display (task 4.1) — pins the Lua scripts to the pure merge. Every
// scenario runs on `RedisPlanUsageStore` (real Redis, the Lua) and on `InMemoryPlanUsageStore`
// (the pure `mergeSnapshot`) and the normalized results must agree.
import Redis from 'ioredis';
import {
  InMemoryPlanUsageStore,
  RedisPlanUsageStore,
  type PlanUsageSnapshot,
  type PlanUsageSource,
} from './plan-usage-store';
import type { PlanUsageObservation, PlanUsageWindow } from './plan-usage';

const REDIS_URL = process.env['REDIS_URL'];

// Gated on REDIS_URL locally, but in CI it MUST run (ci-pipeline spec: env-gated suites fail
// loudly when their infrastructure is missing, never silently skip).
if (REDIS_URL === undefined && process.env['CI'] !== undefined) {
  throw new Error(
    '[plan-usage-store-redis] CI is set but REDIS_URL is missing — the real-Redis parity suite is ' +
      'required in CI. Provision a redis service and export REDIS_URL ' +
      '(e.g. redis://127.0.0.1:6379); see .github/workflows/ci.yml.',
  );
}
const suite = REDIS_URL !== undefined ? describe : describe.skip;
if (REDIS_URL === undefined) {
  console.warn('[plan-usage-store-redis] REDIS_URL not set — skipping the real-Redis suite');
}

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SLACK = 3_000; // the two clocks are read a few ms apart

suite('RedisPlanUsageStore against real Redis', () => {
  let redis: Redis;
  let red: RedisPlanUsageStore;
  let serverNow: number;
  const used = new Set<string>();
  const run = String(Date.now());
  let n = 0;
  const newId = (): string => {
    n += 1;
    const id = `parity-${run}-${String(n)}`;
    used.add(id);
    return id;
  };

  beforeAll(async () => {
    redis = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    red = new RedisPlanUsageStore(redis);
    serverNow = Number((await redis.time())[0]) * 1000;
  });
  afterAll(async () => {
    const keys = [...used].flatMap((id) => [`pu:${id}`, `pur:${id}`, `pug:${id}`]);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  const win = (over: Partial<PlanUsageWindow> = {}): PlanUsageWindow => ({
    key: 'account:5h',
    group: 'account',
    span: '5h',
    minutes: 300,
    scope: null,
    usedPercent: 40,
    reset: { atMs: serverNow + 2 * HOUR },
    ...over,
  });
  const weekly = (over: Partial<PlanUsageWindow> = {}): PlanUsageWindow =>
    win({
      key: 'account:weekly',
      span: 'weekly',
      minutes: 10_080,
      reset: { atMs: serverNow + 3 * DAY },
      ...over,
    });
  const obs = (
    windows: PlanUsageWindow[],
    billing: PlanUsageObservation['billing'] = null,
  ): PlanUsageObservation => ({ windows, billing });

  /** Both stores, one clock reading, one id. */
  function pair(): {
    id: string;
    mem: InMemoryPlanUsageStore;
    step: (
      o: PlanUsageObservation,
      source?: PlanUsageSource,
      gen?: number,
    ) => Promise<{ redis: PlanUsageSnapshot | null; mem: PlanUsageSnapshot | null }>;
  } {
    const id = newId();
    const mem = new InMemoryPlanUsageStore(() => serverNow);
    return {
      id,
      mem,
      step: async (o, source = 'traffic', gen = 0) => {
        await red.merge(id, o, gen, source);
        await mem.merge(id, o, gen, source);
        return {
          redis: (await red.readMany([id])).get(id)!.snapshot,
          mem: (await mem.readMany([id])).get(id)!.snapshot,
        };
      },
    };
  }

  /** Windows without their observation times, plus the billing state, for equality. */
  const norm = (s: PlanUsageSnapshot | null): unknown =>
    s === null
      ? null
      : {
          windows: s.windows.map(({ observedAt: _o, ...rest }) => rest),
          billing: s.billing === null ? null : s.billing.state,
        };
  const expectParity = (r: {
    redis: PlanUsageSnapshot | null;
    mem: PlanUsageSnapshot | null;
  }): void => {
    expect(norm(r.redis)).toEqual(norm(r.mem));
  };

  it('parity: later reset, same reset (max percent), earlier reset (dropped), +-60 s edges', async () => {
    const p = pair();
    expectParity(await p.step(obs([win({ usedPercent: 98 })])));
    expectParity(
      await p.step(obs([win({ usedPercent: 3, reset: { atMs: serverNow + 2 * HOUR + 30_000 } })])),
    );
    expectParity(
      await p.step(obs([win({ usedPercent: 99, reset: { atMs: serverNow + 2 * HOUR - 45_000 } })])),
    );
    expectParity(
      await p.step(
        obs([win({ usedPercent: 99, reset: { atMs: serverNow + 2 * HOUR - 2 * MIN } })]),
      ),
    );
    expectParity(
      await p.step(obs([win({ usedPercent: 5, reset: { atMs: serverNow + 2 * HOUR + 2 * MIN } })])),
    );
    const last = await p.step(
      obs([win({ usedPercent: 1, reset: { atMs: serverNow + 3 * HOUR } })]),
    );
    expectParity(last);
    expect(last.redis!.windows[0]!.usedPercent).toBe(1);
  });

  it('parity: null resets', async () => {
    const p = pair();
    expectParity(await p.step(obs([win({ usedPercent: 50 })])));
    expectParity(await p.step(obs([win({ usedPercent: 90, reset: null })]))); // dropped
    const a = await p.step(
      obs([
        win({ usedPercent: 5, key: 'account:daily', span: 'daily', minutes: 1440, reset: null }),
      ]),
    );
    expectParity(a);
    expectParity(
      await p.step(
        obs([
          win({ usedPercent: 20, key: 'account:daily', span: 'daily', minutes: 1440, reset: null }),
        ]),
      ),
    ); // undated replaces undated
    expectParity(
      await p.step(
        obs([
          win({
            usedPercent: 7,
            key: 'account:daily',
            span: 'daily',
            minutes: 1440,
            reset: { atMs: serverNow + 5 * HOUR },
          }),
        ]),
      ),
    ); // dated replaces undated
  });

  it('parity: refresh replaces wholesale and never changes billing', async () => {
    const p = pair();
    expectParity(await p.step(obs([win({ usedPercent: 35 }), weekly()], 'extra_usage')));
    const r = await p.step(obs([win({ usedPercent: 20 })], 'plan'), 'refresh');
    expectParity(r);
    expect(r.redis!.windows.map((w) => w.key)).toEqual(['account:5h']);
    expect(r.redis!.windows[0]!.source).toBe('refresh');
    expect(r.redis!.billing!.state).toBe('extra_usage');
  });

  it('parity: billing is taken only from a current observation; null keeps the state', async () => {
    const p = pair();
    expectParity(
      await p.step(obs([win({ usedPercent: 3, reset: { atMs: serverNow + 5 * HOUR } })], 'plan')),
    );
    const stale = await p.step(
      obs(
        [win({ usedPercent: 99, reset: { atMs: serverNow + 4 * HOUR + 30 * MIN } })],
        'extra_usage',
      ),
    );
    expectParity(stale);
    expect(stale.redis!.billing!.state).toBe('plan');
    expectParity(await p.step(obs([], 'extra_usage'))); // window-less: last writer wins
    const kept = await p.step(
      obs([win({ usedPercent: 4, reset: { atMs: serverNow + 5 * HOUR } })], null),
    );
    expectParity(kept);
    expect(kept.redis!.billing!.state).toBe('extra_usage');
  });

  it('parity: an observation with one earlier-reset window never carries billing, even beside a same-reset window', async () => {
    const p = pair();
    expectParity(
      await p.step(
        obs([win({ usedPercent: 3, reset: { atMs: serverNow + 5 * HOUR } }), weekly()], 'plan'),
      ),
    );
    const stale = await p.step(
      obs(
        [
          win({ usedPercent: 99, reset: { atMs: serverNow + 4 * HOUR + 30 * MIN } }),
          weekly({ usedPercent: 55 }),
        ],
        'extra_usage',
      ),
    );
    expectParity(stale);
    expect(stale.redis!.billing!.state).toBe('plan');
    // Positive: every window shares its stored reset, so the observation is current.
    const current = await p.step(
      obs(
        [
          win({ usedPercent: 4, reset: { atMs: serverNow + 5 * HOUR } }),
          weekly({ usedPercent: 56 }),
        ],
        'extra_usage',
      ),
    );
    expectParity(current);
    expect(current.redis!.billing!.state).toBe('extra_usage');
  });

  it('parity: per-figure observation times', async () => {
    const p = pair();
    await p.step(obs([win(), weekly()]));
    await new Promise((r) => setTimeout(r, 40));
    const r = await p.step(obs([win({ usedPercent: 60 })], 'plan'));
    const five = r.redis!.windows.find((w) => w.key === 'account:5h')!;
    const week = r.redis!.windows.find((w) => w.key === 'account:weekly')!;
    expect(five.observedAt).toBeGreaterThan(week.observedAt);
    expect(r.redis!.billing!.observedAt).toBeGreaterThanOrEqual(week.observedAt);
    // a billing-only write stamps only the billing state
    await new Promise((r2) => setTimeout(r2, 40));
    const b = await p.step(obs([], 'extra_usage'));
    expect(b.redis!.windows.find((w) => w.key === 'account:weekly')!.observedAt).toBe(
      week.observedAt,
    );
    expect(b.redis!.billing!.observedAt).toBeGreaterThan(week.observedAt);
  });

  it('parity: at most 8 model buckets and 12 windows, the latest resets first', async () => {
    const p = pair();
    const bucket = (i: number): PlanUsageWindow =>
      win({
        key: `model:b${String(i).padStart(2, '0')}`,
        group: 'model',
        scope: `b${String(i)}`,
        reset: { atMs: serverNow + (i + 1) * 10 * MIN },
      });
    const buckets = Array.from({ length: 10 }, (_, i) => bucket(i));
    expectParity(await p.step(obs(buckets.slice(0, 6))));
    const r = await p.step(obs(buckets.slice(6)));
    expectParity(r);
    expect(r.redis!.windows.map((w) => w.key)).toEqual(
      ['b02', 'b03', 'b04', 'b05', 'b06', 'b07', 'b08', 'b09'].map((k) => `model:${k}`),
    );
    const q = pair();
    const acct = (i: number, reset: PlanUsageWindow['reset']): PlanUsageWindow =>
      win({ key: `account:k${String(i).padStart(2, '0')}`, span: null, minutes: null, reset });
    expectParity(
      await q.step(
        obs(
          Array.from({ length: 12 }, (_, i) => acct(i, { atMs: serverNow + (i + 1) * 20 * MIN })),
        ),
      ),
    );
    const cut = await q.step(obs([acct(20, { atMs: serverNow + 6 * HOUR }), acct(21, null)]));
    expectParity(cut);
    expect(cut.redis!.windows).toHaveLength(12);
  });

  it('rejects more than 12 windows before any script runs', async () => {
    const id = newId();
    const many = Array.from({ length: 13 }, (_, i) => win({ key: `account:k${String(i)}` }));
    await expect(red.merge(id, obs(many), 0, 'traffic')).rejects.toThrow(RangeError);
    expect((await red.readMany([id])).get(id)!.snapshot).toBeNull();
  });

  it('an { inMs } reset is anchored on the Redis clock; the bound is re-applied there', async () => {
    const id = newId();
    await red.merge(id, obs([win({ reset: { inMs: 600_000 } })]), 0, 'traffic');
    const w = (await red.readMany([id])).get(id)!.snapshot!.windows[0]!;
    expect(Math.abs(w.resetMs! - (serverNow + 600_000))).toBeLessThan(SLACK + 5_000);
    const id2 = newId();
    await red.merge(id2, obs([win({ reset: { inMs: 6 * HOUR } })]), 0, 'traffic');
    expect((await red.readMany([id2])).get(id2)!.snapshot!.windows[0]!.resetMs).toBeNull();
    const id3 = newId();
    await red.merge(id3, obs([win({ reset: { atMs: serverNow + 900 * DAY } })]), 0, 'traffic');
    expect((await red.readMany([id3])).get(id3)!.snapshot!.windows[0]!.resetMs).toBeNull();
  });

  it('expiry: reset + 1 h, clamped to 1 h .. 32 d, 24 h with no dated reset', async () => {
    const cases: [string, PlanUsageWindow, number][] = [
      ['three hours', win({ reset: { atMs: serverNow + 3 * HOUR } }), 4 * HOUR],
      ['just passed', win({ reset: { atMs: serverNow - 5 * MIN } }), HOUR],
      [
        'very far',
        win({ span: null, minutes: null, reset: { atMs: serverNow + 300 * DAY } }),
        32 * DAY,
      ],
      ['undated', win({ reset: null }), 24 * HOUR],
    ];
    for (const [name, w, ttl] of cases) {
      const id = newId();
      await red.merge(id, obs([w]), 0, 'traffic');
      const pttl = await redis.pttl(`pu:${id}`);
      expect({ name, ok: Math.abs(pttl - ttl) < SLACK + 5_000 }).toEqual({ name, ok: true });
    }
  });

  it('generation: a lower write is dropped, clear raises it and keeps the cooldown', async () => {
    const id = newId();
    expect(await red.clear(id)).toBe(1);
    expect(await red.merge(id, obs([win()]), 0, 'traffic')).toEqual({ applied: false, gen: 1 });
    expect((await red.readMany([id])).get(id)!.snapshot).toBeNull();
    expect(await red.merge(id, obs([win()]), 1, 'traffic')).toEqual({ applied: true, gen: 1 });
    expect((await red.readMany([id])).get(id)!.snapshot).not.toBeNull();
    // a higher generation raises the store to it
    expect(await red.merge(id, obs([win()]), 4, 'traffic')).toEqual({ applied: true, gen: 4 });
    expect((await red.merge(id, obs([win()]), 3, 'traffic')).applied).toBe(false);
    // the generation key outlives the snapshot (40 d TTL)
    expect(Math.abs((await redis.pttl(`pug:${id}`)) - 40 * DAY)).toBeLessThan(SLACK + 5_000);
    // clear keeps pur:
    const claim = await red.claimRefresh(id);
    expect(claim.claimed).toBe(true);
    expect(await red.clear(id)).toBe(5);
    expect((await red.readMany([id])).get(id)!.snapshot).toBeNull();
    const again = await red.claimRefresh(id);
    expect(again.claimed).toBe(false);
    expect(again.gen).toBe(5);
  });

  it('refresh cooldown: claim is NX with a 5-minute end; extend never shortens and clamps', async () => {
    const id = newId();
    const first = await red.claimRefresh(id);
    expect(first.claimed).toBe(true);
    expect(Math.abs(first.availableAt - (serverNow + 5 * MIN))).toBeLessThan(SLACK + 5_000);
    expect(first.retryAfterMs).toBe(5 * MIN);
    const second = await red.claimRefresh(id);
    expect(second.claimed).toBe(false);
    // The remainder is measured on the Redis clock, so it is the cooldown less a moment.
    expect(second.retryAfterMs).toBeGreaterThan(5 * MIN - 5_000);
    expect(second.retryAfterMs).toBeLessThanOrEqual(5 * MIN);
    expect(Math.abs(second.availableAt - first.availableAt)).toBeLessThan(SLACK);
    const ttl = async (): Promise<number> => redis.pttl(`pur:${id}`);
    await red.extendRefresh(id, 1_000);
    expect(Math.abs((await ttl()) - 5 * MIN)).toBeLessThan(SLACK);
    await red.extendRefresh(id, 15 * MIN);
    expect(Math.abs((await ttl()) - 15 * MIN)).toBeLessThan(SLACK);
    await red.extendRefresh(id, 2 * HOUR);
    expect(Math.abs((await ttl()) - HOUR)).toBeLessThan(SLACK);
    await red.extendRefresh(id, 10 * MIN);
    expect(Math.abs((await ttl()) - HOUR)).toBeLessThan(SLACK);
    // extend creates a missing cooldown too
    const fresh = newId();
    await red.extendRefresh(fresh, 20 * MIN);
    expect(Math.abs((await redis.pttl(`pur:${fresh}`)) - 20 * MIN)).toBeLessThan(SLACK);
    await expect(red.extendRefresh(id, Number.NaN)).rejects.toThrow(RangeError);
  });

  it('readMany: one chunked read across many ids, the cooldown only for the rows asked about', async () => {
    const ids = Array.from({ length: 300 }, () => newId());
    await red.merge(ids[0]!, obs([win()]), 0, 'traffic');
    await red.merge(ids[299]!, obs([weekly()], 'plan'), 0, 'traffic');
    await red.claimRefresh(ids[299]!);
    await red.claimRefresh(ids[1]!);
    const got = await red.readMany(ids, [ids[299]!, ids[5]!]);
    expect(got.size).toBe(300);
    expect(got.get(ids[0]!)!.snapshot!.windows[0]!.key).toBe('account:5h');
    expect(got.get(ids[299]!)!.snapshot!.billing!.state).toBe('plan');
    expect(got.get(ids[1]!)!.snapshot).toBeNull();
    const end = got.get(ids[299]!)!.cooldownEndsAt!;
    expect(Math.abs(end - (serverNow + 5 * MIN))).toBeLessThan(SLACK + 5_000);
    expect(got.get(ids[1]!)!.cooldownEndsAt).toBeNull(); // claimed, but not asked about
    expect(got.get(ids[5]!)!.cooldownEndsAt).toBeNull(); // asked about, no cooldown
  });

  it('a corrupt stored record reads as none and is replaced by the next merge', async () => {
    const id = newId();
    await redis.set(`pu:${id}`, '{not json');
    expect((await red.readMany([id])).get(id)!.snapshot).toBeNull();
    await red.merge(id, obs([win()]), 0, 'traffic');
    expect((await red.readMany([id])).get(id)!.snapshot!.windows).toHaveLength(1);
  });

  it('a billing-only record round-trips (an empty windows table encodes as an object)', async () => {
    const id = newId();
    await red.merge(id, obs([], 'extra_usage'), 0, 'traffic');
    const s = (await red.readMany([id])).get(id)!.snapshot!;
    expect(s.windows).toEqual([]);
    expect(s.billing!.state).toBe('extra_usage');
  });

  it('a malformed number drops alone and a percent is clamped', async () => {
    const id = newId();
    await red.merge(
      id,
      obs([win({ usedPercent: 250 }), weekly({ usedPercent: Number.NaN })]),
      0,
      'traffic',
    );
    const s = (await red.readMany([id])).get(id)!.snapshot!;
    expect(s.windows.find((w) => w.key === 'account:5h')!.usedPercent).toBe(100);
    expect(s.windows.find((w) => w.key === 'account:weekly')!.usedPercent).toBeNull();
  });
});
