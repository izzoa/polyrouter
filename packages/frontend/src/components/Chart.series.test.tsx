import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type uPlot from 'uplot';
import { AppProvider } from '../state/context';
import { createAppStore } from '../state/appState';
import { FakeApiClient } from '../test/fakeClient';
import { Chart } from './Chart';
import { Icon, ICONS } from './Icon';

/* Series colours, read from the options handed to uPlot (split-auto-routing-readout-setup
 * D11). uPlot is mocked for this whole file, so it lives apart from `Chart.test.tsx`, which
 * mounts the REAL uPlot through the canvas shim. */

const plots = vi.hoisted(() => [] as { options: uPlot.Options }[]);
vi.mock('uplot', () => ({
  default: class {
    static tzDate(date: Date) {
      return date;
    }
    constructor(options: uPlot.Options) {
      const item = { options, setData: vi.fn(), setSize: vi.fn(), destroy: vi.fn() };
      plots.push(item);
      return item;
    }
  },
}));

afterEach(() => {
  plots.length = 0;
});

const DATA: [number[], number[], number[]] = [
  [1, 2],
  [3, 4],
  [5, 6],
];
const SERIES = [{ label: 'high' }, { label: 'low', dash: [6, 3] }];

function chartSeries(props: { accentFirst?: boolean; multi: boolean }): uPlot.Series[] {
  const host = document.createElement('div');
  const dispose = render(
    () => (
      <AppProvider store={createAppStore(new FakeApiClient())}>
        <Chart
          data={DATA}
          {...(props.multi ? { series: SERIES } : {})}
          {...(props.accentFirst === undefined ? {} : { accentFirst: props.accentFirst })}
        />
      </AppProvider>
    ),
    host,
  );
  dispose();
  const plot = plots.at(-1);
  if (plot === undefined) throw new Error('no chart built');
  return plot.options.series;
}

describe('Chart series 0 colour (split-auto-routing-readout-setup D11)', () => {
  it('by default series 0 is the accent, stroke and fill — Overview and BudgetChart rely on it', () => {
    for (const multi of [true, false]) {
      const s0 = chartSeries({ multi })[1];
      expect(s0?.stroke).toBe('#4f5dff');
      expect(s0?.fill).toBe('#eff0ff');
    }
  });

  it('accentFirst: false draws series 0 as a neutral solid line with no fill', () => {
    for (const multi of [true, false]) {
      const s0 = chartSeries({ multi, accentFirst: false })[1];
      expect(s0?.stroke).toBe('#17181a');
      expect(s0?.fill).toBeUndefined();
      expect(s0?.dash).toBeUndefined();
    }
    const series = chartSeries({ multi: true, accentFirst: false });
    expect(JSON.stringify(series)).not.toContain('#4f5dff');
    expect(JSON.stringify(series)).not.toContain('#eff0ff');
  });
});

describe('the jump icon', () => {
  it('is registered and decorative', () => {
    expect(typeof ICONS.jump).toBe('function');
    const host = document.createElement('div');
    const dispose = render(() => <Icon name="jump" />, host);
    const svg = host.querySelector('svg[data-icon="jump"]');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    dispose();
  });
});
