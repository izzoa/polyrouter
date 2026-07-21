import { packVector, unpackVector } from './learning-format';
import { RedisLearningStore, windowDayStamps, type LearnedState } from './learning-store';
import { InMemoryLearningStore } from './testing/in-memory-learning-store';

/**
 * The learning store's semantics, pinned against the in-memory "simulated Redis"
 * (the breaker's `InMemoryBreakerStore` precedent). The real-Redis Lua is proven
 * to match this reference in `learning-store-redis.spec.ts` (REDIS_URL-gated).
 */

const vec = (n: number, fill = 1): Float32Array => new Float32Array(n).fill(fill);
const REV = 'sha256:rev1';
const HMAC = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const at = (iso: string): (() => number) => {
  const t = Date.parse(iso);
  return () => t;
};
const opts = (over: Partial<Parameters<InMemoryLearningStore['rotate']>[2]> = {}) => ({
  epoch: 0,
  revision: REV,
  windowDays: 30,
  minSamples: 50,
  workTtlSeconds: 3600,
  ...over,
});
const state = (epoch: number, generation: number, revision = REV): LearnedState => ({
  epoch,
  generation,
  revision,
  centroids: { high: vec(8, 0.5), low: vec(8, -0.5) },
});

describe('learning-format vector packing', () => {
  it('round-trips a float32 vector little-endian, exactly', () => {
    const v = Float32Array.from([0, 1.5, -2.25, 1_000_000, 0.125]);
    const back = unpackVector(packVector(v));
    expect(back).not.toBeNull();
    expect(Array.from(back as Float32Array)).toEqual(Array.from(v));
  });

  it('rejects a byte length that is not a whole number of float32s', () => {
    expect(unpackVector(Buffer.from([1, 2, 3]))).toBeNull();
    expect(unpackVector(Buffer.alloc(0))).toBeNull();
  });
});

describe('windowDayStamps', () => {
  it('returns N descending UTC day stamps starting from today', () => {
    expect(windowDayStamps(Date.parse('2026-07-21T00:30:00Z'), 3)).toEqual([
      '20260721',
      '20260720',
      '20260719',
    ]);
  });

  it('clamps a non-positive or absurd window to a sane bound', () => {
    expect(windowDayStamps(Date.parse('2026-07-21T00:30:00Z'), 0)).toEqual(['20260721']);
    expect(windowDayStamps(Date.parse('2026-07-21T00:30:00Z'), 10_000)).toHaveLength(366);
  });
});

