import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type uPlot from 'uplot';
import { AppProvider } from '../state/context';
import { createAppStore } from '../state/appState';
import { FakeApiClient, chatgptPlanUsageHistory } from '../test/fakeClient';
import { planUsageGraphs, type PlanUsageGraphView } from '../data/planUsageHistory';
import { isolatedIndices } from './Chart';
import { PlanUsageChart } from './PlanUsageGraphs';

/* What a usage graph hands uPlot (add-subscription-usage-history design D6; dashboard-core "A
 * subscription provider card graphs each usage window over its span"). uPlot is mocked for this
 * whole file, so it lives apart from the view suite, which mounts the REAL uPlot through the canvas
 * shim (`Providers.planUsageGraphs.view.test.tsx`). Every CSS variable resolves to `token(--name)`,
 * so each colour names exactly the token it read. */

const plots = vi.hoisted(
  () => [] as { options: uPlot.Options; data: uPlot.AlignedData; root: HTMLElement }[],
);
vi.mock('uplot', () => ({
  default: class {
    static tzDate(date: Date) {
      return date;
    }
    constructor(options: uPlot.Options, data: uPlot.AlignedData, root: HTMLElement) {
      const item = { options, data, root, setData: vi.fn(), setSize: vi.fn(), destroy: vi.fn() };
      plots.push(item);
      return item;
    }
  },
}));

afterEach(() => {
  plots.length = 0;
  vi.restoreAllMocks();
});

const T0 = Date.parse('2026-11-06T12:00:00.000Z');
const HOUR = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const provider = {
  planUsage: {
    windows: [
      {
        key: 'account:5h',
        group: 'account' as const,
        span: '5h' as const,
        minutes: 300,
        scope: null,
        usedPercent: 41,
        resetAt: iso(T0 + 2 * HOUR),
        observedAt: iso(T0),
        source: 'refresh' as const,
      },
    ],
    billing: null,
  },
  planUsageRefresh: { availableAt: null },
};
const sampled = (): PlanUsageGraphView =>
  planUsageGraphs(provider, chatgptPlanUsageHistory(T0), T0, 'UTC').accounts[0]!;
const empty = (): PlanUsageGraphView =>
  planUsageGraphs(provider, { windows: [] }, T0, 'UTC').accounts[0]!;

function mounted(graph: PlanUsageGraphView): {
  options: uPlot.Options;
  data: uPlot.AlignedData;
  root: HTMLElement;
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
        <PlanUsageChart graph={graph} />
      </AppProvider>
    ),
    host,
  );
  const plot = plots.at(-1);
  if (plot === undefined) throw new Error('no chart built');
  const out = { options: plot.options, data: plot.data, root: plot.root };
  dispose();
  return out;
}

describe('the usage line is Ink 2, with no fill and no indigo', () => {
  it('reads --text2 for its stroke, sets no fill, and declares itself neutral', () => {
    const c = mounted(sampled());
    const line = c.options.series[1];
    expect(line?.stroke).toBe('token(--text2)');
    expect(line?.fill).toBeUndefined();
    expect(c.root.dataset['series']).toBe('neutral');
    expect(c.root.dataset['measure']).toBeUndefined();
    expect(JSON.stringify(c.options)).not.toContain('--accent');
  });
});

describe('the axis is fixed and the span is the window’s', () => {
  it('y is 0–100 with ticks at 0, 50 and 100; x is the span with no axis of its own', () => {
    const g = sampled();
    const c = mounted(g);
    const y = c.options.scales?.['y']?.range as () => [number, number];
    expect(y()).toEqual([0, 100]);
    const x = c.options.scales?.['x']?.range as () => [number, number];
    expect(x()).toEqual(g.xExtent);
    const [xAxis, yAxis] = c.options.axes ?? [];
    expect(xAxis?.show).toBe(false);
    expect((yAxis?.splits as () => number[])()).toEqual([0, 50, 100]);
    const values = yAxis?.values as (u: uPlot, ticks: number[]) => string[];
    expect(values({} as uPlot, [0, 50, 100])).toEqual(['0', '', '100%']);
  });
});

describe('nothing missing is ever drawn as 0%', () => {
  it('an unknown reading is handed to uPlot as a null, a gap', () => {
    const c = mounted(sampled());
    const ys = c.data[1] as (number | null)[];
    expect(ys[4]).toBeNull();
    expect(ys).not.toContain(0);
  });

  it('a window with no sample hands uPlot only nulls, so it draws the track alone', () => {
    const c = mounted(empty());
    expect(c.data[1]).toEqual([null, null]);
    // The line draws no points of its own; only a lone reading gets one, and nulls never do.
    const points = c.options.series[1]?.points;
    expect(points?.show).toBe(false);
    const filter = points?.filter as (u: uPlot, i: number) => number[] | null;
    expect(filter({ data: c.data } as unknown as uPlot, 1)).toBeNull();
  });

  it('a lone reading between gaps gets a point; a joined one does not', () => {
    expect(isolatedIndices([null, 5, null, 3, 4, null, 7])).toEqual([1, 6]);
    expect(isolatedIndices([12])).toEqual([0]);
    expect(isolatedIndices([null, null])).toEqual([]);
    const c = mounted(sampled());
    const filter = c.options.series[1]?.points?.filter as (u: uPlot, i: number) => number[] | null;
    // The fixture's fourth and sixth readings border its one unknown, but each keeps a neighbour.
    expect(filter({ data: c.data } as unknown as uPlot, 1)).toBeNull();
  });
});

describe('the reset is a dashed reference line in Ink 3', () => {
  it('draws one dashed vertical line at the reset, clamped inside the plot', () => {
    const g = sampled();
    const c = mounted(g);
    const draw = c.options.hooks?.draw?.[0];
    expect(draw).toBeDefined();
    const ops: string[] = [];
    const ctx = {
      save: () => ops.push('save'),
      restore: () => ops.push('restore'),
      beginPath: () => ops.push('begin'),
      stroke: () => ops.push('stroke'),
      moveTo: (x: number, y: number) => ops.push(`move ${String(x)},${String(y)}`),
      lineTo: (x: number, y: number) => ops.push(`line ${String(x)},${String(y)}`),
      setLineDash: (d: number[]) => ops.push(`dash ${d.join(',')}`),
      set strokeStyle(v: string) {
        ops.push(`strokeStyle ${v}`);
      },
      set lineWidth(v: number) {
        ops.push(`lineWidth ${String(v)}`);
      },
    };
    let asked: number | undefined;
    const u = {
      bbox: { left: 40, top: 10, width: 200, height: 80 },
      ctx,
      valToPos: (v: number) => {
        asked = v;
        return 240; // the span's right edge: the reset IS the span's end
      },
    } as unknown as uPlot;
    draw!(u);
    expect(asked).toBe(g.referenceX);
    expect(ops).toContain('strokeStyle token(--text3)');
    expect(ops.find((o) => o.startsWith('dash '))).toBe('dash 4,3');
    // Clamped half a pixel inside the plot's right edge, top to bottom.
    expect(ops).toContain('move 239.5,10');
    expect(ops).toContain('line 239.5,90');
  });

  it('draws nothing when the reset is unknown', () => {
    const c = mounted({ ...empty(), referenceX: null });
    const ops: string[] = [];
    const u = {
      bbox: { left: 0, top: 0, width: 100, height: 50 },
      ctx: new Proxy({}, { get: (_t, k) => () => ops.push(String(k)) }),
      valToPos: () => 50,
    } as unknown as uPlot;
    c.options.hooks?.draw?.[0]?.(u);
    expect(ops).toEqual([]);
  });
});
