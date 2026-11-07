// add-subscription-quota-display (tasks 4.1-4.2) — the plan-usage store (in-memory, which mirrors
// the Lua; the real-Redis parity suite is plan-usage-store-redis.spec.ts), the failover composite
// and the coalescing recorder.
import {
  FailoverPlanUsageStore,
  InMemoryPlanUsageStore,
  PLAN_USAGE_LIMITS,
  PlanUsageRecorder,
  mergeSnapshot,
  sanitizeObservation,
  type PlanUsageMergeResult,
  type PlanUsageRead,
  type PlanUsageRefreshClaim,
  type PlanUsageSnapshot,
  type PlanUsageSource,
  type PlanUsageStore,
} from './plan-usage-store';
import type { PlanUsageObservation, PlanUsageWindow } from './plan-usage';

const T0 = Date.UTC(2026, 10, 6, 12, 0, 0);
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ID = 'prov-1';

function clock(start = T0): {
  now: () => number;
  set: (t: number) => void;
  advance: (ms: number) => void;
} {
  let t = start;
  return { now: () => t, set: (v) => (t = v), advance: (ms) => (t += ms) };
}

const win = (over: Partial<PlanUsageWindow> = {}): PlanUsageWindow => ({
  key: 'account:5h',
  group: 'account',
  span: '5h',
  minutes: 300,
  scope: null,
  usedPercent: 40,
  reset: { atMs: T0 + 2 * HOUR },
  ...over,
});
const obs = (
  windows: PlanUsageWindow[],
  billing: PlanUsageObservation['billing'] = null,
): PlanUsageObservation => ({ windows, billing });

async function snap(store: PlanUsageStore, id = ID): Promise<PlanUsageSnapshot | null> {
  return (await store.readMany([id])).get(id)?.snapshot ?? null;
}
const pct = (s: PlanUsageSnapshot | null, key: string): number | null | undefined =>
  s?.windows.find((w) => w.key === key)?.usedPercent;
const at = (s: PlanUsageSnapshot | null, key: string) => s?.windows.find((w) => w.key === key);

