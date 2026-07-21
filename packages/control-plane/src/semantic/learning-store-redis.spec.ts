import { Redis } from 'ioredis';
import { dayStamp } from './learning-format';
import { RedisLearningStore, type LearnedState, type RotateOptions } from './learning-store';
import { InMemoryLearningStore } from './testing/in-memory-learning-store';
import { seedPendingBucket } from './testing/seed-pending';

/**
 * Pins the store's three Lua scripts to the in-memory reference against a REAL
 * Redis (the breaker's `breaker-redis.spec.ts` discipline). Gated on REDIS_URL
 * locally; REQUIRED in CI (an env-gated infra suite must fail loudly, never
 * silently skip). What the reference proves for semantics, this proves for the
 * Lua's byte-level fold, hash round-trips, and generation gating.
 */

const REDIS_URL = process.env['REDIS_URL'];
if (REDIS_URL === undefined && process.env['CI'] !== undefined) {
  throw new Error(
    '[learning-store-redis] CI is set but REDIS_URL is missing — the real-Redis parity ' +
      'suite is required in CI. Provision a redis service and export REDIS_URL.',
  );
}
const suite = REDIS_URL !== undefined ? describe : describe.skip;
if (REDIS_URL === undefined) {
  console.warn('[learning-store-redis] REDIS_URL not set — skipping the real-Redis parity suite');
}

const NOW = Date.parse('2026-07-21T12:00:00Z');
const clock = (): number => NOW;
const REV = 'sha256:rev1';
const OPTS: RotateOptions = {
  epoch: 0,
  revision: REV,
  windowDays: 30,
  minSamples: 50,
  workTtlSeconds: 3600,
};
const TTL = 3600;
const vec = (n: number, fill = 1): Float32Array => new Float32Array(n).fill(fill);
const st = (epoch: number, generation: number, revision = REV): LearnedState => ({
  epoch,
  generation,
  revision,
  centroids: { high: vec(8, 0.5), low: vec(8, -0.25) },
});

function expectVecClose(a: Float32Array | undefined, b: Float32Array | undefined): void {
  expect(a).toBeDefined();
  expect(b).toBeDefined();
  expect(a?.length).toBe(b?.length);
  for (let i = 0; i < (a as Float32Array).length; i += 1) {
    expect((a as Float32Array)[i]).toBeCloseTo((b as Float32Array)[i] as number, 3);
  }
}

