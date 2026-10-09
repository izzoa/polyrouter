import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type uPlot from 'uplot';
import { AppProvider } from '../state/context';
import { createAppStore } from '../state/appState';
import { FakeApiClient } from '../test/fakeClient';
import { fakeBudgetProgress } from '../test/budgetProgressFixture';
import type { BudgetDto } from '../data/api';
import { BudgetChart, budgetAxisMoney } from './BudgetChart';

const plots = vi.hoisted(
  () =>
    [] as {
      options: uPlot.Options;
      data: uPlot.AlignedData;
      setData: ReturnType<typeof vi.fn>;
      setSize: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    }[],
);
vi.mock('uplot', () => ({
  default: class {
    static tzDate(date: Date) {
      return date;
    }
    constructor(options: uPlot.Options, data: uPlot.AlignedData) {
      const item = { options, data, setData: vi.fn(), setSize: vi.fn(), destroy: vi.fn() };
      plots.push(item);
      return item;
    }
  },
}));
const budget: BudgetDto = {
  id: 'b',
  name: 'cap',
  scope: 'global',
  agentId: null,
  window: 'day',
  action: 'block',
  meteringBasis: 'cash',
  amount: 25,
  enabled: true,
  notifyChannelIds: [],
  createdAt: '2026-10-08T00:00:00.000Z',
};
afterEach(() => {
  plots.length = 0;
  vi.unstubAllGlobals();
});
describe('budget chart axes and imperative lifecycle', () => {
  it('keeps billion-dollar and positive sub-cent axis ticks readable', () => {
    expect(budgetAxisMoney(1000000000)).toBe('$1B');
    expect(budgetAxisMoney(1250)).toBe('$1.3K');
    expect(budgetAxisMoney(0.005)).toBe('$0.0050');
  });
  it('keeps a zero-based currency axis, full UTC period, overage headroom and no future spend', () => {
    const host = document.createElement('div');
    const store = createAppStore(new FakeApiClient());
    const snapshot = fakeBudgetProgress(budget, '2026-10-08T12:00:00.000Z', 26500000, 3000000);
    const dispose = render(
      () => (
        <AppProvider store={store}>
          <BudgetChart snapshot={snapshot} />
        </AppProvider>
      ),
      host,
    );
    const chart = plots[0]!;
    const xRange = chart.options.scales!.x!.range,
      yRange = chart.options.scales!.y!.range;
    if (typeof xRange !== 'function' || typeof yRange !== 'function')
      throw new Error('Expected explicit range callbacks');
    const self = chart as unknown as uPlot;
    expect(xRange(self, 0, 0, 'x')).toEqual([
      Date.parse(snapshot.period.start) / 1000,
      Date.parse(snapshot.period.end) / 1000,
    ]);
    expect(yRange(self, 0, 0, 'y')).toEqual([0, 26.5 * 1.15]);
    expect(
      (chart.options.axes![1]!.values as (_: unknown, ticks: number[]) => string[])(null, [0, 25]),
    ).toEqual(['$0', '$25']);
    expect(chart.options.series[2]!.dash).toEqual([5, 4]);
    expect(chart.data[1]).toEqual([0, 26.5, null]);
    expect(chart.data[2]).toEqual([25, 25, 25]);
    expect(chart.options.tzDate).toBeDefined();
    dispose();
    expect(chart.destroy).toHaveBeenCalledTimes(1);
  });
  it('supports a single zero point and reuses updates, resizes, re-themes and disconnects', () => {
    let resize = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    const host = document.createElement('div');
    const store = createAppStore(new FakeApiClient());
    const [snapshot, setSnapshot] = createSignal(
      fakeBudgetProgress(budget, '2026-10-08T00:00:00.000Z'),
    );
    const dispose = render(
      () => (
        <AppProvider store={store}>
          <BudgetChart snapshot={snapshot()} />
        </AppProvider>
      ),
      host,
    );
    expect(plots[0]!.data[1]).toEqual([0, null]);
    setSnapshot(fakeBudgetProgress(budget, '2026-10-08T00:10:00.000Z', 1));
    expect(plots).toHaveLength(1);
    expect(plots[0]!.setData).toHaveBeenCalledTimes(1);
    resize();
    expect(plots[0]!.setSize).toHaveBeenCalledTimes(1);
    store.toggleTheme();
    expect(plots).toHaveLength(2);
    expect(plots[0]!.destroy).toHaveBeenCalledTimes(1);
    dispose();
    expect(plots[1]!.destroy).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