describe('InMemoryPlanUsageStore: the merge rules (design D5)', () => {
  let c: ReturnType<typeof clock>;
  let store: InMemoryPlanUsageStore;
  beforeEach(() => {
    c = clock();
    store = new InMemoryPlanUsageStore(c.now);
  });
  const merge = (o: PlanUsageObservation, source: PlanUsageSource = 'traffic', gen = 0) =>
    store.merge(ID, o, gen, source);

  it('out-of-order merges converge on the higher percent within one reset', async () => {
    await merge(obs([win({ usedPercent: 42 })]));
    await merge(obs([win({ usedPercent: 40 })]));
    expect(pct(await snap(store), 'account:5h')).toBe(42);
    // and the same in the other order
    const other = new InMemoryPlanUsageStore(c.now);
    await other.merge(ID, obs([win({ usedPercent: 40 })]), 0, 'traffic');
    await other.merge(ID, obs([win({ usedPercent: 42 })]), 0, 'traffic');
    expect(pct(await snap(other), 'account:5h')).toBe(42);
  });

  it('resets within 60 s count as the same reset; a later reset (> 60 s) replaces', async () => {
    await merge(obs([win({ usedPercent: 98 })]));
    // +30 s: the same reset -> max percent
    await merge(obs([win({ usedPercent: 3, reset: { atMs: T0 + 2 * HOUR + 30_000 } })]));
    expect(pct(await snap(store), 'account:5h')).toBe(98);
    // +61 s... later than the stored reset by more than 60 s -> replaced
    await merge(obs([win({ usedPercent: 3, reset: { atMs: T0 + 2 * HOUR + 61_000 } })]));
    const s = await snap(store);
    expect(pct(s, 'account:5h')).toBe(3);
    expect(at(s, 'account:5h')!.resetMs).toBe(T0 + 2 * HOUR + 61_000);
  });

  it('a later reset replaces (the spec example: 98% passed, 3% with a later reset)', async () => {
    await merge(obs([win({ usedPercent: 98, reset: { atMs: T0 + 10 * MIN } })]));
    c.advance(20 * MIN); // the stored reset has passed
    await merge(obs([win({ usedPercent: 3, reset: { atMs: c.now() + 4 * HOUR } })]));
    const s = await snap(store);
    expect(pct(s, 'account:5h')).toBe(3);
    expect(at(s, 'account:5h')!.resetMs).toBe(c.now() + 4 * HOUR);
  });

  it('a passed reset is replaced by anything, even an undated or lower-percent input', async () => {
    await merge(obs([win({ usedPercent: 98, reset: { atMs: T0 + 10 * MIN } })]));
    c.advance(20 * MIN);
    await merge(obs([win({ usedPercent: 1, reset: null })]));
    expect(pct(await snap(store), 'account:5h')).toBe(1);
    expect(at(await snap(store), 'account:5h')!.resetMs).toBeNull();
  });

  it('an earlier reset is a stale observation and is dropped', async () => {
    await merge(obs([win({ usedPercent: 50 })]));
    await merge(obs([win({ usedPercent: 99, reset: { atMs: T0 + 2 * HOUR - 2 * MIN } })]));
    const s = await snap(store);
    expect(pct(s, 'account:5h')).toBe(50);
    expect(at(s, 'account:5h')!.resetMs).toBe(T0 + 2 * HOUR);
  });

  describe('null resets (design D5 step 4)', () => {
    it('an undated input never displaces a dated, unexpired window', async () => {
      await merge(obs([win({ usedPercent: 50 })]));
      await merge(obs([win({ usedPercent: 90, reset: null })]));
      const w = at(await snap(store), 'account:5h')!;
      expect(w.usedPercent).toBe(50);
      expect(w.resetMs).toBe(T0 + 2 * HOUR);
    });
    it('it replaces an undated window, and an expired one', async () => {
      await merge(obs([win({ usedPercent: 10, reset: null })]));
      await merge(obs([win({ usedPercent: 20, reset: null })]));
      expect(pct(await snap(store), 'account:5h')).toBe(20); // undated replaces undated (not max)
      await merge(obs([win({ usedPercent: 5, reset: null })]));
      expect(pct(await snap(store), 'account:5h')).toBe(5);
    });
    it('a dated input replaces an undated window', async () => {
      await merge(obs([win({ usedPercent: 80, reset: null })]));
      await merge(obs([win({ usedPercent: 12 })]));
      const w = at(await snap(store), 'account:5h')!;
      expect(w.usedPercent).toBe(12);
      expect(w.resetMs).toBe(T0 + 2 * HOUR);
    });
  });

  it('a refresh replaces the windows wholesale and never changes billing', async () => {
    await merge(
      obs(
        [win({ usedPercent: 35 }), win({ key: 'account:weekly', span: 'weekly', minutes: 10080 })],
        'extra_usage',
      ),
    );
    await merge(obs([win({ usedPercent: 20 })], 'plan'), 'refresh');
    const s = await snap(store);
    expect(s!.windows.map((w) => w.key)).toEqual(['account:5h']);
    expect(pct(s, 'account:5h')).toBe(20); // lower than 35 with the same reset: still replaced
    expect(at(s, 'account:5h')!.source).toBe('refresh');
    expect(s!.billing!.state).toBe('extra_usage');
  });

  it('keeps a figure time per window and per billing state', async () => {
    await merge(
      obs([
        win({ usedPercent: 10 }),
        win({
          key: 'account:weekly',
          span: 'weekly',
          minutes: 10080,
          reset: { atMs: T0 + 3 * DAY },
        }),
      ]),
    );
    const first = c.now();
    c.advance(4 * HOUR - 30 * MIN);
    // a response that carries only the 5h window (a later reset)
    await merge(obs([win({ usedPercent: 11, reset: { atMs: c.now() + HOUR } })]));
    let s = await snap(store);
    expect(at(s, 'account:5h')!.observedAt).toBe(c.now());
    expect(at(s, 'account:weekly')!.observedAt).toBe(first); // not carried: keeps its older time
    // a billing-only write stamps only the billing state
    c.advance(HOUR);
    await merge(obs([], 'extra_usage'));
    s = await snap(store);
    expect(s!.billing).toEqual({ state: 'extra_usage', observedAt: c.now() });
    expect(at(s, 'account:weekly')!.observedAt).toBe(first);
  });

  describe('billing (design D5 step 6)', () => {
    it('a delayed pre-reset extra_usage whose windows are all earlier-reset leaves the post-reset plan', async () => {
      const R2 = T0 + 5 * HOUR;
      await merge(obs([win({ usedPercent: 3, reset: { atMs: R2 } })], 'plan'));
      await merge(obs([win({ usedPercent: 99, reset: { atMs: R2 - 30 * MIN } })], 'extra_usage'));
      expect((await snap(store))!.billing!.state).toBe('plan');
    });
    it('an observation with one earlier-reset window never carries billing, even when another window shares the stored reset', async () => {
      const R2 = T0 + 5 * HOUR;
      const W = T0 + 3 * DAY;
      const weekly = (usedPercent: number): PlanUsageWindow =>
        win({
          key: 'account:weekly',
          span: 'weekly',
          minutes: 10_080,
          usedPercent,
          reset: { atMs: W },
        });
      await merge(obs([win({ usedPercent: 3, reset: { atMs: R2 } }), weekly(50)], 'plan'));
      await merge(
        obs([win({ usedPercent: 99, reset: { atMs: R2 - 30 * MIN } }), weekly(55)], 'extra_usage'),
      );
      const s = await snap(store);
      expect(s!.billing!.state).toBe('plan');
      expect(pct(s, 'account:5h')).toBe(3);
      expect(pct(s, 'account:weekly')).toBe(55);
    });
    it('an observation whose windows all share the stored resets (none stale) takes its billing', async () => {
      const R2 = T0 + 5 * HOUR;
      const W = T0 + 3 * DAY;
      const both = (five: number): PlanUsageWindow[] => [
        win({ usedPercent: five, reset: { atMs: R2 } }),
        win({
          key: 'account:weekly',
          span: 'weekly',
          minutes: 10_080,
          usedPercent: 50,
          reset: { atMs: W },
        }),
      ];
      await merge(obs(both(3), 'plan'));
      await merge(obs(both(4), 'extra_usage'));
      expect((await snap(store))!.billing!.state).toBe('extra_usage');
    });
    it('a window-less observation takes its billing state (last writer wins)', async () => {
      await merge(obs([], 'plan'));
      await merge(obs([], 'extra_usage'));
      expect((await snap(store))!.billing!.state).toBe('extra_usage');
    });
    it('a null billing keeps the stored state', async () => {
      await merge(obs([win()], 'extra_usage'));
      await merge(obs([win({ usedPercent: 60 })], null));
      expect((await snap(store))!.billing!.state).toBe('extra_usage');
    });
  });

  describe('bounds', () => {
    const bucket = (n: number, resetOffset: number): PlanUsageWindow =>
      win({
        key: `model:b${String(n).padStart(2, '0')}`,
        group: 'model',
        scope: `b${String(n)}`,
        reset: { atMs: T0 + resetOffset },
      });

    it('keeps at most 8 model buckets, the latest resets first', async () => {
      const buckets = Array.from({ length: 10 }, (_, i) => bucket(i, (i + 1) * 10 * MIN));
      await merge(obs(buckets.slice(0, 6)));
      await merge(obs(buckets.slice(6)));
      const keys = (await snap(store))!.windows.map((w) => w.key);
      expect(keys).toHaveLength(8);
      expect(keys).toEqual([
        'model:b02',
        'model:b03',
        'model:b04',
        'model:b05',
        'model:b06',
        'model:b07',
        'model:b08',
        'model:b09',
      ]);
    });

    it('keeps at most 12 windows in all, the latest resets first (null counts as earliest)', async () => {
      const acct = (n: number, reset: PlanUsageWindow['reset']): PlanUsageWindow =>
        win({ key: `account:k${String(n).padStart(2, '0')}`, span: null, minutes: null, reset });
      await merge(
        obs(Array.from({ length: 12 }, (_, i) => acct(i, { atMs: T0 + (i + 1) * 20 * MIN }))),
      );
      await merge(obs([acct(20, { atMs: T0 + 6 * HOUR }), acct(21, null)]));
      const keys = (await snap(store))!.windows.map((w) => w.key);
      expect(keys).toHaveLength(12);
      expect(keys).toContain('account:k20'); // later than all the stored ones
      expect(keys).not.toContain('account:k21'); // null reset = earliest, cut
      expect(keys).not.toContain('account:k00'); // the earliest stored reset was cut
    });

    it('prunes a window whose reset passed more than 24 h ago, and deletes an emptied record', async () => {
      const weekly = (): PlanUsageWindow =>
        win({
          key: 'account:weekly',
          span: 'weekly',
          minutes: 10_080,
          reset: { atMs: T0 + 3 * DAY },
        });
      // The weekly window keeps the record alive (its TTL follows the latest reset).
      await merge(obs([win({ reset: { atMs: T0 + HOUR } }), weekly()]));
      c.advance(24 * HOUR); // the 5h window's reset passed 23 h ago: kept
      await merge(obs([weekly()]));
      expect((await snap(store))!.windows.map((w) => w.key)).toEqual([
        'account:5h',
        'account:weekly',
      ]);
      c.advance(2 * HOUR); // 25 h past: pruned
      await merge(obs([weekly()]));
      expect((await snap(store))!.windows.map((w) => w.key)).toEqual(['account:weekly']);

      // Emptied: one window past 24 h, no billing, then an empty observation deletes the record.
      const c2 = clock();
      const solo = new InMemoryPlanUsageStore(c2.now);
      await solo.merge('x', obs([win({ reset: { atMs: T0 + HOUR } })]), 0, 'traffic');
      await solo.merge(
        'x',
        obs([
          win({
            key: 'account:weekly',
            span: 'weekly',
            minutes: 10_080,
            reset: { atMs: T0 + 3 * DAY },
          }),
        ]),
        0,
        'traffic',
      );
      c2.advance(26 * HOUR);
      await solo.merge('x', obs([]), 0, 'traffic');
      expect((await snap(solo, 'x'))!.windows.map((w) => w.key)).toEqual(['account:weekly']);
      const gone = new InMemoryPlanUsageStore(c2.now);
      await gone.merge('y', obs([win({ reset: { atMs: c2.now() - 5 * MIN } })]), 0, 'traffic');
      c2.advance(25 * HOUR); // the record expired by TTL too; an empty write leaves nothing behind
      await gone.merge('y', obs([]), 0, 'traffic');
      expect(await snap(gone, 'y')).toBeNull();
      expect(gone.expiresAt('y')).toBeNull();
    });

    it('rejects more than 12 windows in one input', async () => {
      const many = Array.from({ length: 13 }, (_, i) => win({ key: `account:k${String(i)}` }));
      await expect(merge(obs(many))).rejects.toThrow(RangeError);
      expect(await snap(store)).toBeNull();
      expect(() => sanitizeObservation(obs(many))).toThrow(RangeError);
    });

    it('rejects a malformed key, group, billing or generation, and clamps a percent', async () => {
      await expect(merge(obs([win({ key: '' })]))).rejects.toThrow(RangeError);
      await expect(merge(obs([win({ group: 'x' as 'account' })]))).rejects.toThrow(RangeError);
      await expect(merge(obs([], 'bogus' as 'plan'))).rejects.toThrow(RangeError);
      await expect(store.merge(ID, obs([]), -1, 'traffic')).rejects.toThrow(RangeError);
      await merge(
        obs([win({ usedPercent: 250 }), win({ key: 'account:weekly', usedPercent: Number.NaN })]),
      );
      const s = await snap(store);
      expect(pct(s, 'account:5h')).toBe(100);
      expect(pct(s, 'account:weekly')).toBeNull();
    });
  });

  describe('relative resets', () => {
    it('an { inMs } reset is computed from the store clock', async () => {
      await merge(obs([win({ reset: { inMs: 600_000 } })]));
      expect(at(await snap(store), 'account:5h')!.resetMs).toBe(T0 + 600_000);
      c.advance(3 * HOUR);
    });
    it('the plausibility bound is re-applied against it', async () => {
      await merge(obs([win({ reset: { inMs: 6 * HOUR } })])); // a 5 h window cannot reset in 6 h
      expect(at(await snap(store), 'account:5h')!.resetMs).toBeNull();
      await merge(
        obs([win({ key: 'account:weekly', span: 'weekly', minutes: 10080, reset: { inMs: -5 } })]),
      );
      expect(at(await snap(store), 'account:weekly')!.resetMs).toBeNull();
    });
    it('an absolute reset beyond the bound is stored as unknown, never pinning the window', async () => {
      await merge(
        obs([
          win({ reset: { atMs: T0 + 900 * DAY } }),
          win({
            key: 'account:weekly',
            span: 'weekly',
            minutes: 10080,
            reset: { atMs: Math.round(T0 / 1000) },
          }),
        ]),
      );
      const s = await snap(store);
      expect(at(s, 'account:5h')!.resetMs).toBeNull();
      expect(at(s, 'account:weekly')!.resetMs).toBeNull();
    });
  });

  describe('TTL bounds (1 h <= TTL <= 32 d; 24 h with no dated reset)', () => {
    const ttl = (id = ID): number => store.expiresAt(id)! - c.now();
    it('is the latest reset plus 1 h', async () => {
      await merge(obs([win({ reset: { atMs: T0 + 3 * HOUR } })]));
      expect(ttl()).toBe(4 * HOUR);
    });
    it('is at least 1 h, even for a reset that just passed', async () => {
      await merge(obs([win({ reset: { atMs: T0 - 5 * MIN } })]));
      expect(ttl()).toBe(HOUR);
    });
    it('is at most 32 d', async () => {
      await merge(obs([win({ span: null, minutes: null, reset: { atMs: T0 + 300 * DAY } })]));
      expect(ttl()).toBe(32 * DAY);
    });
    it('is 24 h with no dated reset', async () => {
      await merge(obs([win({ reset: null })]));
      expect(ttl()).toBe(24 * HOUR);
    });
    it('expires: a record past its TTL reads as none', async () => {
      await merge(obs([win({ reset: { atMs: T0 + 3 * HOUR } })]));
      c.advance(4 * HOUR + 1);
      expect(await snap(store)).toBeNull();
    });
  });

  describe('generation (design D5)', () => {
    it('a merge with a lower generation writes nothing and returns the current one', async () => {
      await store.clear(ID); // generation 1
      const lower = await store.merge(ID, obs([win()]), 0, 'traffic');
      expect(lower).toEqual({ applied: false, gen: 1 });
      expect(await snap(store)).toBeNull();
      const ok = await store.merge(ID, obs([win()]), 1, 'traffic');
      expect(ok).toEqual({ applied: true, gen: 1 });
      expect(await snap(store)).not.toBeNull();
    });
    it('a higher generation raises the store to it', async () => {
      expect(await store.merge(ID, obs([win()]), 5, 'traffic')).toEqual({ applied: true, gen: 5 });
      expect((await store.merge(ID, obs([win()]), 3, 'traffic')).applied).toBe(false);
    });
    it('clear raises the generation, deletes the snapshot and keeps the refresh cooldown', async () => {
      await merge(obs([win()]));
      const claim = await store.claimRefresh(ID);
      expect(claim.claimed).toBe(true);
      expect(await store.clear(ID)).toBe(1);
      expect(await store.clear(ID)).toBe(2);
      expect(await snap(store)).toBeNull();
      const again = await store.claimRefresh(ID);
      expect(again.claimed).toBe(false); // re-sending a key never skips the cooldown
      expect(again.gen).toBe(2);
    });
  });

  describe('refresh cooldown', () => {
    it('claim is NX and returns the generation; the cooldown ends 5 minutes on', async () => {
      await store.clear(ID);
      const first = await store.claimRefresh(ID);
      expect(first).toEqual({
        claimed: true,
        availableAt: T0 + 5 * MIN,
        gen: 1,
        retryAfterMs: 5 * MIN,
      });
      c.advance(MIN);
      expect(await store.claimRefresh(ID)).toEqual({
        claimed: false,
        availableAt: T0 + 5 * MIN,
        gen: 1,
        retryAfterMs: 4 * MIN,
      });
      c.advance(4 * MIN);
      expect((await store.claimRefresh(ID)).claimed).toBe(true);
    });
    it('extend never shortens, and Retry-After clamps to 5 min .. 1 h', async () => {
      await store.claimRefresh(ID);
      await store.extendRefresh(ID, 1_000); // below the floor: stays at the existing 5 min
      expect((await store.claimRefresh(ID)).availableAt).toBe(T0 + 5 * MIN);
      await store.extendRefresh(ID, 15 * MIN);
      expect((await store.claimRefresh(ID)).availableAt).toBe(T0 + 15 * MIN);
      await store.extendRefresh(ID, 2 * HOUR); // above the ceiling: 1 h
      expect((await store.claimRefresh(ID)).availableAt).toBe(T0 + HOUR);
      await store.extendRefresh(ID, 10 * MIN); // shorter than what holds: unchanged
      expect((await store.claimRefresh(ID)).availableAt).toBe(T0 + HOUR);
      await expect(store.extendRefresh(ID, Number.NaN)).rejects.toThrow(RangeError);
    });
    it('readMany reports the cooldown end only for the rows asked about', async () => {
      await store.claimRefresh(ID);
      const both = (await store.readMany([ID], [ID])).get(ID)!;
      expect(both.cooldownEndsAt).toBe(T0 + 5 * MIN);
      expect((await store.readMany([ID])).get(ID)!.cooldownEndsAt).toBeNull();
      c.advance(6 * MIN);
      expect((await store.readMany([ID], [ID])).get(ID)!.cooldownEndsAt).toBeNull();
    });
  });

  it('mergeSnapshot is pure: it does not mutate its inputs', () => {
    const prev = mergeSnapshot(null, obs([win()], 'plan'), 'traffic', T0)!;
    const frozen = JSON.stringify(prev);
    mergeSnapshot(prev, obs([win({ usedPercent: 99 })], 'extra_usage'), 'traffic', T0 + MIN);
    expect(JSON.stringify(prev)).toBe(frozen);
  });
});

