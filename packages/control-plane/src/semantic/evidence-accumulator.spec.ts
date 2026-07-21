import type { Redis } from 'ioredis';
import { EvidenceAccumulator } from './evidence-accumulator';

/** A fake Redis capturing eval calls; the in-process cohort logic is what
 * these tests pin (the Lua's float-add is proven against real Redis in e2e). */
function fakeRedis(): { redis: Redis; evals: unknown[][] } {
  const evals: unknown[][] = [];
  const self = {
    status: 'ready',
    duplicate() {
      return self;
    },
    on() {
      return self;
    },
    connect() {
      return Promise.resolve();
    },
    eval(...args: unknown[]) {
      evals.push(args);
      return Promise.resolve(1);
    },
    disconnect() {},
  };
  return { redis: self as unknown as Redis, evals };
}

const vec = (n: number, fill = 1): Float32Array => new Float32Array(n).fill(fill);
const HMAC = 'k'.repeat(64);
const OPTS = { minCohort: 3, maxCohorts: 4, ttlSeconds: 604800 };

describe('EvidenceAccumulator', () => {
  it('batches in memory and flushes ONLY at minCohort (never a count-1 sum)', () => {
    const { redis, evals } = fakeRedis();
    const acc = new EvidenceAccumulator(redis, HMAC);
    const t = acc.tenantHmac('tenant-1');
    acc.contribute(t, 0, 'low', 'rev1', vec(8), OPTS);
    acc.contribute(t, 0, 'low', 'rev1', vec(8), OPTS);
    expect(evals).toHaveLength(0); // 2 < minCohort 3 → nothing persisted
    expect(acc.cohortCount).toBe(1);
    acc.contribute(t, 0, 'low', 'rev1', vec(8), OPTS);
    expect(evals).toHaveLength(1); // 3rd fills the cohort → one flush
    expect(acc.cohortCount).toBe(0); // cohort removed after flush
    // eval(LUA, numKeys, key, count, packed, dims, ttl) → count at index 3;
    // it is minCohort (3), never 1.
    expect(evals[0]![3]).toBe('3');
  });

  it('keeps distinct cohorts per (label, revision)', () => {
    const { redis, evals } = fakeRedis();
    const acc = new EvidenceAccumulator(redis, HMAC);
    const t = acc.tenantHmac('t');
    acc.contribute(t, 0, 'low', 'rev1', vec(8), OPTS);
    acc.contribute(t, 0, 'high', 'rev1', vec(8), OPTS);
    acc.contribute(t, 0, 'low', 'rev2', vec(8), OPTS);
    expect(acc.cohortCount).toBe(3);
    expect(evals).toHaveLength(0);
  });

  it('refuses a NEW cohort at the global cap (drop before allocation)', () => {
    const { redis } = fakeRedis();
    const acc = new EvidenceAccumulator(redis, HMAC);
    const t = acc.tenantHmac('t');
    for (let i = 0; i < OPTS.maxCohorts; i += 1) {
      acc.contribute(t, 0, 'low', `rev${String(i)}`, vec(8), OPTS);
    }
    expect(acc.cohortCount).toBe(OPTS.maxCohorts);
    acc.contribute(t, 0, 'low', 'rev-overflow', vec(8), OPTS); // refused
    expect(acc.cohortCount).toBe(OPTS.maxCohorts);
  });

  it('evicts aged partial cohorts before contributing', () => {
    let clock = 1_000_000;
    const { redis } = fakeRedis();
    const acc = new EvidenceAccumulator(redis, HMAC, () => clock);
    const t = acc.tenantHmac('t');
    acc.contribute(t, 0, 'low', 'rev1', vec(8), OPTS);
    expect(acc.cohortCount).toBe(1);
    clock += 11 * 60_000; // past the 10-min cohort age
    acc.contribute(t, 0, 'high', 'rev1', vec(8), OPTS); // triggers eviction of the aged low cohort
    expect(acc.cohortCount).toBe(1); // only the fresh high cohort remains
  });

  it('the tenant digest is not the raw id', () => {
    const { redis } = fakeRedis();
    const acc = new EvidenceAccumulator(redis, HMAC);
    const h = acc.tenantHmac('tenant-1');
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(h).not.toContain('tenant-1');
  });
});