describe('LearningStore rotate', () => {
  it('rotates only labels at/above the sample floor; below-floor buckets persist toward it', async () => {
    const store = new InMemoryLearningStore(at('2026-07-21T12:00:00Z'));
    // high: 80 fresh samples over two days; low: 30 (below the floor of 50).
    store.seedPending(HMAC, 0, 'high', REV, '20260721', vec(8, 1), 50);
    store.seedPending(HMAC, 0, 'high', REV, '20260720', vec(8, 1), 30);
    store.seedPending(HMAC, 0, 'low', REV, '20260721', vec(8, 2), 30);

    const r1 = await store.rotate(HMAC, 'occ1', opts());
    expect(r1.high).not.toBeNull();
    expect(r1.high?.count).toBe(80);
    expect(Array.from(r1.high?.sum as Float32Array)).toEqual(new Array(8).fill(2)); // [1]+[1]
    expect(r1.low).toBeNull(); // below floor → not rotated, not consumed

    // The below-floor low bucket persisted; more low traffic pushes it over the floor.
    store.seedPending(HMAC, 0, 'low', REV, '20260721', vec(8, 2), 30); // now 60 low, sum [4]
    const r2 = await store.rotate(HMAC, 'occ2', opts());
    expect(r2.low?.count).toBe(60);
    expect(Array.from(r2.low?.sum as Float32Array)).toEqual(new Array(8).fill(4));
    expect(r2.high).toBeNull(); // high was already consumed by occ1
  });

  it('reads only the requested revision', async () => {
    const store = new InMemoryLearningStore(at('2026-07-21T12:00:00Z'));
    store.seedPending(HMAC, 0, 'high', 'sha256:revA', '20260721', vec(8, 1), 60);
    store.seedPending(HMAC, 0, 'high', 'sha256:revB', '20260721', vec(8, 1), 60);
    const r = await store.rotate(HMAC, 'occ1', opts({ revision: 'sha256:revA' }));
    expect(r.high?.count).toBe(60);
  });

  it('ignores buckets outside the fixed freshness window', async () => {
    const store = new InMemoryLearningStore(at('2026-07-21T12:00:00Z'));
    store.seedPending(HMAC, 0, 'high', REV, '20260721', vec(8, 1), 40); // today
    store.seedPending(HMAC, 0, 'high', REV, '20260701', vec(8, 1), 40); // 20 days ago
    const narrow = await store.rotate(HMAC, 'occ1', opts({ windowDays: 7 }));
    expect(narrow.high).toBeNull(); // only 40 in the 7-day window < 50 floor
    const wide = await store.rotate(HMAC, 'occ2', opts({ windowDays: 30 }));
    expect(wide.high?.count).toBe(80); // both buckets inside the 30-day window
  });

  it('resume-existing: a re-rotate of the same occurrence returns the first snapshot and shields it from a racing contribution', async () => {
    const store = new InMemoryLearningStore(at('2026-07-21T12:00:00Z'));
    store.seedPending(HMAC, 0, 'high', REV, '20260721', vec(8, 1), 50);
    const r1 = await store.rotate(HMAC, 'occ1', opts());
    expect(r1.high?.count).toBe(50);

    // A contribution lands AFTER the occurrence rotated (concurrent write).
    store.seedPending(HMAC, 0, 'high', REV, '20260721', vec(8, 1), 999);
    const r2 = await store.rotate(HMAC, 'occ1', opts()); // same occurrence → resume, no re-fold
    expect(r2.high?.count).toBe(50);

    // The racing contribution is not lost — a NEW occurrence picks it up.
    const r3 = await store.rotate(HMAC, 'occ2', opts());
    expect(r3.high?.count).toBe(999);
  });

  it('creates no work key (and returns nothing) when both labels are below the floor', async () => {
    const store = new InMemoryLearningStore(at('2026-07-21T12:00:00Z'));
    store.seedPending(HMAC, 0, 'high', REV, '20260721', vec(8, 1), 10);
    const r = await store.rotate(HMAC, 'occ1', opts());
    expect(r.high).toBeNull();
    expect(r.low).toBeNull();
    // Nothing consumed: a later, larger occurrence still sees the samples.
    store.seedPending(HMAC, 0, 'high', REV, '20260721', vec(8, 1), 45); // now 55
    expect((await store.rotate(HMAC, 'occ2', opts())).high?.count).toBe(55);
  });

  it('returns COPIES — mutating a rotated sum cannot corrupt the resumed snapshot', async () => {
    const store = new InMemoryLearningStore(at('2026-07-21T12:00:00Z'));
    store.seedPending(HMAC, 0, 'high', REV, '20260721', vec(8, 1), 60);
    const r1 = await store.rotate(HMAC, 'occ1', opts());
    (r1.high as { sum: Float32Array }).sum[0] = 999;
    const r2 = await store.rotate(HMAC, 'occ1', opts()); // resume
    expect(r2.high?.sum[0]).not.toBe(999);
  });
});

describe('RedisLearningStore TTL validation', () => {
  // A non-positive TTL makes Redis EXPIRE delete the key — guard before any eval.
  const stub = {} as unknown as import('ioredis').Redis;
  const store = new RedisLearningStore(stub);
  const s = state(0, 1);

  it('rejects a non-positive rotate workTtlSeconds before touching Redis', async () => {
    await expect(store.rotate(HMAC, 'o', opts({ workTtlSeconds: 0 }))).rejects.toThrow(/positive/);
  });
  it('rejects a non-positive stage ttlSeconds', async () => {
    await expect(store.stage(HMAC, 'o', s, 0)).rejects.toThrow(/positive/);
    await expect(store.stage(HMAC, 'o', s, -5)).rejects.toThrow(/positive/);
  });
  it('rejects a non-positive promote activeTtlSeconds', async () => {
    await expect(store.promote(HMAC, 'o', { epoch: 0, generation: 1 }, 0)).rejects.toThrow(
      /positive/,
    );
  });
});