// ---------------------------------------------------------------------------------------------
// Failover
// ---------------------------------------------------------------------------------------------

/** A primary that fails on demand: wraps a real in-memory store. */
class FlakyStore implements PlanUsageStore {
  failing = false;
  constructor(readonly inner: PlanUsageStore) {}
  private guard<T>(fn: () => Promise<T>): Promise<T> {
    return this.failing ? Promise.reject(new Error('redis down')) : fn();
  }
  merge(
    id: string,
    o: PlanUsageObservation,
    gen: number,
    s: PlanUsageSource,
  ): Promise<PlanUsageMergeResult> {
    return this.guard(() => this.inner.merge(id, o, gen, s));
  }
  readMany(
    ids: readonly string[],
    cd?: readonly string[],
  ): Promise<ReadonlyMap<string, PlanUsageRead>> {
    return this.guard(() => this.inner.readMany(ids, cd));
  }
  claimRefresh(id: string): Promise<PlanUsageRefreshClaim> {
    return this.guard(() => this.inner.claimRefresh(id));
  }
  extendRefresh(id: string, ms: number): Promise<void> {
    return this.guard(() => this.inner.extendRefresh(id, ms));
  }
  clear(id: string): Promise<number> {
    return this.guard(() => this.inner.clear(id));
  }
}

