import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBudgetProgressLoader,
  progressClock,
  type BudgetProgressEntry,
} from './budgetProgress';
import { realClient, type BudgetDto } from './api';
import { FakeApiClient } from '../test/fakeClient';
import { fakeBudgetProgress } from '../test/budgetProgressFixture';
import type { BudgetProgressResponse } from '@polyrouter/shared';

export const budget: BudgetDto = {
  id: 'budget-a',
  name: 'Daily cap',
  scope: 'agent',
  agentId: 'a',
  window: 'day',
  action: 'block',
  meteringBasis: 'cash',
  amount: 25,
  notifyChannelIds: [],
  enabled: true,
  createdAt: '2026-10-08T00:00:00.000Z',
};
const asOf = '2026-10-08T12:00:00.000Z';
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('budget progress transport', () => {
  it('encodes ids, bounds input and keeps endpoint errors distinct from missing results', async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ asOf, results: [{ id: 'b/a', availability: 'not_found' }] }),
            { status: 200 },
          ),
        ),
      );
    vi.stubGlobal('fetch', fetcher);
    expect((await realClient.budgetProgress(['b/a'])).results[0]).toEqual({
      id: 'b/a',
      availability: 'not_found',
    });
    expect(String(fetcher.mock.calls[0]![0])).toContain('ids=b%2Fa');
    await realClient.budgetProgress(Array.from({ length: 20 }, (_, i) => `b${i}`));
    for (const ids of [
      [],
      ['a', 'a'],
      [''],
      ['x'.repeat(129)],
      Array.from({ length: 21 }, (_, i) => `b${i}`),
    ])
      await expect(realClient.budgetProgress(ids)).rejects.toMatchObject({ status: 400 });
    fetcher.mockResolvedValue(
      new Response(JSON.stringify({ message: 'secret backend failure' }), { status: 404 }),
    );
    await expect(realClient.budgetProgress(['b'])).rejects.toMatchObject({
      status: 404,
      message: 'Budget progress is temporarily unavailable',
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

function harness(count = 1) {
  let budgets = Array.from({ length: count }, (_, i) => ({ ...budget, id: `b${i}` }));
  const client = new FakeApiClient({ budgets });
  const entries: Record<string, BudgetProgressEntry> = {};
  let identity = 0;
  let active = true;
  const reconcile = vi.fn(() => {
    budgets = client.budgets;
    return Promise.resolve();
  });
  const loader = createBudgetProgressLoader({
    client,
    budgets: () => budgets,
    entries: () => entries,
    set: (id, e) => {
      if (e) entries[id] = e;
      else delete entries[id];
    },
    identity: () => identity,
    active: () => active,
    reconcile,
  });
  const reply = (ids: readonly string[]): BudgetProgressResponse => ({
    asOf,
    results: ids.map((id) =>
      fakeBudgetProgress(
        budgets.find((b) => b.id === id)!,
        asOf,
        12400000,
        3000000,
      ),
    ),
  });
  return {
    client,
    entries,
    loader,
    reply,
    reconcile,
    setBudgets: (b: BudgetDto[]) => {
      budgets = b;
      client.budgets = b;
    },
    identity: () => {
      identity++;
      loader.cancel();
    },
    hide: () => {
      active = false;
      loader.cancel();
    },
  };
}

describe('single-flight progress lifecycle', () => {
  it('keeps per-chunk snapshot times rather than assigning one page-wide time', async () => {
    const h = harness(21);
    let calls = 0;
    h.client.progressReply = (ids) => {
      const response = h.reply(ids);
      const stamp = ++calls === 1 ? asOf : '2026-10-08T12:05:00.000Z';
      return Promise.resolve({
        ...response,
        asOf: stamp,
        results: response.results.map((r) =>
          r.availability === 'available' ? fakeBudgetProgress(r.budget, stamp, 12400000) : r,
        ),
      });
    };
    await h.loader.load();
    expect(h.entries.b0!.asOf).toBe(asOf);
    expect(h.entries.b20!.asOf).toBe('2026-10-08T12:05:00.000Z');
  });
  it('chunks 45 cards sequentially, maps by id and isolates a failed middle chunk', async () => {
    const h = harness(45);
    let calls = 0;
    let inFlight = 0;
    h.client.progressReply = async (ids) => {
      expect(++inFlight).toBe(1);
      const n = ++calls;
      await Promise.resolve();
      inFlight--;
      if (n === 2) throw new Error('fault');
      return { ...h.reply(ids), results: h.reply(ids).results.reverse() };
    };
    await h.loader.load();
    expect(
      h.client.callLog
        .filter((c) => c.method === 'budgetProgress')
        .map((c) => (c.args[0] as string[]).length),
    ).toEqual([20, 20, 5]);
    expect(h.entries.b0!.snapshot!.id).toBe('b0');
    expect(h.entries.b20!.snapshot).toBeUndefined();
    expect(h.entries.b44!.snapshot!.spentMicros).toBe(12400000);
  });
  it('coalesces forced work and suppresses scheduled overlap during a slow request', async () => {
    const h = harness();
    const hold = deferred<BudgetProgressResponse>();
    let calls = 0;
    h.client.progressReply = async (ids) => (++calls === 1 ? hold.promise : h.reply(ids));
    const run = h.loader.load();
    for (let i = 0; i < 10; i++) {
      void h.loader.load();
      void h.loader.load(true);
    }
    expect(calls).toBe(1);
    hold.resolve(h.reply(['b0']));
    await run;
    expect(calls).toBe(2);
  });
  it.each(['scope', 'agentId', 'meteringBasis', 'window', 'amount', 'action', 'enabled'] as const)(
    'rejects replies crossing a %s edit',
    async (field) => {
      const h = harness();
      const hold = deferred<BudgetProgressResponse>();
      const old = h.reply(['b0']);
      let first = true;
      h.client.progressReply = async (ids) => {
        if (first) {
          first = false;
          return hold.promise;
        }
        return h.reply(ids);
      };
      const run = h.loader.load();
      const values = {
        scope: 'global',
        agentId: 'other',
        meteringBasis: 'notional',
        window: 'month',
        amount: 50,
        action: 'alert',
        enabled: false,
      };
      h.setBudgets([{ ...budget, id: 'b0', [field]: values[field] }]);
      h.loader.cancel(['b0']);
      void h.loader.load(true);
      hold.resolve(old);
      await run;
      expect(h.entries.b0!.snapshot!.budget[field]).toBe(values[field]);
    },
  );
  it('does not revive deleted or old-identity cards and drops queued off-page work', async () => {
    const h = harness();
    const hold = deferred<BudgetProgressResponse>();
    h.client.progressReply = () => hold.promise;
    const run = h.loader.load();
    const old = h.reply(['b0']);
    h.identity();
    h.setBudgets([]);
    h.hide();
    void h.loader.load(true);
    hold.resolve(old);
    await run;
    expect(h.entries.b0!.snapshot).toBeUndefined();
    expect(h.client.calls.filter((c) => c === 'budgetProgress')).toHaveLength(1);
  });
  it('reconciles missing/configuration mismatches once without an endless loop', async () => {
    const h = harness();
    h.client.progressReply = () =>
      Promise.resolve({ asOf, results: [{ id: 'b0', availability: 'not_found' }] });
    await h.loader.load();
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    expect(h.entries.b0!.snapshot).toBeUndefined();
    expect(h.client.calls.filter((c) => c === 'budgetProgress')).toHaveLength(2);
  });
  it('reconciles a cross-tab edit and a subsequent deletion without attaching obsolete figures', async () => {
    const h = harness();
    let first = true;
    const updated = { ...budget, id: 'b0', amount: 50 };
    h.client.budgets = [updated];
    h.client.progressReply = (ids) => {
      if (first) {
        first = false;
        return Promise.resolve({ asOf, results: [fakeBudgetProgress(updated, asOf, 12400000)] });
      }
      return Promise.resolve(h.reply(ids));
    };
    await h.loader.load();
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    expect(h.entries.b0!.snapshot!.budget.amount).toBe(50);
    h.client.budgets = [];
    h.client.progressReply = () =>
      Promise.resolve({ asOf, results: [{ id: 'b0', availability: 'not_found' }] });
    await h.loader.load();
    expect(h.entries.b0!.snapshot).toBeUndefined();
    expect(h.reconcile).toHaveBeenCalledTimes(2);
  });
  it('retains the original successful snapshot and timestamp on a refresh error', async () => {
    const h = harness();
    h.client.progressReply = (ids) => Promise.resolve(h.reply(ids));
    await h.loader.load();
    const timestamp = h.entries.b0!.receivedAt;
    h.client.progressReply = () => Promise.reject(new Error('private'));
    await h.loader.load();
    expect(h.entries.b0!.asOf).toBe(asOf);
    expect(h.entries.b0!.receivedAt).toBe(timestamp);
    expect(progressClock(h.entries.b0!).stale).toBe(true);
    const held = deferred<BudgetProgressResponse>();
    h.client.progressReply = () => held.promise;
    const retry = h.loader.load();
    expect(progressClock(h.entries.b0!).stale).toBe(true);
    expect(h.entries.b0!.receivedAt).toBe(timestamp);
    held.resolve(h.reply(['b0']));
    await retry;
    expect(h.entries.b0!.error).toBeNull();
  });
});

it('uses server-relative monotonic age through wall-clock skew and UTC rollover', () => {
  vi.spyOn(Date, 'now').mockReturnValue(0);
  const entry: BudgetProgressEntry = {
    snapshot: fakeBudgetProgress(budget, '2026-10-08T23:59:59.000Z'),
    asOf: '2026-10-08T23:59:59.000Z',
    receivedAt: 100,
    durationMs: 500,
    loading: false,
    error: null,
  };
  expect(progressClock(entry, 101).expired).toBe(false);
  expect(progressClock(entry, 601).expired).toBe(true);
  expect(progressClock(entry, 45101).stale).toBe(true);
});