suite('RedisLearningStore parity with the in-memory reference', () => {
  let redis: Redis;
  // A per-PROCESS seed (real wall clock — distinct from the fixed store `clock`)
  // so re-runs never collide on a still-TTL'd key from a previous run.
  const runSeed = Date.now().toString(36);
  let idc = 0;
  const uniqueHmac = (): string => {
    idc += 1;
    return `${runSeed}${String(idc)}`.padEnd(32, '0').slice(0, 32);
  };

  beforeAll(() => {
    redis = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1, lazyConnect: false });
  });
  afterAll(async () => {
    await redis.quit();
  });

  it('rotate: folds eligible labels, leaves below-floor buckets, and matches the reference sums', async () => {
    const hmac = uniqueHmac();
    const mem = new InMemoryLearningStore(clock);
    const red = new RedisLearningStore(redis, clock);
    const seed = async (
      label: 'high' | 'low',
      day: string,
      s: Float32Array,
      c: number,
    ): Promise<void> => {
      mem.seedPending(hmac, 0, label, REV, day, s, c);
      await seedPendingBucket(redis, hmac, 0, label, REV, day, s, c, TTL);
    };
    await seed('high', dayStamp(NOW), vec(8, 1), 50);
    await seed('high', dayStamp(NOW - 86_400_000), vec(8, 1), 30);
    await seed('low', dayStamp(NOW), vec(8, 2), 30); // below floor

    const rm = await mem.rotate(hmac, 'occ1', OPTS);
    const rr = await red.rotate(hmac, 'occ1', OPTS);
    expect(rr.high?.count).toBe(rm.high?.count);
    expect(rr.high?.count).toBe(80);
    expectVecClose(rr.high?.sum, rm.high?.sum);
    expect(rr.low).toBeNull();
    expect(rm.low).toBeNull();

    // The below-floor `low` bucket must NOT have been consumed on real Redis:
    // top it over the floor and a NEW occurrence folds the original 30 + new 40.
    await seedPendingBucket(redis, hmac, 0, 'low', REV, dayStamp(NOW), vec(8, 2), 40, TTL);
    mem.seedPending(hmac, 0, 'low', REV, dayStamp(NOW), vec(8, 2), 40);
    const lm = await mem.rotate(hmac, 'occ2', OPTS);
    const lr = await red.rotate(hmac, 'occ2', OPTS);
    expect(lr.low?.count).toBe(70); // 30 (retained) + 40
    expect(lr.low?.count).toBe(lm.low?.count);
    expectVecClose(lr.low?.sum, lm.low?.sum);

    await red.deleteTenant(hmac);
  });

  it('promote is monotonic on real Redis — a delayed older occurrence never downgrades active', async () => {
    const hmac = uniqueHmac();
    const red = new RedisLearningStore(redis, clock);
    await red.stage(hmac, 'occ2', st(0, 2), TTL);
    expect(await red.promote(hmac, 'occ2', { epoch: 0, generation: 2 }, TTL)).toBe(true);
    await red.stage(hmac, 'occ1', st(0, 1), TTL);
    expect(await red.promote(hmac, 'occ1', { epoch: 0, generation: 1 }, TTL)).toBe(false);
    expect(await red.readActive(hmac, { epoch: 0, generation: 2, revision: REV })).not.toBeNull();
    expect(await red.readActive(hmac, { epoch: 0, generation: 1, revision: REV })).toBeNull();
    await red.deleteTenant(hmac);
  });

  it('rotate: resume-existing returns the first snapshot on real Redis, shielding a racing write', async () => {
    const hmac = uniqueHmac();
    const red = new RedisLearningStore(redis, clock);
    await seedPendingBucket(redis, hmac, 0, 'high', REV, dayStamp(NOW), vec(8, 1), 50, TTL);
    const r1 = await red.rotate(hmac, 'occ1', OPTS);
    expect(r1.high?.count).toBe(50);
    await seedPendingBucket(redis, hmac, 0, 'high', REV, dayStamp(NOW), vec(8, 1), 999, TTL);
    const r2 = await red.rotate(hmac, 'occ1', OPTS);
    expect(r2.high?.count).toBe(50); // resume — the racing 999 is not folded in
    const r3 = await red.rotate(hmac, 'occ2', OPTS);
    expect(r3.high?.count).toBe(999); // a new occurrence picks it up
    await red.deleteTenant(hmac);
  });

  it('stage → promote → readActive: gated the same as the reference', async () => {
    const hmac = uniqueHmac();
    const mem = new InMemoryLearningStore(clock);
    const red = new RedisLearningStore(redis, clock);
    for (const store of [mem, red]) await store.stage(hmac, 'occ1', st(0, 1), TTL);

    // Unreadable before promote.
    expect(await red.readActive(hmac, { epoch: 0, generation: 1, revision: REV })).toBeNull();
    // Wrong generation does not promote.
    expect(await red.promote(hmac, 'occ1', { epoch: 0, generation: 2 }, TTL)).toBe(false);
    expect(await mem.promote(hmac, 'occ1', { epoch: 0, generation: 2 }, TTL)).toBe(false);
    // Matching coordinates promote.
    expect(await red.promote(hmac, 'occ1', { epoch: 0, generation: 1 }, TTL)).toBe(true);
    expect(await mem.promote(hmac, 'occ1', { epoch: 0, generation: 1 }, TTL)).toBe(true);

    const am = await mem.readActive(hmac, { epoch: 0, generation: 1, revision: REV });
    const ar = await red.readActive(hmac, { epoch: 0, generation: 1, revision: REV });
    expectVecClose(ar?.high, am?.high);
    expectVecClose(ar?.low, am?.low);

    // Every gate coordinate matters — a mismatch is a miss.
    expect(await red.readActive(hmac, { epoch: 1, generation: 1, revision: REV })).toBeNull();
    expect(await red.readActive(hmac, { epoch: 0, generation: 9, revision: REV })).toBeNull();
    expect(
      await red.readActive(hmac, { epoch: 0, generation: 1, revision: 'sha256:x' }),
    ).toBeNull();

    // Idempotent re-promote (crash-after-commit self-heal).
    expect(await red.promote(hmac, 'occ1', { epoch: 0, generation: 1 }, TTL)).toBe(true);
    await red.deleteTenant(hmac);
  });

  it('discardStaleRevisions removes stale pending + active, matching the reference', async () => {
    const hmac = uniqueHmac();
    const mem = new InMemoryLearningStore(clock);
    const red = new RedisLearningStore(redis, clock);
    const CUR = 'sha256:cur';
    const OLD = 'sha256:old';
    for (const [label, rev, day, c] of [
      ['high', CUR, dayStamp(NOW), 60],
      ['high', OLD, dayStamp(NOW), 60],
      ['low', OLD, dayStamp(NOW - 86_400_000), 40],
    ] as const) {
      mem.seedPending(hmac, 0, label, rev, day, vec(8, 1), c);
      await seedPendingBucket(redis, hmac, 0, label, rev, day, vec(8, 1), c, TTL);
    }
    for (const store of [mem, red]) {
      await store.stage(hmac, 'occ', { ...st(0, 1), revision: OLD }, TTL);
      await store.promote(hmac, 'occ', { epoch: 0, generation: 1 }, TTL);
    }

    const dm = await mem.discardStaleRevisions(hmac, 0, CUR);
    const dr = await red.discardStaleRevisions(hmac, 0, CUR);
    expect(dr).toEqual(dm);
    expect(dr).toEqual({ pendingDiscarded: 2, activeDiscarded: true });
    // The current-revision pending survives on real Redis.
    expect((await red.rotate(hmac, 'occ2', { ...OPTS, revision: CUR })).high?.count).toBe(60);
    expect(await red.readActive(hmac, { epoch: 0, generation: 1, revision: OLD })).toBeNull();
    await red.deleteTenant(hmac);
  });

  it('pendingCounts sums per label on real Redis, matching the reference', async () => {
    const hmac = uniqueHmac();
    const mem = new InMemoryLearningStore(clock);
    const red = new RedisLearningStore(redis, clock);
    for (const [label, day, c] of [
      ['high', dayStamp(NOW), 50],
      ['high', dayStamp(NOW - 86_400_000), 30],
      ['low', dayStamp(NOW), 20],
    ] as const) {
      mem.seedPending(hmac, 0, label, REV, day, vec(8, 1), c);
      await seedPendingBucket(redis, hmac, 0, label, REV, day, vec(8, 1), c, TTL);
    }
    const rc = await red.pendingCounts(hmac, 0, REV);
    expect(rc).toEqual(await mem.pendingCounts(hmac, 0, REV));
    expect(rc).toEqual({ high: 80, low: 20 });
    await red.deleteTenant(hmac);
  });

  it('deleteTenant erases every key for the tenant', async () => {
    const hmac = uniqueHmac();
    const red = new RedisLearningStore(redis, clock);
    await seedPendingBucket(redis, hmac, 0, 'high', REV, dayStamp(NOW), vec(8, 1), 60, TTL);
    await red.stage(hmac, 'occ1', st(0, 1), TTL);
    await red.promote(hmac, 'occ1', { epoch: 0, generation: 1 }, TTL);

    await red.deleteTenant(hmac);

    expect(await red.readActive(hmac, { epoch: 0, generation: 1, revision: REV })).toBeNull();
    expect((await red.rotate(hmac, 'occX', OPTS)).high).toBeNull();
    const remaining = await redis.keys(`sem:{${hmac}}:*`);
    expect(remaining).toHaveLength(0);
    await red.deleteTenant(hmac);
  });
});
