import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { AppProvider } from './state/context';
import { createAppStore, type AppStore } from './state/appState';
import { DEFAULT_SESSION, FakeApiClient } from './test/fakeClient';
import { fakeBudgetProgress } from './test/budgetProgressFixture';
import type { BudgetDto } from './data/api';
import type { BudgetProgressResponse } from '@polyrouter/shared';
import type { EventSourceLike } from './data/eventStream';
import { ApiError } from './data/api';
import { openAutoTab } from './test/routingTabs';

const budget: BudgetDto = {
  id: 'a-budget',
  name: 'Owner A daily cap',
  scope: 'global',
  agentId: null,
  amount: 25,
  window: 'day',
  action: 'block',
  meteringBasis: 'cash',
  enabled: true,
  notifyChannelIds: [],
  createdAt: '2026-10-08T00:00:00.000Z',
};
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
};
function visible(v: boolean) {
  Object.defineProperty(document, 'visibilityState', {
    value: v ? 'visible' : 'hidden',
    configurable: true,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}
class Source implements EventSourceLike {
  onerror: ((this: unknown, e: Event) => unknown) | null = null;
  listeners = new Map<string, ((e: MessageEvent<string>) => void)[]>();
  addEventListener(t: string, fn: (e: MessageEvent<string>) => void) {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), fn]);
  }
  close() {}
  emit(t: string) {
    for (const fn of this.listeners.get(t) ?? []) fn({ data: '{}' } as MessageEvent<string>);
  }
}
function mount(store: AppStore) {
  const host = document.createElement('div');
  document.body.append(host);
  const dispose = render(
    () => (
      <AppProvider store={store}>
        <App live={true} />
      </AppProvider>
    ),
    host,
  );
  return {
    host,
    dispose: () => {
      dispose();
      host.remove();
    },
  };
}
describe('Limits progress integrated lifecycle', () => {
  beforeEach(() => {
    visible(true);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    visible(true);
    localStorage.clear();
    document.body.innerHTML = '';
  });
  async function boot(client = new FakeApiClient({ budgets: [budget] })) {
    const store = createAppStore(client);
    store.go('limits');
    const source = new Source();
    store.setStreamFactory(() => source);
    const view = mount(store);
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    return { client, store, source, ...view };
  }
  it('shares the 15s floor across real analytics/batch callbacks, polls, visibility and navigation', async () => {
    const v = await boot();
    try {
      expect(v.client.countOf('budgetProgress')).toBe(1);
      for (let i = 0; i < 100; i++) {
        v.source.emit('analytics.invalidated');
        v.source.emit('batch.updated');
      }
      await flush();
      expect(v.client.countOf('budgetProgress')).toBe(1);
      await vi.advanceTimersByTimeAsync(14999);
      await flush();
      expect(v.client.countOf('budgetProgress')).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(v.client.countOf('budgetProgress')).toBe(2);
      v.source.onerror?.call(v.source, new Event('error'));
      await vi.advanceTimersByTimeAsync(15000);
      await flush();
      expect(v.client.countOf('budgetProgress')).toBe(3);
      visible(false);
      await vi.advanceTimersByTimeAsync(60000);
      await flush();
      expect(v.client.countOf('budgetProgress')).toBe(3);
      visible(true);
      await flush();
      expect(v.client.countOf('budgetProgress')).toBe(4);
      v.store.go('agents');
      await flush();
      await vi.advanceTimersByTimeAsync(30000);
      await flush();
      expect(v.client.countOf('budgetProgress')).toBe(4);
      v.store.go('limits');
      await flush();
      expect(v.client.countOf('budgetProgress')).toBe(5);
    } finally {
      v.dispose();
    }
  });
  it('coalesces retry/resume during a slow read and never overlaps requests', async () => {
    const v = await boot();
    try {
      const hold = deferred<BudgetProgressResponse>();
      let calls = 0;
      v.client.progressReply = async (ids) => {
        calls++;
        if (calls === 1) return hold.promise;
        return {
          asOf: new Date().toISOString(),
          results: ids.map(() => fakeBudgetProgress(budget, new Date().toISOString(), 12400000)),
        };
      };
      const run = v.store.loadBudgetProgress(true);
      await flush();
      for (let i = 0; i < 10; i++) void v.store.loadBudgetProgress(true);
      await vi.advanceTimersByTimeAsync(30000);
      await flush();
      expect(calls).toBe(1);
      visible(false);
      visible(true);
      await flush();
      expect(calls).toBe(1);
      const asOf = new Date().toISOString();
      hold.resolve({ asOf, results: [fakeBudgetProgress(budget, asOf)] });
      await run;
      await flush();
      expect(calls).toBe(2);
    } finally {
      v.dispose();
    }
  });
  it.each(['success', 'failure'])(
    'discards held old-owner configuration, labels and progress %s completions',
    async (outcome) => {
      const v = await boot();
      try {
        v.client.gateReads = true;
        const cfg = v.store.loadLimits();
        await flush();
        const hold = deferred<BudgetProgressResponse>();
        v.client.progressReply = () => hold.promise;
        const read = v.store.loadBudgetProgress(true);
        await flush();
        v.client.gateReads = false;
        v.client.budgets = [];
        v.client.agents = [];
        v.client.channels = [];
        v.client.session = { ...DEFAULT_SESSION, userId: 'owner-B' };
        await v.store.bootstrap();
        await flush();
        expect(v.store.state.budgetProgress).toEqual({});
        expect(v.host.textContent).not.toContain(budget.name);
        v.client.openGate();
        const asOf = new Date().toISOString();
        if (outcome === 'failure') hold.reject(new Error('old-owner-error'));
        else hold.resolve({ asOf, results: [fakeBudgetProgress(budget, asOf, 74000000)] });
        await Promise.all([cfg, read]);
        await flush();
        expect(v.store.state.budgets).toEqual([]);
        expect(v.store.state.budgetProgress).toEqual({});
        expect(v.store.state.budgetsLoading).toBe(false);
        expect(v.host.textContent).not.toMatch(/Owner A|74.00|old-owner-error/);
      } finally {
        v.dispose();
      }
    },
  );
  it('invalidates a held edit at start, suppresses polling it, and reconciles failure before refresh', async () => {
    const v = await boot();
    try {
      const hold = deferred<BudgetDto>();
      vi.spyOn(v.client, 'updateBudget').mockReturnValue(hold.promise);
      v.store.openBudget(budget);
      v.store.setState('bf', 'amount', '50');
      const write = v.store.saveBudget();
      await flush();
      expect(v.store.state.budgetProgress[budget.id]).toBeUndefined();
      const before = v.client.countOf('budgetProgress');
      await v.store.loadBudgetProgress(true);
      expect(v.client.countOf('budgetProgress')).toBe(before);
      hold.reject(new Error('write rejected'));
      await write;
      await flush();
      expect(v.store.state.budgets[0]!.amount).toBe(25);
      expect(v.store.state.budgetProgress[budget.id]!.snapshot!.budget.amount).toBe(25);
      expect(v.store.state.bf.error).toContain('write rejected');
    } finally {
      v.dispose();
    }
  });
  it('retires an old-owner mutation completion without a toast or dialog write', async () => {
    const v = await boot();
    try {
      const hold = deferred<BudgetDto>();
      vi.spyOn(v.client, 'updateBudget').mockReturnValue(hold.promise);
      v.store.openBudget(budget);
      v.store.setState('bf', 'amount', '50');
      const write = v.store.saveBudget();
      await flush();
      v.client.budgets = [];
      v.client.session = { ...DEFAULT_SESSION, userId: 'owner-B' };
      await v.store.bootstrap();
      v.store.openBudget();
      v.store.setState('bf', 'name', 'B draft');
      hold.resolve({ ...budget, amount: 50 });
      await write;
      await flush();
      expect(v.store.state.bf.name).toBe('B draft');
      expect(v.store.state.modal).toBe('newLimit');
      expect(v.store.state.toast?.text).not.toBe('Budget updated');
      expect(v.store.state.budgets).toEqual([]);
    } finally {
      v.dispose();
    }
  });
  it('does not revive or announce an update after the edited budget is deleted', async () => {
    const v = await boot();
    try {
      const hold = deferred<BudgetDto>();
      vi.spyOn(v.client, 'updateBudget').mockReturnValue(hold.promise);
      v.store.openBudget(budget);
      v.store.setState('bf', 'amount', '50');
      const write = v.store.saveBudget();
      await flush();
      await v.store.deleteBudget(budget.id);
      expect(v.store.state.toast).toEqual({ kind: 'confirm', text: 'Budget deleted' });
      hold.resolve({ ...budget, amount: 50 });
      await write;
      await flush();
      expect(v.store.state.budgets).toEqual([]);
      expect(v.store.state.budgetProgress[budget.id]).toBeUndefined();
      expect(v.store.state.toast).toEqual({ kind: 'confirm', text: 'Budget deleted' });
    } finally {
      v.dispose();
    }
  });
  it('expires a prior period even when its last chunk returns after UTC reset', async () => {
    let monotonic = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
    const v = await boot();
    try {
      const hold = deferred<BudgetProgressResponse>();
      v.client.progressReply = () => hold.promise;
      const run = v.store.loadBudgetProgress(true);
      await flush();
      monotonic = 3100;
      const asOf = '2026-10-08T23:59:59.000Z';
      hold.resolve({ asOf, results: [fakeBudgetProgress(budget, asOf, 12400000)] });
      await run;
      await vi.advanceTimersByTimeAsync(1000);
      await flush();
      expect(v.host.textContent).toContain('expired · awaiting refresh');
      expect(v.host.textContent).not.toContain('Period ended');
      expect(v.host.textContent).not.toContain('$12.60 remaining');
      expect(v.host.querySelector('.budget-figure')).toBeNull();
    } finally {
      v.dispose();
    }
  });
  it('the no-snapshot Retry leaves focus on its card’s progress region while the reload runs and after it commits (adopt-figure-states 5.4)', async () => {
    const client = new FakeApiClient({ budgets: [budget] });
    client.progressReply = () => Promise.reject(new Error('progress down'));
    const v = await boot(client);
    try {
      const card = v.host.querySelector<HTMLElement>('article.budget-card')!;
      const region = card.querySelector<HTMLElement>('[data-testid="budget-progress"]')!;
      expect(card.querySelector('.budget-progress-status p')?.textContent).toBe(
        'Budget progress couldn’t be loaded.',
      );
      expect(region.getAttribute('tabindex')).toBe('-1');
      const hold = deferred<BudgetProgressResponse>();
      client.progressReply = () => hold.promise;
      const retry = [...card.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.textContent?.trim() === 'Retry progress',
      )!;
      retry.focus();
      expect(document.activeElement).toBe(retry);
      retry.click();
      await flush();
      // The Retry is hidden while its reload runs; focus is on the region, not <body>.
      expect(retry.isConnected).toBe(false);
      expect(card.querySelector('.budget-progress-status .sr-only')?.textContent).toBe(
        'Loading budget progress',
      );
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(region);
      const asOf = new Date().toISOString();
      hold.resolve({ asOf, results: [fakeBudgetProgress(budget, asOf, 12400000)] });
      await flush();
      await vi.advanceTimersByTimeAsync(0);
      await flush();
      expect(card.textContent).toContain('$12.40');
      expect(document.activeElement).toBe(region);
    } finally {
      v.dispose();
    }
  });

  // The loader marks a card loading only when that card's 20-budget chunk starts, so the 21st
  // card's Retry unmounts one chunk later than the click. The hand-off must follow the unmount.
  it('the no-snapshot Retry on a card in a later chunk still hands focus to its region when the button goes', async () => {
    const budgets: BudgetDto[] = Array.from({ length: 21 }, (_, i) => ({
      ...budget,
      id: `b-${String(i + 1).padStart(2, '0')}`,
      name: `Budget ${String(i + 1)}`,
    }));
    const client = new FakeApiClient({ budgets });
    client.progressReply = () => Promise.reject(new Error('progress down'));
    const v = await boot(client);
    try {
      const card = [...v.host.querySelectorAll<HTMLElement>('article.budget-card')].find((c) =>
        c.textContent?.includes('Budget 21'),
      )!;
      expect(card.querySelector('.budget-progress-status p')?.textContent).toBe(
        'Budget progress couldn’t be loaded.',
      );
      const region = card.querySelector<HTMLElement>('[data-testid="budget-progress"]')!;
      const chunks: {
        ids: readonly string[];
        d: ReturnType<typeof deferred<BudgetProgressResponse>>;
      }[] = [];
      client.progressReply = (ids) => {
        const d = deferred<BudgetProgressResponse>();
        chunks.push({ ids, d });
        return d.promise;
      };
      const retry = [...card.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.textContent?.trim() === 'Retry progress',
      )!;
      retry.focus();
      retry.click();
      await flush();
      // The first chunk (20 budgets) is in flight; this card's Retry is still there.
      expect(chunks.map((c) => c.ids.length)).toEqual([20]);
      expect(retry.isConnected).toBe(true);
      expect(document.activeElement).toBe(retry);
      const asOf = new Date().toISOString();
      chunks[0]!.d.resolve({
        asOf,
        results: budgets.slice(0, 20).map((b) => fakeBudgetProgress(b, asOf, 1_000_000)),
      });
      await flush();
      // The second chunk starts: this card loads, its Retry goes, and focus is on the region.
      expect(chunks.map((c) => c.ids)).toEqual([budgets.slice(0, 20).map((b) => b.id), ['b-21']]);
      expect(retry.isConnected).toBe(false);
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(region);
      chunks[1]!.d.resolve({ asOf, results: [fakeBudgetProgress(budgets[20]!, asOf, 12400000)] });
      await flush();
      await vi.advanceTimersByTimeAsync(0);
      await flush();
      expect(card.textContent).toContain('$12.40');
      expect(document.activeElement).toBe(region);
    } finally {
      v.dispose();
    }
  });

  it('the card’s configured amount reads at cents, never `$0.00`, `$0.005` or `$1e-7` (adopt-figure-states 5.4)', async () => {
    const budgets: BudgetDto[] = [
      { ...budget, id: 'b-25', name: 'Twenty-five', amount: 25 },
      { ...budget, id: 'b-half-cent', name: 'Half a cent', amount: 0.005 },
      { ...budget, id: 'b-tiny', name: 'Tiny', amount: 0.0000001 },
    ];
    const v = await boot(new FakeApiClient({ budgets }));
    try {
      const line = (name: string): string =>
        [...v.host.querySelectorAll<HTMLElement>('article.budget-card')]
          .find((a) => a.getAttribute('aria-label') === name)
          ?.querySelector('[data-testid="budget-config"]')
          ?.textContent?.replace(/\s+/g, ' ')
          .trim() ?? '';
      expect(line('Twenty-five')).toBe('Budget $25.00 / day');
      expect(line('Half a cent')).toBe('Budget <$0.01 / day');
      expect(line('Tiny')).toBe('Budget <$0.01 / day');
      for (const n of ['Half a cent', 'Tiny']) expect(line(n)).not.toMatch(/\$0\.00|\$0\.005|1e-7/);
    } finally {
      v.dispose();
    }
  });
});

describe('a surface that does not retain data never shows stale (adopt-figure-states 5.4)', () => {
  it('the Routing aggregation failure is the failed state, with no stale caption', async () => {
    const fake = new FakeApiClient();
    fake.analyticsFailure = new ApiError(504, 'Gateway Timeout', 'the analytics query timed out');
    const store = createAppStore(fake);
    store.go('routing');
    const host = document.createElement('div');
    document.body.append(host);
    const dispose = render(
      () => (
        <AppProvider store={store}>
          <App live={false} />
        </AppProvider>
      ),
      host,
    );
    const view = {
      host,
      dispose: () => {
        dispose();
        host.remove();
      },
    };
    try {
      for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
      await openAutoTab(view.host);
      const pipeline = view.host.querySelector<HTMLElement>('[data-testid="auto-pipeline"]')!;
      expect(pipeline.querySelector('[data-testid="auto-load-error"]')).not.toBeNull();
      expect(pipeline.textContent).not.toMatch(/stale|as of \d/);
      expect(view.host.querySelector('[data-testid="budget-stale"]')).toBeNull();
    } finally {
      view.dispose();
      document.body.innerHTML = '';
    }
  });
});