describe('LearningStore stage / promote / readActive', () => {
  it('stage → promote → readActive serves the staged centroids under the matching gate', async () => {
    const store = new InMemoryLearningStore();
    await store.stage(HMAC, 'occ1', state(0, 1), 3600);
    expect(await store.readActive(HMAC, { epoch: 0, generation: 1, revision: REV })).toBeNull(); // unreadable before promote

    expect(await store.promote(HMAC, 'occ1', { epoch: 0, generation: 1 }, 3600)).toBe(true);
    const active = await store.readActive(HMAC, { epoch: 0, generation: 1, revision: REV });
    expect(active).not.toBeNull();
    expect(Array.from(active?.high as Float32Array)).toEqual(Array.from(vec(8, 0.5)));
    expect(Array.from(active?.low as Float32Array)).toEqual(Array.from(vec(8, -0.5)));
  });

  it('promotes only when BOTH epoch and generation match the committed coordinates', async () => {
    const store = new InMemoryLearningStore();
    await store.stage(HMAC, 'occ1', state(0, 5), 3600);
    expect(await store.promote(HMAC, 'occ1', { epoch: 0, generation: 4 }, 3600)).toBe(false); // wrong generation
    expect(await store.promote(HMAC, 'occ1', { epoch: 9, generation: 5 }, 3600)).toBe(false); // wrong epoch
    expect(await store.readActive(HMAC, { epoch: 0, generation: 5, revision: REV })).toBeNull();
    expect(await store.promote(HMAC, 'occ1', { epoch: 0, generation: 5 }, 3600)).toBe(true);
    expect(await store.readActive(HMAC, { epoch: 0, generation: 5, revision: REV })).not.toBeNull();
  });

  it('is idempotent on promote — a crash-after-commit retry re-promotes exactly once (self-heal)', async () => {
    const store = new InMemoryLearningStore();
    await store.stage(HMAC, 'occ1', state(2, 3), 3600);
    expect(await store.promote(HMAC, 'occ1', { epoch: 2, generation: 3 }, 3600)).toBe(true);
    // Retry: stage already consumed, active already at (2,3) → idempotent success.
    expect(await store.promote(HMAC, 'occ1', { epoch: 2, generation: 3 }, 3600)).toBe(true);
    expect(await store.readActive(HMAC, { epoch: 2, generation: 3, revision: REV })).not.toBeNull();
  });

  it('readActive gates on epoch, generation, AND revision — any mismatch falls through to bundled', async () => {
    const store = new InMemoryLearningStore();
    await store.stage(HMAC, 'occ1', state(1, 2), 3600);
    await store.promote(HMAC, 'occ1', { epoch: 1, generation: 2 }, 3600);
    expect(await store.readActive(HMAC, { epoch: 1, generation: 2, revision: REV })).not.toBeNull();
    expect(await store.readActive(HMAC, { epoch: 0, generation: 2, revision: REV })).toBeNull();
    expect(await store.readActive(HMAC, { epoch: 1, generation: 9, revision: REV })).toBeNull();
    expect(
      await store.readActive(HMAC, { epoch: 1, generation: 2, revision: 'sha256:other' }),
    ).toBeNull();
  });

  it('promote returns false with no stage and no matching active', async () => {
    const store = new InMemoryLearningStore();
    expect(await store.promote(HMAC, 'ghost', { epoch: 0, generation: 1 }, 3600)).toBe(false);
  });

  it('is MONOTONIC — a delayed older occurrence never downgrades a newer active', async () => {
    const store = new InMemoryLearningStore();
    // A later occurrence promotes generation 2 first.
    await store.stage(HMAC, 'occ2', state(0, 2), 3600);
    expect(await store.promote(HMAC, 'occ2', { epoch: 0, generation: 2 }, 3600)).toBe(true);
    // An older occurrence's stage lands late and tries to promote generation 1.
    await store.stage(HMAC, 'occ1', state(0, 1), 3600);
    expect(await store.promote(HMAC, 'occ1', { epoch: 0, generation: 1 }, 3600)).toBe(false);
    // Active stays at generation 2; the stale generation-1 stage was discarded.
    expect(await store.readActive(HMAC, { epoch: 0, generation: 2, revision: REV })).not.toBeNull();
    expect(await store.readActive(HMAC, { epoch: 0, generation: 1, revision: REV })).toBeNull();
  });

  it('treats a higher epoch as always newer (a bumped revocation epoch supersedes any generation)', async () => {
    const store = new InMemoryLearningStore();
    await store.stage(HMAC, 'occNew', state(1, 0), 3600); // epoch 1, generation 0
    expect(await store.promote(HMAC, 'occNew', { epoch: 1, generation: 0 }, 3600)).toBe(true);
    await store.stage(HMAC, 'occOld', state(0, 9), 3600); // epoch 0 but high generation
    expect(await store.promote(HMAC, 'occOld', { epoch: 0, generation: 9 }, 3600)).toBe(false);
    expect(await store.readActive(HMAC, { epoch: 1, generation: 0, revision: REV })).not.toBeNull();
  });

  it('returns COPIES from readActive — mutating a result cannot corrupt stored state', async () => {
    const store = new InMemoryLearningStore();
    await store.stage(HMAC, 'occ1', state(0, 1), 3600);
    await store.promote(HMAC, 'occ1', { epoch: 0, generation: 1 }, 3600);
    const a1 = await store.readActive(HMAC, { epoch: 0, generation: 1, revision: REV });
    (a1 as { high: Float32Array }).high[0] = 999;
    const a2 = await store.readActive(HMAC, { epoch: 0, generation: 1, revision: REV });
    expect(a2?.high[0]).not.toBe(999);
  });
});

