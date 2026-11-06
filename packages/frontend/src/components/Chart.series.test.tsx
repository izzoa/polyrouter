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

const plots = vi.hoisted(() => [] as { options: uPlot.Options; root: HTMLElement }[]);
vi.mock('uplot', () => ({
  default: class {
    static tzDate(date: Date) {
      return date;
    }
    constructor(options: uPlot.Options, _data: unknown, root: HTMLElement) {
      const item = { options, root, setData: vi.fn(), setSize: vi.fn(), destroy: vi.fn() };
      plots.push(item);
      return item;
    }
  },
}));

afterEach(() => {
  plots.length = 0;
  vi.restoreAllMocks();
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

/** Renders one chart and returns the root it marked and the series it handed uPlot. Every CSS
 * variable resolves to `token(--name)`, so a series names exactly the token it read — the
 * literal fallbacks (which happy-dom would otherwise show) cannot stand in for one. */
function chartRoot(props: { accentFirst?: boolean; measure?: string; multi: boolean }): {
  series: string | undefined;
  measure: string | undefined;
  options: uPlot.Series[];
} {
  vi.spyOn(globalThis, 'getComputedStyle').mockImplementation(
    () =>
      ({
        getPropertyValue: (name: string) => `token(${name})`,
      }) as unknown as CSSStyleDeclaration,
  );
  const host = document.createElement('div');
  const dispose = render(
    () => (
      <AppProvider store={createAppStore(new FakeApiClient())}>
        <Chart
          data={DATA}
          {...(props.multi ? { series: SERIES } : {})}
          {...(props.accentFirst === undefined ? {} : { accentFirst: props.accentFirst })}
          {...(props.measure === undefined ? {} : { measure: props.measure })}
        />
      </AppProvider>
    ),
    host,
  );
  const plot = plots.at(-1);
  if (plot === undefined) throw new Error('no chart built');
  const out = {
    series: plot.root.dataset['series'],
    measure: plot.root.dataset['measure'],
    options: plot.options.series,
  };
  dispose();
  return out;
}

describe('a chart declares its series on its root (the Indigo Budget, adopt-design-tokens-v2 task 7.3)', () => {
  // uPlot draws on a canvas, which no computed style can read: the `data-series` marker is how
  // indigoBudget.spec.ts counts a chart's focal measure, so it must agree with what the chart
  // is told to draw.
  it('by default the root is focal, names its measure, and series 0 reads --accent and --accent-bg', () => {
    for (const multi of [true, false]) {
      const c = chartRoot({ multi, measure: 'requests' });
      expect(c.series).toBe('focal');
      expect(c.measure).toBe('requests');
      expect(c.options[1]?.stroke).toBe('token(--accent)');
      expect(c.options[1]?.fill).toBe('token(--accent-bg)');
    }
  });

  it('accentFirst={false} reads no --accent for any stroke or fill, and the root is neutral', () => {
    for (const multi of [true, false]) {
      const c = chartRoot({ multi, accentFirst: false, measure: 'requests' });
      expect(c.series).toBe('neutral');
      // A neutral chart is no view's focal measure, whatever it was told.
      expect(c.measure).toBeUndefined();
      c.options.slice(1).forEach((s, i) => {
        expect(s.stroke, `series ${String(i)} stroke`).not.toMatch(/--accent/);
        expect(s.fill, `series ${String(i)} fill`).toBeUndefined();
      });
      expect(JSON.stringify(c.options)).not.toContain('--accent');
    }
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

/* The axes' tick labels are figures drawn on a canvas, which cannot turn on tabular numerals
 * (a canvas font string has no `font-variant-numeric`). Until notes/flags.md F7 is decided
 * (adopt-design-tokens-v2 task 9.1, Flagged), they keep the one declared canvas font: Geist
 * Mono at the on-scale 11px, whose digits are tabular. Pinned so that the axis font can move
 * only together with that decision and the spec's figure rule, never silently. */
describe('the canvas axes keep their one declared font until F7 is decided (task 9.1)', () => {
  it("every axis draws its tick figures in 11px 'Geist Mono', in both series modes", () => {
    for (const accentFirst of [true, false]) {
      chartSeries({ multi: true, accentFirst });
      const axes = plots.at(-1)?.options.axes ?? [];
      expect(axes.length, 'the chart configures its axes').toBeGreaterThan(0);
      for (const axis of axes) expect(axis.font).toBe("11px 'Geist Mono', monospace");
    }
  });
});
