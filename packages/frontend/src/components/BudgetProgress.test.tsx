import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { describe, expect, it } from 'vitest';
import { AppProvider } from '../state/context';
import { createAppStore } from '../state/appState';
import { FakeApiClient } from '../test/fakeClient';
import { fakeBudgetProgress } from '../test/budgetProgressFixture';
import type { BudgetProgressEntry } from '../data/budgetProgress';
import { BudgetProgress } from './BudgetProgress';
import { budgetChartData } from './BudgetChart';
import type { BudgetDto } from '../data/api';

const budget: BudgetDto = {
  id: 'b',
  name: 'Global Daily Cap',
  scope: 'agent',
  agentId: 'lobe',
  window: 'day',
  action: 'block',
  meteringBasis: 'cash',
  amount: 25,
  enabled: true,
  notifyChannelIds: [],
  createdAt: '2026-10-08T00:00:00.000Z',
};
const asOf = '2026-10-08T12:00:00.000Z';
describe('Budget progress presentation', () => {
  function mount(entry: BudgetProgressEntry, b = budget) {
    const host = document.createElement('div');
    document.body.append(host);
    const store = createAppStore(new FakeApiClient());
    const [now, setNow] = createSignal(100);
    const dispose = render(
      () => (
        <AppProvider store={store}>
          <BudgetProgress
            budget={b}
            scope="Agent · Lobechat"
            entry={entry}
            now={now()}
            retry={() => {}}
          />
        </AppProvider>
      ),
      host,
    );
    return {
      host,
      store,
      setNow,
      dispose: () => {
        dispose();
        host.remove();
      },
    };
  }
  const entry = (spent = 12400000, pending = 3000000, b = budget): BudgetProgressEntry => ({
    snapshot: fakeBudgetProgress(b, asOf, spent, pending),
    asOf,
    receivedAt: 100,
    durationMs: 0,
    error: null,
    loading: false,
  });
  it('gives the graph a named text equivalent, exact allowance and null future spend', () => {
    const e = entry();
    const view = mount(e);
    expect(view.host.textContent).toContain('$12.40');
    expect(view.host.textContent).toContain('49.6%');
    expect(view.host.textContent).toContain('$12.60 remaining');
    expect(view.host.textContent).toContain('$9.60');
    expect(view.host.querySelector('figure')?.getAttribute('aria-label')).toBe(
      'Global Daily Cap recorded budget progress',
    );
    expect(view.host.textContent).toContain('Agent · Lobechat');
    expect(view.host.textContent).toContain('UTC');
    expect(view.host.querySelector('[aria-live]')).toBeNull();
    const data = budgetChartData(e.snapshot!);
    expect(data[1]!.at(-1)).toBeNull();
    expect(data[2]!.at(-1)).toBe(25);
    view.store.toggleTheme();
    expect(view.host.querySelectorAll('.uplot')).toHaveLength(1);
    view.dispose();
    expect(view.host.querySelector('.uplot')).toBeNull();
  });
  it('does not turn unavailable/expired data into a zero allowance', () => {
    const failed = mount({ loading: false, error: 'Budget progress is temporarily unavailable' });
    expect(failed.host.textContent).toContain('Retry progress');
    expect(failed.host.textContent).not.toContain('$0.00');
    failed.dispose();
    const expired = mount(entry());
    expired.setNow(86400100);
    expect(expired.host.textContent).toContain('Period ended');
    expect(expired.host.textContent).not.toContain('remaining');
    expired.dispose();
  });
  it('shows stale retained data, unpriced/estimated provenance, and free versus no activity', () => {
    const e = entry(0, 0);
    e.snapshot!.provenance = {
      meteredRows: 4,
      unpricedRows: 1,
      unknownSpendMicros: 1,
      usageEstimated: true,
      priceEstimated: true,
    };
    e.error = 'refresh failed';
    const v = mount(e);
    expect(v.host.textContent).toContain('unpriced');
    expect(v.host.textContent).toContain('estimated pricing');
    expect(v.host.textContent).toContain('Stale recorded progress');
    expect(v.host.textContent).not.toContain('No metered activity');
    v.dispose();
    const empty = mount(entry(0, 0));
    expect(empty.host.textContent).toContain('No metered activity');
    empty.dispose();
  });
  it('renders soft overages, notional/alert/disabled state and precision limits honestly', () => {
    for (const b of [
      budget,
      { ...budget, action: 'alert', meteringBasis: 'notional' },
      { ...budget, enabled: false },
    ]) {
      const v = mount(entry(26500000, 0, b), b);
      expect(v.host.textContent).toContain('106%');
      expect(v.host.textContent).toContain('$1.50 over budget');
      expect(v.host.textContent).not.toMatch(/blocked|delivered|enforcement healthy/);
      v.dispose();
    }
    const tiny = { ...budget, amount: 0.0000001 };
    const v = mount(entry(1, 0, tiny), tiny);
    expect(v.host.textContent).toContain('below metering precision');
    expect(v.host.textContent).toContain('<$0.01');
    expect(v.host.textContent).not.toMatch(/Infinity|NaN|0%/);
    v.dispose();
  });
});
