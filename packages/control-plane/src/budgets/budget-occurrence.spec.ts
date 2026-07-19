import type { BudgetRow } from '@polyrouter/shared/server';
import { runBudgetOccurrence } from './budget.scheduler';
import { toMicros } from './period';
import type { SpendCounter } from './spend-counter';
import type { NotificationProducers } from '../producers/notification-producers';
import type { BudgetReader } from '../database/budget.reader';

const MID_DAY = Date.UTC(2026, 2, 15, 12); // inside 2026-03-15
const STALE_MS = 180_000;

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
    createdAt: new Date(MID_DAY),
    ...p,
  };
}

interface SpendCall {
  owner: string;
  agentId: string | null;
  start: number;
  end: number;
}

class FakeCounter {
  store = new Map<string, number>();
  marks = new Set<string>();
  reconciled: { key: string; micros: number }[] = [];
  heartbeats: { now: number; ttl: number }[] = [];
  key(o: string, s: string, sid: string, w: string, p: string): string {
    return `budget:${o}:${s}:${sid}:${w}:${p}`;
  }
  reconcileMax(key: string, micros: number): Promise<number> {
    this.reconciled.push({ key, micros });
    const v = Math.max(this.store.get(key) ?? 0, micros);
    this.store.set(key, v);
    return Promise.resolve(v);
  }
  failMark = false;
  markAlertOnce(key: string): Promise<boolean> {
    if (this.failMark) return Promise.reject(new Error('mark fault'));
    if (this.marks.has(key)) return Promise.resolve(false);
    this.marks.add(key);
    return Promise.resolve(true);
  }
  heartbeatSet(now: number, ttl: number): Promise<void> {
    this.heartbeats.push({ now, ttl });
    return Promise.resolve();
  }
}

function makeReader(
  rows: BudgetRow[],
  spend: number | number[],
  nativeMicros = 0,
): { reader: BudgetReader; calls: SpendCall[] } {
  const calls: SpendCall[] = [];
  let i = 0;
  const reader: BudgetReader = {
    listActiveBudgets: () => Promise.resolve(rows),
    spendMicrosFor: (owner, agentId, start, endExclusive) => {
      calls.push({ owner, agentId, start: start.getTime(), end: endExclusive.getTime() });
      const v = Array.isArray(spend) ? (spend[i++] ?? 0) : spend;
      return Promise.resolve({ micros: v, nativeMicros });
    },
  };
  return { reader, calls };
}

function run(reader: BudgetReader, counter: FakeCounter, budgetAlert = jest.fn(), atMs = MID_DAY) {
  const producers = { budgetAlert } as unknown as NotificationProducers;
  return runBudgetOccurrence(reader, counter as unknown as SpendCounter, producers, atMs, STALE_MS);
}

