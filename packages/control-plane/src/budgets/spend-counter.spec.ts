import { Redis } from 'ioredis';
import { SpendCounter } from './spend-counter';
import type { BudgetsConfig } from './budgets.config';

const CFG: BudgetsConfig = {
  redisTimeoutMs: 50,
  reconcileTimeoutMs: 2_000,
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
  /** Mirrors RECONCILE_MAX_LUA — including materializing the key at v=0, so a seeded
   * zero is distinguishable from "never reconciled" (split-subscription-spend). Real
   * Redis parity for the script itself is covered by the reconcile e2e. */
  eval(_s: string, _n: number, key: string, micros: string, _ttl: string): Promise<number> {
    const exists = this.store.has(key);
    const cur = Number(this.store.get(key) ?? '0');
    const v = Number(micros);
    if (v > cur || !exists) this.store.set(key, String(v));
    return Promise.resolve(Math.max(cur, v));
  }
}

function make(): { counter: SpendCounter; conn: FakeConn } {
  const conn = new FakeConn();
  const redis = { duplicate: () => conn } as unknown as Redis;
  return { counter: new SpendCounter(redis, CFG), conn };
}

describe('SpendCounter', () => {
  it('materializes a key even when the reconciled total is zero', async () => {
    const { counter, conn } = make();
    const key = counter.key('u1', 'global', 'global', 'day', '2026-03-15', 'cash');
    await counter.reconcileMax(key, 0, 60_000);
    // A MISSING key reads as an authoritative zero, so a seeded-zero counter must exist
    // — otherwise a just-switched budget is indistinguishable from an unreconciled one.
    expect(conn.store.has(key)).toBe(true);
  });

  it('keeps each metering basis on its own counter', async () => {
    const { counter } = make();
    const notional = counter.key('u1', 'global', 'global', 'day', '2026-03-15', 'notional');
    const cash = counter.key('u1', 'global', 'global', 'day', '2026-03-15', 'cash');
    expect(notional).not.toBe(cash);
    // ...and an upgrading deployment finds its existing counter exactly where it left it.
    expect(notional).toBe('budget:u1:global:global:day:2026-03-15');
    await counter.reconcileMax(notional, 9_000_000, 60_000);
    // The monotonic write only ever RAISES a counter, so a switch to a smaller cash
    // total would be pinned at the notional maximum if they shared a key.
    await counter.reconcileMax(cash, 2_000_000, 60_000);
    expect(await counter.read([notional, cash])).toEqual([9_000_000, 2_000_000]);
  });

  it('builds a stable owner/scope/window/period key', () => {
    const { counter } = make();
    // `notional` keeps the LEGACY shape: every budget predating the metering basis
    // meters notional, so namespacing it would strand their counters on upgrade — and a
    // cold key reads as zero spend, silently un-blocking an already-blocked budget.
    expect(counter.key('u1', 'agent', 'a1', 'day', '2026-03-15', 'notional')).toBe(
      'budget:u1:agent:a1:day:2026-03-15',
    );
    // `cash` is a genuinely different quantity and a basis no budget had before, so it
    // gets its own namespace — which is also what keeps the monotonic reconcile from
    // pinning a lowered cash total at the old notional maximum.
    expect(counter.key('u1', 'agent', 'a1', 'day', '2026-03-15', 'cash')).toBe(
      'budget:u1:agent:a1:day:cash:2026-03-15',
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

  it('markBlockOnce/markAlertOnce win exactly once per key', async () => {
    const { counter } = make();
    expect(await counter.markBlockOnce('m', 1000)).toBe(true);
    expect(await counter.markBlockOnce('m', 1000)).toBe(false);
    // the alert marker is an independent key namespace on the write connection
    expect(await counter.markAlertOnce('a', 1000)).toBe(true);
    expect(await counter.markAlertOnce('a', 1000)).toBe(false);
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
