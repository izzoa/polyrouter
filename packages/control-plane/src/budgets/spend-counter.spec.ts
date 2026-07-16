import { Redis } from 'ioredis';
import { SpendCounter } from './spend-counter';
import type { BudgetsConfig } from './budgets.config';

const CFG: BudgetsConfig = {
  redisTimeoutMs: 50,
  cacheTtlMs: 10_000,
  cacheMax: 5_000,
  failOpen: true,
  schedEnabled: true,
  schedCron: '* * * * *',
  staleMs: 180_000,
};

/** In-memory fake of the dedicated connection implementing the ops SpendCounter
 * uses — including the reconcile-max Lua semantics so monotonicity is exercised. */
class FakeConn {
  status = 'ready';
  store = new Map<string, string>();
  failNext = false;
  on(): this {
    return this;
  }
  connect(): Promise<void> {
    return Promise.resolve();
  }
  disconnect(): void {}
  mget(keys: string[]): Promise<(string | null)[]> {
    if (this.failNext) return Promise.reject(new Error('command timed out'));
    return Promise.resolve(keys.map((k) => this.store.get(k) ?? null));
  }
  get(k: string): Promise<string | null> {
    return Promise.resolve(this.store.get(k) ?? null);
  }
  set(k: string, v: string | number, ...args: unknown[]): Promise<'OK' | null> {
    if (args.includes('NX') && this.store.has(k)) return Promise.resolve(null);
    this.store.set(k, String(v));
    return Promise.resolve('OK');
  }
  eval(_s: string, _n: number, key: string, micros: string, _ttl: string): Promise<number> {
    const cur = Number(this.store.get(key) ?? '0');
    const v = Number(micros);
    if (v > cur) this.store.set(key, String(v));
    return Promise.resolve(Math.max(cur, v));
  }
}

function make(): { counter: SpendCounter; conn: FakeConn } {
  const conn = new FakeConn();
  const redis = { duplicate: () => conn } as unknown as Redis;
  return { counter: new SpendCounter(redis, CFG), conn };
}

describe('SpendCounter', () => {
  it('builds a stable owner/scope/window/period key', () => {
    const { counter } = make();
    expect(counter.key('u1', 'agent', 'a1', 'day', '2026-03-15')).toBe(
      'budget:u1:agent:a1:day:2026-03-15',
    );
  });

  it('reads current µ$, treating a missing key as 0', async () => {
    const { counter, conn } = make();
    conn.store.set('k1', '2500000');
    expect(await counter.read(['k1', 'k2'])).toEqual([2_500_000, 0]);
    expect(await counter.read([])).toEqual([]);
  });

  it('reconcileMax raises but never lowers the counter (monotonic)', async () => {
    const { counter } = make();
    expect(await counter.reconcileMax('k', 100, 1000)).toBe(100);
    expect(await counter.reconcileMax('k', 50, 1000)).toBe(100); // older/out-of-order snapshot
    expect(await counter.reconcileMax('k', 150, 1000)).toBe(150);
    expect(await counter.read(['k'])).toEqual([150]);
  });

  it('markOnce wins exactly once per key', async () => {
    const { counter } = make();
    expect(await counter.markOnce('m', 1000)).toBe(true);
    expect(await counter.markOnce('m', 1000)).toBe(false);
  });

  it('heartbeat age reflects the last stamp; absent → +Infinity', async () => {
    const { counter } = make();
    expect(await counter.heartbeatAgeMs(1_000_000)).toBe(Number.POSITIVE_INFINITY);
    await counter.heartbeatSet(1_000_000, 360_000);
    expect(await counter.heartbeatAgeMs(1_000_050)).toBe(50);
  });

  it('propagates a bounded-connection fault to the caller (treated as unavailable)', async () => {
    const { counter, conn } = make();
    conn.failNext = true;
    await expect(counter.read(['k1'])).rejects.toThrow();
  });
});