describe('runBudgetOccurrence (#16)', () => {
  it('groups budgets sharing a key: one ledger scan + one reconcile of the both-ledger sum', async () => {
    const { reader, calls } = makeReader([row({ id: 'a' }), row({ id: 'b' })], toMicros(7));
    const counter = new FakeCounter();
    await run(reader, counter);
    expect(calls).toHaveLength(1); // two budgets, one distinct global/day key
    expect(counter.reconciled).toHaveLength(1);
    expect(counter.reconciled[0]!.micros).toBe(7_000_000);
  });

  it('evaluates the just-closed period at a boundary instant', async () => {
    const { reader, calls } = makeReader([row({})], toMicros(1));
    const counter = new FakeCounter();
    await run(reader, counter, jest.fn(), Date.UTC(2026, 2, 16) - 1); // 03-15 23:59:59.999
    expect(counter.reconciled[0]!.key).toContain(':day:2026-03-15');
    expect(calls[0]!.start).toBe(Date.UTC(2026, 2, 15));
    expect(calls[0]!.end).toBe(Date.UTC(2026, 2, 16));
  });

  it('stamps the reconcile heartbeat once, at the occurrence instant', async () => {
    const { reader } = makeReader([row({})], 0);
    const counter = new FakeCounter();
    await run(reader, counter);
    expect(counter.heartbeats).toEqual([{ now: MID_DAY, ttl: STALE_MS * 2 }]);
  });

  it('is monotonic across occurrences — a lower later snapshot never lowers the counter', async () => {
    const b = row({});
    const counter = new FakeCounter();
    const { reader } = makeReader([b], [toMicros(7), toMicros(3)]);
    await run(reader, counter); // 7
    await run(reader, counter); // 3 — must not lower
    const key = counter.reconciled[0]!.key;
    expect(counter.store.get(key)).toBe(7_000_000);
  });

  it('emits budget_alert once per period for an at/over alert budget (markOnce dedup)', async () => {
    const b = row({ action: 'alert', amount: 5, notifyChannelIds: 'ch1' });
    const counter = new FakeCounter();
    const alert = jest.fn();
    const { reader } = makeReader([b], toMicros(7)); // $7 ≥ $5
    await run(reader, counter, alert);
    await run(reader, counter, alert); // same period → deduped
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0]![0]).toMatchObject({
      ownerUserId: 'u1',
      budgetId: 'b1',
      periodId: '2026-03-15',
      spent: 7_000_000,
      threshold: 5_000_000,
      channelIds: ['ch1'],
    });
  });

  it('an alert over native-priced spend carries spendEstimated: true (add-native-price-fallback)', async () => {
    const b = row({ action: 'alert', amount: 5, notifyChannelIds: 'ch1' });
    const counter = new FakeCounter();
    const alert = jest.fn();
    const { reader } = makeReader([b], toMicros(7), 1_000); // any native-priced component
    await run(reader, counter, alert);
    expect(alert.mock.calls[0]![0]).toMatchObject({ spendEstimated: true });
    // And an all-exact period stays unmarked.
    const alert2 = jest.fn();
    const { reader: r2 } = makeReader([row({ id: 'b2', action: 'alert', amount: 5 })], toMicros(7));
    await run(r2, new FakeCounter(), alert2);
    expect(alert2.mock.calls[0]![0]).toMatchObject({ spendEstimated: false });
  });

  it('a failing alert-dedup marker does NOT abort the occurrence — counters + heartbeat still stamped (E6.3)', async () => {
    const b = row({ action: 'alert', amount: 5, notifyChannelIds: 'ch1' });
    const counter = new FakeCounter();
    counter.failMark = true; // the alert marker faults
    const alert = jest.fn();
    const { reader } = makeReader([b], toMicros(7)); // over threshold → would alert
    await expect(run(reader, counter, alert)).resolves.toBeUndefined(); // did NOT throw
    expect(counter.reconciled).toHaveLength(1); // the counter was still reconciled
    expect(counter.heartbeats).toHaveLength(1); // and the heartbeat was still stamped
    expect(alert).not.toHaveBeenCalled(); // the alert emit was skipped (marker failed), best-effort
  });

  it('does not alert for a block budget or an under-threshold alert budget', async () => {
    const counter = new FakeCounter();
    const alert = jest.fn();
    const block = row({ id: 'blk', action: 'block', amount: 5 });
    const under = row({ id: 'alt', action: 'alert', amount: 100 });
    const { reader } = makeReader([block, under], toMicros(7));
    await run(reader, counter, alert);
    expect(alert).not.toHaveBeenCalled();
  });

  it('attributes an agent-scoped budget by joining on its agentId', async () => {
    const b = row({ scope: 'agent', agentId: 'ag1', amount: 1 });
    const { reader, calls } = makeReader([b], toMicros(2));
    const counter = new FakeCounter();
    await run(reader, counter);
    expect(calls[0]!.agentId).toBe('ag1');
    expect(counter.reconciled[0]!.key).toBe('budget:u1:agent:ag1:day:2026-03-15');
  });
});