describe('FailoverPlanUsageStore', () => {
  const setup = () => {
    const c = clock();
    const primary = new FlakyStore(new InMemoryPlanUsageStore(c.now));
    const fallback = new InMemoryPlanUsageStore(c.now);
    const faults: unknown[] = [];
    const retries: { fn: () => void; ms: number }[] = [];
    const logs: string[] = [];
    const store = new FailoverPlanUsageStore(primary, fallback, (e) => faults.push(e), {
      schedule: (fn, ms) => retries.push({ fn, ms }),
      log: (m) => logs.push(m),
    });
    return { c, primary, fallback, faults, retries, logs, store };
  };

  it('merge and read fall back to the per-instance record on a fault, each metered once', async () => {
    const { primary, fallback, faults, store } = setup();
    primary.failing = true;
    expect(await store.merge(ID, obs([win()], 'plan'), 0, 'traffic')).toEqual({
      applied: true,
      gen: 0,
    });
    expect(faults).toHaveLength(1);
    const seen = (await store.readMany([ID])).get(ID)!.snapshot;
    expect(faults).toHaveLength(2);
    expect(pct(seen, 'account:5h')).toBe(40);
    expect(pct(await snap(fallback), 'account:5h')).toBe(40);
    // the shared record never saw it
    expect(await snap(primary.inner)).toBeNull();
  });

  it('serves from the primary when it is healthy, and meters nothing', async () => {
    const { primary, faults, store } = setup();
    await store.merge(ID, obs([win()]), 0, 'traffic');
    expect(pct(await snap(primary.inner), 'account:5h')).toBe(40);
    expect(faults).toHaveLength(0);
  });

  it('claim and extend do not fall back: they throw', async () => {
    const { primary, fallback, faults, store } = setup();
    primary.failing = true;
    await expect(store.claimRefresh(ID)).rejects.toThrow('redis down');
    await expect(store.extendRefresh(ID, 10 * MIN)).rejects.toThrow('redis down');
    // nothing was claimed locally either
    primary.failing = false;
    expect((await fallback.claimRefresh(ID)).claimed).toBe(true);
    expect(faults).toHaveLength(2); // each fault metered once
  });

  it('a malformed input is a caller bug: thrown, never metered, never degraded', async () => {
    const { faults, store } = setup();
    await expect(store.merge(ID, obs([win({ key: '' })]), 0, 'traffic')).rejects.toThrow(
      RangeError,
    );
    expect(faults).toHaveLength(0);
  });

  it('clear clears the fallback, then the primary, returning the primary generation', async () => {
    const { primary, fallback, store } = setup();
    await store.merge(ID, obs([win()]), 0, 'traffic');
    expect(await store.clear(ID)).toBe(1);
    expect(await snap(primary.inner)).toBeNull();
    expect(fallback.generation(ID)).toBe(1);
  });

  it('a failed primary clear is retried once after 5 s, then logged', async () => {
    const { primary, faults, retries, logs, store } = setup();
    await store.merge(ID, obs([win()]), 0, 'traffic');
    primary.failing = true;
    expect(await store.clear(ID)).toBe(1); // the fallback's generation
    expect(faults).toHaveLength(1);
    expect(retries).toHaveLength(1);
    expect(retries[0]!.ms).toBe(5_000);
    // the retry fails too: logged with a fixed, secret-free message
    retries[0]!.fn();
    await new Promise((r) => setImmediate(r));
    expect(logs).toEqual(['plan usage: clearing a provider snapshot failed after one retry']);
    // a retry that succeeds clears the shared snapshot
    primary.failing = false;
    retries[0]!.fn();
    await new Promise((r) => setImmediate(r));
    expect(await snap(primary.inner)).toBeNull();
  });

  it('failing over and back never resurrects a cleared snapshot on this instance', async () => {
    const { primary, fallback, store } = setup();
    primary.failing = true;
    await store.merge(ID, obs([win({ usedPercent: 77 })]), 0, 'traffic'); // lands on the fallback
    expect(pct(await snap(fallback), 'account:5h')).toBe(77);
    await store.clear(ID); // primary down: the fallback is cleared and its generation raised
    expect(await snap(fallback)).toBeNull();
    // a late write made with the replaced credential (generation 0) is dropped
    const late = await store.merge(ID, obs([win({ usedPercent: 88 })]), 0, 'traffic');
    expect(late).toEqual({ applied: false, gen: 1 });
    expect(await snap(fallback)).toBeNull();
    // the write at the new generation lands
    expect((await store.merge(ID, obs([win({ usedPercent: 5 })]), 1, 'traffic')).applied).toBe(
      true,
    );
    primary.failing = false;
    expect(await snap(primary.inner)).toBeNull(); // the primary never held the old one either
  });

  it('a throwing meter never breaks the call', async () => {
    const c = clock();
    const primary = new FlakyStore(new InMemoryPlanUsageStore(c.now));
    primary.failing = true;
    const store = new FailoverPlanUsageStore(primary, new InMemoryPlanUsageStore(c.now), () => {
      throw new Error('meter');
    });
    await expect(store.merge(ID, obs([win()]), 0, 'traffic')).resolves.toMatchObject({
      applied: true,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The recorder (task 4.2)
// ---------------------------------------------------------------------------------------------

class SpyStore implements PlanUsageStore {
  readonly merges: {
    id: string;
    obs: PlanUsageObservation;
    gen: number;
    source: PlanUsageSource;
  }[] = [];
  nextResult: () => Promise<PlanUsageMergeResult> = () =>
    Promise.resolve({ applied: true, gen: 0 });
  merge(
    id: string,
    o: PlanUsageObservation,
    gen: number,
    source: PlanUsageSource,
  ): Promise<PlanUsageMergeResult> {
    this.merges.push({ id, obs: o, gen, source });
    return this.nextResult();
  }
  readMany(): Promise<ReadonlyMap<string, PlanUsageRead>> {
    return Promise.resolve(new Map());
  }
  claimRefresh(): Promise<PlanUsageRefreshClaim> {
    return Promise.reject(new Error('unused'));
  }
  extendRefresh(): Promise<void> {
    return Promise.resolve();
  }
  clear(): Promise<number> {
    return Promise.resolve(1);
  }
}
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('PlanUsageRecorder (design D5: the hot-path gate)', () => {
  const o = (
    percent: number,
    billing: PlanUsageObservation['billing'] = 'plan',
  ): PlanUsageObservation => obs([win({ usedPercent: percent })], billing);

  it('100 identical observations within a minute give one merge', () => {
    const c = clock();
    const store = new SpyStore();
    const rec = new PlanUsageRecorder(store, { now: c.now });
    for (let i = 0; i < 100; i += 1) {
      rec.offer(ID, o(40), 0);
      c.advance(500); // 50 s in all
    }
    expect(store.merges).toHaveLength(1);
    expect(store.merges[0]).toMatchObject({ id: ID, gen: 0, source: 'traffic' });
  });

  it('a 1-point change gives one more merge, and so does a billing change or a new reset minute', () => {
    const c = clock();
    const store = new SpyStore();
    const rec = new PlanUsageRecorder(store, { now: c.now });
    rec.offer(ID, o(40), 0);
    rec.offer(ID, o(41), 0);
    expect(store.merges).toHaveLength(2);
    rec.offer(ID, o(41, 'extra_usage'), 0);
    expect(store.merges).toHaveLength(3);
    rec.offer(
      ID,
      obs([win({ usedPercent: 41, reset: { atMs: T0 + 2 * HOUR + 2 * MIN } })], 'extra_usage'),
      0,
    );
    expect(store.merges).toHaveLength(4);
    // sub-point and sub-minute jitter is not a change
    rec.offer(
      ID,
      obs(
        [win({ usedPercent: 41.2, reset: { atMs: T0 + 2 * HOUR + 2 * MIN + 5_000 } })],
        'extra_usage',
      ),
      0,
    );
    expect(store.merges).toHaveLength(4);
  });

  it('61 s of identical traffic gives a heartbeat merge', () => {
    const c = clock();
    const store = new SpyStore();
    const rec = new PlanUsageRecorder(store, { now: c.now });
    rec.offer(ID, o(40), 0);
    c.advance(59_000);
    rec.offer(ID, o(40), 0);
    expect(store.merges).toHaveLength(1);
    c.advance(2_000);
    rec.offer(ID, o(40), 0);
    expect(store.merges).toHaveLength(2);
  });

  it('keeps providers separate', () => {
    const store = new SpyStore();
    const rec = new PlanUsageRecorder(store);
    rec.offer('a', o(40), 0);
    rec.offer('b', o(40), 0);
    expect(store.merges.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('swallows a merge rejection', async () => {
    const store = new SpyStore();
    store.nextResult = () => Promise.reject(new Error('store exploded'));
    const rec = new PlanUsageRecorder(store);
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      expect(() => rec.offer(ID, o(40), 0)).not.toThrow();
      await tick();
      await tick();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('offer is synchronous and never throws, even when the store throws synchronously', () => {
    const store = new SpyStore();
    store.merge = () => {
      throw new Error('sync boom');
    };
    const rec = new PlanUsageRecorder(store);
    expect(rec.offer(ID, o(40), 0)).toBeUndefined();
    // a hostile observation (the signature walk throws) is contained too
    const hostile = { windows: null, billing: null } as unknown as PlanUsageObservation;
    expect(() => rec.offer(ID, hostile, 0)).not.toThrow();
  });

  it('the signature map evicts beyond its bound (LRU)', () => {
    const store = new SpyStore();
    const rec = new PlanUsageRecorder(store, { maxEntries: 2 });
    rec.noteCleared('a', 5);
    rec.offer('b', o(1), 0);
    rec.offer('c', o(1), 0);
    expect(rec.generationOf('a')).toBe(0); // evicted
    expect(rec.generationOf('b')).toBe(0);
    rec.noteCleared('b', 3);
    rec.offer('d', o(1), 0); // evicts c (b was just used)
    expect(rec.generationOf('b')).toBe(3);
    // an evicted provider's identical observation is written again
    rec.offer('c', o(1), 0);
    expect(store.merges.filter((m) => m.id === 'c')).toHaveLength(2);
  });

  it('generationOf is 0 when unknown and never creates an entry', () => {
    const rec = new PlanUsageRecorder(new SpyStore(), { maxEntries: 1 });
    expect(rec.generationOf('nobody')).toBe(0);
    rec.noteCleared('a', 2);
    expect(rec.generationOf('nobody')).toBe(0);
    expect(rec.generationOf('a')).toBe(2); // the read did not evict it
  });

  it('an applied:false reply stores the returned generation and forgets the signature', async () => {
    const c = clock();
    const store = new SpyStore();
    const rec = new PlanUsageRecorder(store, { now: c.now });
    store.nextResult = () => Promise.resolve({ applied: false, gen: 7 });
    rec.offer(ID, o(40), 0);
    await tick();
    expect(rec.generationOf(ID)).toBe(7);
    // the same observation, immediately, is written at once (not up to 60 s later)
    store.nextResult = () => Promise.resolve({ applied: true, gen: 7 });
    rec.offer(ID, o(40), 7);
    expect(store.merges).toHaveLength(2);
    expect(store.merges[1]!.gen).toBe(7);
    await tick();
    rec.offer(ID, o(40), 7);
    expect(store.merges).toHaveLength(2); // now coalesced
  });

  it('a local clear does the same', async () => {
    const store = new SpyStore();
    const rec = new PlanUsageRecorder(store);
    rec.offer(ID, o(40), 0);
    await tick();
    rec.offer(ID, o(40), 0);
    expect(store.merges).toHaveLength(1);
    rec.noteCleared(ID, 4);
    expect(rec.generationOf(ID)).toBe(4);
    rec.offer(ID, o(40), 4);
    expect(store.merges).toHaveLength(2);
  });

  it('an applied reply with a higher generation teaches it', async () => {
    const store = new SpyStore();
    store.nextResult = () => Promise.resolve({ applied: true, gen: 3 });
    const rec = new PlanUsageRecorder(store);
    rec.offer(ID, o(40), 2);
    await tick();
    expect(rec.generationOf(ID)).toBe(3);
  });

  it('the limits table matches the spec', () => {
    expect(PLAN_USAGE_LIMITS).toMatchObject({
      maxWindows: 12,
      maxModelBuckets: 8,
      refreshCooldownMs: 300_000,
      refreshMinMs: 300_000,
      refreshMaxMs: 3_600_000,
    });
  });
});
