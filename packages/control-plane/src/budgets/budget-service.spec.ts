import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { userPrincipal, type BudgetRow } from '@polyrouter/shared/server';
import { BudgetService, BudgetEnforcementUnavailableError, type BudgetHit } from './budget-service';
import type { BudgetReader } from '../database/budget.reader';
import { BudgetCache } from './budget-cache';
import { SpendCounter } from './spend-counter';
import { NotificationProducers } from '../producers/notification-producers';
import { ProxyMetrics } from '../observability/proxy-metrics';
import { periodInfo, toMicros } from './period';
import type { BudgetsConfig } from './budgets.config';

const NOW = Date.UTC(2026, 2, 15, 12); // fixed instant inside 2026-03-15
const PRINCIPAL = userPrincipal('u1');

const BASE_CFG: BudgetsConfig = {
  redisTimeoutMs: 50,
  reconcileTimeoutMs: 2_000,
  cacheTtlMs: 10_000,
  cacheMax: 5_000,
  failOpen: true,
  schedEnabled: true,
  schedCron: '* * * * *',
  staleMs: 180_000,
};

class FakeConn {
  status = 'ready';
  store = new Map<string, string>();
  failMget = false;
  on(): this {
    return this;
  }
  connect(): Promise<void> {
    return Promise.resolve();
  }
  disconnect(): void {}
  mget(keys: string[]): Promise<(string | null)[]> {
    if (this.failMget) return Promise.reject(new Error('timeout'));
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
}

function row(p: Partial<BudgetRow>): BudgetRow {
  return {
    id: 'b1',
    ownerUserId: 'u1',
    orgId: null,
    name: 'B',
    scope: 'global',
    agentId: null,
    window: 'day',
    action: 'block',
    amount: 10,
    notifyChannelIds: '',
    enabled: true,
    createdAt: new Date(NOW),
    ...p,
  };
}

function make(
  rows: BudgetRow[],
  failOpen = true,
  spendMicrosFor: jest.Mock = jest.fn().mockResolvedValue({ micros: 0, nativeMicros: 0 }),
) {
  const conn = new FakeConn();
  const counter = new SpendCounter({ duplicate: () => conn } as unknown as Redis, BASE_CFG);
  const cache = { get: jest.fn().mockResolvedValue(rows) } as unknown as BudgetCache;
  const budgetBlock = jest.fn();
  const producers = { budgetBlock } as unknown as NotificationProducers;
  const metrics = new ProxyMetrics();
  const reader = {
    listActiveBudgets: jest.fn().mockResolvedValue([]),
    spendMicrosFor,
  } as unknown as BudgetReader;
  const svc = new BudgetService(cache, counter, producers, metrics, reader, { ...BASE_CFG, failOpen });
  return { svc, conn, counter, budgetBlock, metrics, spendMicrosFor };
}

/** Seed the shared counter for a budget's current-period key + a fresh heartbeat. */
function seed(conn: FakeConn, counter: SpendCounter, b: BudgetRow, spentMicros: number): void {
  const { periodId } = periodInfo(b.window as 'day' | 'week' | 'month', new Date(NOW));
  const scopeId = b.scope === 'agent' ? (b.agentId ?? 'global') : 'global';
  conn.store.set(
    counter.key(b.ownerUserId, b.scope, scopeId, b.window as 'day', periodId),
    String(spentMicros),
  );
  conn.store.set('budget:reconcile:heartbeat', String(NOW)); // fresh
}

describe('BudgetService.applies', () => {
  it('global applies to any request; agent only to its agent', () => {
    const { svc } = make([]);
    expect(svc.applies(row({ scope: 'global' }), 'a1')).toBe(true);
    expect(svc.applies(row({ scope: 'global' }), null)).toBe(true);
    expect(svc.applies(row({ scope: 'agent', agentId: 'a1' }), 'a1')).toBe(true);
    expect(svc.applies(row({ scope: 'agent', agentId: 'a1' }), 'a2')).toBe(false);
    expect(svc.applies(row({ scope: 'agent', agentId: 'a1' }), null)).toBe(false);
  });
});

describe('BudgetService.checkBlocked', () => {
  beforeAll(() => jest.useFakeTimers({ now: NOW }));
  afterAll(() => jest.useRealTimers());

  it('returns a BudgetHit (spent/period/reset) for an over-threshold block budget', async () => {
    const b = row({ amount: 10 });
    const { svc, conn, counter } = make([b]);
    seed(conn, counter, b, toMicros(10));
    const hit = await svc.checkBlocked(PRINCIPAL, null);
    expect(hit).not.toBeNull();
    expect(hit!.budget.id).toBe('b1');
    expect(hit!.spentMicros).toBe(10_000_000);
    expect(hit!.periodId).toBe('2026-03-15');
    expect(hit!.resetAt.getTime()).toBe(Date.UTC(2026, 2, 16));
  });

  it('returns null under threshold', async () => {
    const b = row({ amount: 10 });
    const { svc, conn, counter } = make([b]);
    seed(conn, counter, b, toMicros(9.99));
    expect(await svc.checkBlocked(PRINCIPAL, null)).toBeNull();
  });

  it('ignores alert/disabled/other-agent budgets', async () => {
    const alert = row({ id: 'a', action: 'alert', amount: 1 });
    const disabled = row({ id: 'd', enabled: false, amount: 1 });
    const otherAgent = row({ id: 'o', scope: 'agent', agentId: 'a2', amount: 1 });
    const { svc, conn, counter } = make([alert, disabled, otherAgent]);
    // even fully-spent, none of these govern a global (agentId=a1) request
    seed(conn, counter, alert, toMicros(100));
    expect(await svc.checkBlocked(PRINCIPAL, 'a1')).toBeNull();
  });

  it('evaluates every budget sharing one counter key', async () => {
    const big = row({ id: 'big', amount: 10 });
    const small = row({ id: 'small', amount: 5 });
    const { svc, conn, counter } = make([big, small]);
    seed(conn, counter, big, toMicros(7)); // same global/day key; $7 crosses $5 not $10
    const hit = await svc.checkBlocked(PRINCIPAL, null);
    expect(hit!.budget.id).toBe('small');
  });

  it('short-circuits to null (no Redis touch) when no block budgets apply', async () => {
    // heartbeat absent (would be stale) but only an alert budget exists → still null
    const { svc } = make([row({ action: 'alert' })]);
    expect(await svc.checkBlocked(PRINCIPAL, null)).toBeNull();
  });

  it('routes a stale/absent reconcile heartbeat through the fail mode', async () => {
    const b = row({ amount: 10 });
    const openSvc = make([b]); // no seed → heartbeat absent
    expect(await openSvc.svc.checkBlocked(PRINCIPAL, null)).toBeNull(); // fail-open allows
    const closed = make([b], false);
    await expect(closed.svc.checkBlocked(PRINCIPAL, null)).rejects.toBeInstanceOf(
      BudgetEnforcementUnavailableError,
    );
  });

  it('routes a Redis read fault through the fail mode (heartbeat fresh)', async () => {
    const b = row({ amount: 10 });
    const open = make([b]);
    seed(open.conn, open.counter, b, toMicros(10));
    open.conn.failMget = true; // heartbeat get still works; the counter read throws
    expect(await open.svc.checkBlocked(PRINCIPAL, null)).toBeNull();

    const closed = make([b], false);
    seed(closed.conn, closed.counter, b, toMicros(10));
    closed.conn.failMget = true;
    await expect(closed.svc.checkBlocked(PRINCIPAL, null)).rejects.toBeInstanceOf(
      BudgetEnforcementUnavailableError,
    );
  });

  // E6.1 — the fault is metered + logged, not silently swallowed.
  it('meters every fault but throttles the warn, and never leaks the error message (fail-open)', async () => {
    const b = row({ amount: 10 });
    const open = make([b]);
    seed(open.conn, open.counter, b, toMicros(10));
    open.conn.failMget = true; // the counter read rejects with Error('timeout')
    const metricSpy = jest.spyOn(open.metrics, 'recordBudgetFault');
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      expect(await open.svc.checkBlocked(PRINCIPAL, null)).toBeNull(); // fail-open still admits
      expect(await open.svc.checkBlocked(PRINCIPAL, null)).toBeNull(); // second fault, same window
      expect(metricSpy).toHaveBeenCalledTimes(2); // metric is UNthrottled
      expect(metricSpy).toHaveBeenCalledWith('open');
      expect(warnSpy).toHaveBeenCalledTimes(1); // warn IS throttled (once per window)
      const msg = String(warnSpy.mock.calls[0]![0]);
      expect(msg).toContain('fail-open');
      expect(msg).toContain('Error'); // the error CLASS is named
      expect(msg).not.toContain('timeout'); // the error MESSAGE (potential data) is not
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('meters the fault with mode="closed" under fail-closed', async () => {
    const b = row({ amount: 10 });
    const closed = make([b], false);
    seed(closed.conn, closed.counter, b, toMicros(10));
    closed.conn.failMget = true;
    const metricSpy = jest.spyOn(closed.metrics, 'recordBudgetFault');
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await expect(closed.svc.checkBlocked(PRINCIPAL, null)).rejects.toBeInstanceOf(
        BudgetEnforcementUnavailableError,
      );
      expect(metricSpy).toHaveBeenCalledWith('closed');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('BudgetService.notifyBlocked', () => {
  it('emits budget_block once per period (deduped by the Redis marker)', async () => {
    const b = row({ amount: 10, notifyChannelIds: 'ch1,ch2' });
    const { svc, budgetBlock } = make([b]);
    const hit: BudgetHit = {
      budget: b,
      spentMicros: toMicros(12),
      periodId: '2026-03-15',
      periodStart: new Date(Date.UTC(2026, 2, 15)),
      resetAt: new Date(Date.UTC(2026, 2, 16)),
    };
    const emit = (
      svc as unknown as { emitBlock: (p: typeof PRINCIPAL, h: BudgetHit) => Promise<void> }
    ).emitBlock;
    await emit.call(svc, PRINCIPAL, hit);
    await emit.call(svc, PRINCIPAL, hit);
    expect(budgetBlock).toHaveBeenCalledTimes(1);
    expect(budgetBlock.mock.calls[0]![0]).toMatchObject({
      ownerUserId: 'u1',
      budgetId: 'b1',
      periodId: '2026-03-15',
      spent: 12_000_000,
      threshold: 10_000_000,
      channelIds: ['ch1', 'ch2'],
    });
  });
});

describe('BudgetService.emitBlock — provenance (add-native-price-fallback)', () => {
  const b = row({ amount: 10 });
  const hit: BudgetHit = {
    budget: b,
    spentMicros: toMicros(12),
    periodId: '2026-03-15',
    periodStart: new Date(Date.UTC(2026, 2, 15)),
    resetAt: new Date(Date.UTC(2026, 2, 16)),
  };
  const emitOf = (svc: BudgetService) =>
    (svc as unknown as { emitBlock: (p: typeof PRINCIPAL, h: BudgetHit) => Promise<void> }).emitBlock;

  it('queries the HIT period bounds (never new Date()) and marks native spend', async () => {
    const spend = jest.fn().mockResolvedValue({ micros: toMicros(12), nativeMicros: 5 });
    const { svc, budgetBlock } = make([b], true, spend);
    await emitOf(svc).call(svc, PRINCIPAL, hit);
    expect(spend).toHaveBeenCalledWith('u1', b.agentId, hit.periodStart, hit.resetAt);
    expect(budgetBlock.mock.calls[0]![0]).toMatchObject({ spendEstimated: true });
  });

  it('a rejected provenance lookup emits spendEstimated: "unknown" — never confirmed-exact', async () => {
    const spend = jest.fn().mockRejectedValue(new Error('reader down'));
    const { svc, budgetBlock } = make([b], true, spend);
    await emitOf(svc).call(svc, PRINCIPAL, hit);
    expect(budgetBlock).toHaveBeenCalledTimes(1); // the emit itself is never lost
    expect(budgetBlock.mock.calls[0]![0]).toMatchObject({ spendEstimated: 'unknown' });
  });

  it('an all-exact period emits spendEstimated: false', async () => {
    const spend = jest.fn().mockResolvedValue({ micros: toMicros(12), nativeMicros: 0 });
    const { svc, budgetBlock } = make([b], true, spend);
    await emitOf(svc).call(svc, PRINCIPAL, hit);
    expect(budgetBlock.mock.calls[0]![0]).toMatchObject({ spendEstimated: false });
  });
});