describe('LearningStore deleteTenant (revert fence cleanup)', () => {
  it('erases exactly one tenant’s pending, work, stage, and active state', async () => {
    const store = new InMemoryLearningStore(at('2026-07-21T12:00:00Z'));
    store.seedPending(HMAC, 0, 'high', REV, '20260721', vec(8, 1), 60);
    await store.stage(HMAC, 'occ1', state(0, 1), 3600);
    await store.promote(HMAC, 'occ1', { epoch: 0, generation: 1 }, 3600);
    store.seedPending(OTHER, 0, 'high', REV, '20260721', vec(8, 1), 60); // a bystander tenant

    await store.deleteTenant(HMAC);

    expect(await store.readActive(HMAC, { epoch: 0, generation: 1, revision: REV })).toBeNull();
    expect((await store.rotate(HMAC, 'occX', opts())).high).toBeNull(); // pending gone

    // The other tenant is untouched.
    expect((await store.rotate(OTHER, 'occY', opts())).high?.count).toBe(60);
  });
});

describe('LearningStore discardStaleRevisions (config-change reconcile → discard_revision)', () => {
  const CUR = 'sha256:cur';
  const OLD = 'sha256:old';

  it('deletes pending AND active under a stale revision, keeping the current one', async () => {
    const store = new InMemoryLearningStore(at('2026-07-21T12:00:00Z'));
    store.seedPending(HMAC, 0, 'high', CUR, '20260721', vec(8, 1), 60); // keep
    store.seedPending(HMAC, 0, 'high', OLD, '20260721', vec(8, 1), 60); // discard
    store.seedPending(HMAC, 0, 'low', OLD, '20260720', vec(8, 1), 40); // discard
    await store.stage(HMAC, 'occ', state(0, 1, OLD), 3600);
    await store.promote(HMAC, 'occ', { epoch: 0, generation: 1 }, 3600); // stale active

    const res = await store.discardStaleRevisions(HMAC, 0, CUR);
    expect(res).toEqual({ pendingDiscarded: 2, activeDiscarded: true });
    // The current-revision pending survives and is still rotatable.
    expect((await store.rotate(HMAC, 'occ2', opts({ revision: CUR }))).high?.count).toBe(60);
    // The stale active is gone.
    expect(await store.readActive(HMAC, { epoch: 0, generation: 1, revision: OLD })).toBeNull();
  });

  it('no-ops when everything is already at the current revision', async () => {
    const store = new InMemoryLearningStore(at('2026-07-21T12:00:00Z'));
    store.seedPending(HMAC, 0, 'high', REV, '20260721', vec(8, 1), 60);
    await store.stage(HMAC, 'occ', state(0, 1, REV), 3600);
    await store.promote(HMAC, 'occ', { epoch: 0, generation: 1 }, 3600);
    expect(await store.discardStaleRevisions(HMAC, 0, REV)).toEqual({
      pendingDiscarded: 0,
      activeDiscarded: false,
    });
    expect((await store.rotate(HMAC, 'occ2', opts())).high?.count).toBe(60);
  });

  it('discards stale pending independently of a current-revision active', async () => {
    const store = new InMemoryLearningStore(at('2026-07-21T12:00:00Z'));
    store.seedPending(HMAC, 0, 'high', OLD, '20260721', vec(8, 1), 60);
    await store.stage(HMAC, 'occ', state(0, 1, CUR), 3600);
    await store.promote(HMAC, 'occ', { epoch: 0, generation: 1 }, 3600); // current active
    const res = await store.discardStaleRevisions(HMAC, 0, CUR);
    expect(res).toEqual({ pendingDiscarded: 1, activeDiscarded: false });
    expect(await store.readActive(HMAC, { epoch: 0, generation: 1, revision: CUR })).not.toBeNull();
  });
});

describe('LearningStore pendingCounts (status view)', () => {
  it('sums fresh samples per label for the given revision only', async () => {
    const store = new InMemoryLearningStore(at('2026-07-21T12:00:00Z'));
    store.seedPending(HMAC, 0, 'high', REV, '20260721', vec(8, 1), 50);
    store.seedPending(HMAC, 0, 'high', REV, '20260720', vec(8, 1), 30);
    store.seedPending(HMAC, 0, 'low', REV, '20260721', vec(8, 1), 20);
    store.seedPending(HMAC, 0, 'high', 'sha256:other', '20260721', vec(8, 1), 99); // other revision
    expect(await store.pendingCounts(HMAC, 0, REV)).toEqual({ high: 80, low: 20 });
  });

  it('is 0/0 for a tenant with no pending', async () => {
    const store = new InMemoryLearningStore(at('2026-07-21T12:00:00Z'));
    expect(await store.pendingCounts(HMAC, 0, REV)).toEqual({ high: 0, low: 0 });
  });
});
