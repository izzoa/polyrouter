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
    // A failed read with no retained snapshot is the Failed state, in its own words
    // (adopt-figure-states D5, D6; U+2019), never the API's message and never zeros.
    const failed = mount({ loading: false, error: 'Budget progress is temporarily unavailable' });
    expect(failed.host.querySelector('.budget-progress-status p')?.textContent).toBe(
      'Budget progress couldn’t be loaded.',
    );
    expect(failed.host.textContent).not.toContain('temporarily unavailable');
    expect(failed.host.textContent).toContain('Retry progress');
    expect(failed.host.textContent).not.toContain('$0.00');
    expect(failed.host.textContent).not.toContain('stale');
    failed.dispose();
    // A configuration mismatch keeps its own wait, not the failure copy.
    const waiting = mount({ loading: false, error: 'Awaiting current budget configuration' });
    expect(waiting.host.textContent).toContain('Awaiting current budget configuration');
    expect(waiting.host.textContent).not.toContain('couldn’t be loaded');
    waiting.dispose();
    const expired = mount(entry());
    expired.setNow(86400100);
    expect(expired.host.querySelector('.budget-progress-status p')?.textContent).toBe(
      'expired · awaiting refresh',
    );
    expect(expired.host.textContent).not.toContain('Period ended');
    expect(expired.host.textContent).not.toContain('remaining');
    expired.dispose();
  });

  it('first load is a named skeleton, never `Loading…` text, a dash or a zero', () => {
    for (const e of [{ loading: true, error: null }, undefined] as const) {
      const host = document.createElement('div');
      document.body.append(host);
      const store = createAppStore(new FakeApiClient());
      const dispose = render(
        () => (
          <AppProvider store={store}>
            <BudgetProgress budget={budget} scope="Global" entry={e} now={100} retry={() => {}} />
          </AppProvider>
        ),
        host,
      );
      const status = host.querySelector('.budget-progress-status p')!;
      expect([...status.querySelectorAll('.sr-only')].map((n) => n.textContent)).toEqual([
        'Loading budget progress',
      ]);
      const block = status.querySelector('.fig-skel');
      expect(block?.getAttribute('aria-hidden')).toBe('true');
      expect(host.textContent).not.toContain('Loading budget progress…');
      expect(host.textContent).not.toMatch(/\$0\.00|—/);
      dispose();
      host.remove();
    }
  });

  it('a snapshot 46 seconds old reads `as of 14:02 · stale` in amber, with Retry', () => {
    const at = '2026-10-08T14:02:00.000Z';
    const e: BudgetProgressEntry = {
      snapshot: fakeBudgetProgress(budget, at, 12400000, 0),
      asOf: at,
      receivedAt: 100,
      durationMs: 0,
      error: null,
      loading: false,
    };
    const v = mount(e);
    const freshness = (): string => v.host.querySelector('.budget-freshness')?.textContent ?? '';
    // Fresh: the snapshot's time, in full.
    expect(freshness()).toContain('Updated 2026-10-08 14:02:00 UTC');
    expect(freshness()).not.toContain('stale');
    v.setNow(100 + 46_000);
    const caption = v.host.querySelector<HTMLElement>('[data-testid="budget-stale"]')!;
    expect(caption.textContent).toBe('as of 14:02 · stale');
    expect(caption.style.color).toBe('var(--amber-text)');
    // One freshness line: the UTC reset time, then the caption that replaces `Updated …`.
    expect(freshness()).toMatch(/^Resets 2026-10-09 00:00:00 UTC · as of 14:02 · stale$/);
    expect(v.host.textContent).not.toMatch(/Stale recorded progress|Refresh failed|Updated/);
    expect(v.host.textContent).toContain('Retry progress');
    // The figures stay in Ink: the card keeps them.
    expect(v.host.textContent).toContain('$12.40');
    v.dispose();
  });

  it('a failed refresh keeps the snapshot time and reads the same stale caption', () => {
    const at = '2026-10-08T14:02:00.000Z';
    const e: BudgetProgressEntry = {
      snapshot: fakeBudgetProgress(budget, at, 12400000, 0),
      asOf: at,
      receivedAt: 100,
      durationMs: 0,
      // Fresh by age, failed by its refresh.
      error: 'Budget progress is temporarily unavailable',
      loading: false,
    };
    const v = mount(e);
    expect(v.host.querySelector('[data-testid="budget-stale"]')?.textContent).toBe(
      'as of 14:02 · stale',
    );
    expect(v.host.textContent).not.toMatch(/Refresh failed|Stale recorded progress|Updated/);
    expect(v.host.textContent).not.toContain('couldn’t be loaded');
    expect(v.host.textContent).toContain('$12.40');
    v.dispose();
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
    expect(v.host.textContent).toContain('as of 12:00 · stale');
    expect(v.host.textContent).not.toMatch(/Stale recorded progress|Refresh failed/);
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
      // The overage reads as over budget, in red status text (adopt-figure-states D5).
      const over = v.host.querySelector<HTMLElement>('[data-testid="budget-over"]')!;
      expect(over.textContent).toBe('$1.50 over budget');
      expect(over.style.color).toBe('var(--red-text)');
      expect(v.host.textContent).not.toMatch(/blocked|delivered|enforcement healthy/);
      // A disabled budget names its state on the same allowance line, never `blocked`.
      const allowance = v.host.querySelector('.budget-allowance')!.textContent ?? '';
      if (!b.enabled) expect(allowance).toBe('$1.50 over budget · Budget disabled');
      else expect(allowance).not.toContain('Budget disabled');
      v.dispose();
    }
    const tiny = { ...budget, amount: 0.0000001 };
    const v = mount(entry(1, 0, tiny), tiny);
    // The configured amount goes through the shared formatter at cents, as the card's
    // configured line does: `<$0.01`, never the raw `1e-7 USD` (dashboard-core "A non-zero
    // amount never prints as zero").
    const precision = [...v.host.querySelectorAll('p')].find((p) =>
      p.textContent?.includes('below metering precision'),
    );
    expect(precision?.textContent?.replace(/\s+/g, ' ')).toBe(
      'Configured amount <$0.01 is below metering precision.',
    );
    expect(v.host.textContent).not.toMatch(/1e-7|USD/);
    expect(v.host.textContent).toContain('<$0.01');
    expect(v.host.textContent).not.toMatch(/Infinity|NaN|0%/);
    v.dispose();
  });
});
