import { userPrincipal, type BudgetRow, type PersistencePort } from '@polyrouter/shared/server';
import { BudgetCache } from './budget-cache';
import type { BudgetsConfig } from './budgets.config';

const CFG: BudgetsConfig = {
  redisTimeoutMs: 50,
  reconcileTimeoutMs: 2_000,
  cacheTtlMs: 10_000,
  cacheMax: 2,
  failOpen: true,
  schedEnabled: true,
  schedCron: '* * * * *',
  staleMs: 180_000,
};

// Identity-only rows — the cache treats them opaquely; tests assert which load produced them.
const rowsFor = (tag: string): BudgetRow[] => [{ id: tag } as unknown as BudgetRow];

function makeCache(
  list: jest.Mock,
  cfg: Partial<BudgetsConfig> = {},
): { cache: BudgetCache; list: jest.Mock } {
  const db = { budgets: { list } } as unknown as PersistencePort;
  return { cache: new BudgetCache(db, { ...CFG, ...cfg }), list };
}

describe('BudgetCache (A-17)', () => {
  beforeEach(() => jest.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => jest.useRealTimers());

  it('serves a fresh entry from cache within the TTL (one DB load)', async () => {
    const { cache, list } = makeCache(jest.fn().mockResolvedValue(rowsFor('a')));
    const p = userPrincipal('u1');
    expect(await cache.get(p)).toEqual(rowsFor('a'));
    jest.advanceTimersByTime(CFG.cacheTtlMs - 1); // still fresh
    await cache.get(p);
    expect(list).toHaveBeenCalledTimes(1); // second read hit the cache
  });

  it('refetches after the TTL expires', async () => {
    const list = jest.fn().mockResolvedValueOnce(rowsFor('a')).mockResolvedValueOnce(rowsFor('b'));
    const { cache } = makeCache(list);
    const p = userPrincipal('u1');
    expect(await cache.get(p)).toEqual(rowsFor('a'));
    jest.advanceTimersByTime(CFG.cacheTtlMs + 1); // now stale
    expect(await cache.get(p)).toEqual(rowsFor('b'));
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent misses into a single in-flight load (single-flight)', async () => {
    let resolve!: (r: BudgetRow[]) => void;
    const list = jest.fn().mockReturnValue(new Promise<BudgetRow[]>((r) => (resolve = r)));
    const { cache } = makeCache(list);
    const p = userPrincipal('u1');
    const a = cache.get(p);
    const b = cache.get(p); // same owner, load still in flight
    resolve(rowsFor('a'));
    expect(await a).toEqual(rowsFor('a'));
    expect(await b).toEqual(rowsFor('a'));
    expect(list).toHaveBeenCalledTimes(1); // one shared load, not two
  });

  it('propagates a COLD-miss load error (so the caller engages the fail mode)', async () => {
    const { cache } = makeCache(jest.fn().mockRejectedValue(new Error('db down')));
    await expect(cache.get(userPrincipal('u1'))).rejects.toThrow('db down');
  });

  it('serves the STALE entry on a refresh error (transient blip does not fail the request)', async () => {
    const list = jest
      .fn()
      .mockResolvedValueOnce(rowsFor('a')) // warms the cache
      .mockRejectedValueOnce(new Error('db blip')); // the post-TTL refresh fails
    const { cache } = makeCache(list);
    const p = userPrincipal('u1');
    expect(await cache.get(p)).toEqual(rowsFor('a'));
    jest.advanceTimersByTime(CFG.cacheTtlMs + 1); // entry present but stale
    expect(await cache.get(p)).toEqual(rowsFor('a')); // served stale, not thrown
  });

  it('invalidates an owner on write (forces a refetch)', async () => {
    const list = jest.fn().mockResolvedValueOnce(rowsFor('a')).mockResolvedValueOnce(rowsFor('b'));
    const { cache } = makeCache(list);
    const p = userPrincipal('u1');
    expect(await cache.get(p)).toEqual(rowsFor('a'));
    cache.invalidate(p);
    expect(await cache.get(p)).toEqual(rowsFor('b')); // refetched despite being within TTL
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('evicts the least-recently-used owner past the cap', async () => {
    const list = jest.fn((p: { userId?: string }) => Promise.resolve(rowsFor(p.userId ?? '?')));
    const { cache } = makeCache(list as unknown as jest.Mock); // cacheMax = 2
    const [a, b, c] = [userPrincipal('a'), userPrincipal('b'), userPrincipal('c')];
    await cache.get(a);
    await cache.get(b);
    await cache.get(c); // 'a' is now the LRU → evicted
    list.mockClear();
    await cache.get(b); // still cached
    await cache.get(c); // still cached
    expect(list).not.toHaveBeenCalled();
    await cache.get(a); // evicted → reload
    expect(list).toHaveBeenCalledTimes(1);
  });
});
