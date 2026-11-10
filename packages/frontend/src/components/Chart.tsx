import { createEffect, on, onCleanup, onMount } from 'solid-js';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { useApp } from '../state/context';

/** A single-series uPlot line (requests per bucket, one scale — no dual-axis).
 * Isolates uPlot's imperative lifecycle inside a SolidJS component: built once on
 * mount, data updates reuse the instance, a theme toggle rebuilds so the CSS-var
 * palette re-applies, and the ResizeObserver is disconnected AND the instance
 * destroyed on cleanup. */
export interface ChartProps {
  /** `[secs[], ...ys[][]]` — x is epoch SECONDS (uPlot's native unit). Single
   * series by default; pass `series` metadata for a multi-series chart. */
  data: [number[], ...(number | null)[][]];
  label?: string;
  height?: number;
  /** Multi-series mode (add-auto-performance-view): one entry per y-array.
   * Series 0 uses the locked accent; the rest use neutral tones distinguished
   * by DASH pattern (never color alone — WCAG 1.4.1); label rendering is the
   * caller's (direct labels beside the chart). */
  series?: { label: string; dash?: number[] }[];
  /** Series 0 takes the locked accent (stroke + fill) — the default, which Overview and
   * BudgetChart rely on. `false` draws it as a neutral solid `--text` line with no fill,
   * for a chart that must not compete with a screen's one accent figure
   * (split-auto-routing-readout-setup D11: the band-mix chart). */
  accentFirst?: boolean;
  /** The focal measure this chart draws in the accent, named on its root as `data-measure`
   * (the Indigo Budget, adopt-design-tokens-v2 D11: `requests` on Overview, `budget-spend` on
   * a budget card). A view may show one focal measure; `indigoBudget.spec.ts` counts them. A
   * neutral chart (`accentFirst={false}`) names none. */
  measure?: string;
  /** The single-series chart's neutral stroke while `accentFirst` is false: Ink (`--text`, the
   * default) or Ink 2 (`--text2`, add-subscription-usage-history D6: a usage graph repeated on
   * every card must not compete with the page's text). Multi-series charts keep Ink. */
  neutralTone?: 'ink' | 'ink2';
  /** A dashed vertical reference line at this x (epoch seconds), in Ink 3: DESIGN.md "a dashed
   * line is a reference line", e.g. a usage window's reset. The caller labels it directly. */
  referenceX?: number | null;
  /** Draw a point for each value with no non-null neighbour, so a lone reading between gaps (or
   * the only reading) is visible; the line itself still draws no points. Nulls are never drawn. */
  isolatedPoints?: boolean;
  /** Hide the x axis, for a compact chart whose caller states the range in words. */
  hideXAxis?: boolean;
  /** Fixed y tick positions (e.g. `[0, 50, 100]` on a percent axis), instead of uPlot's own. */
  ySplits?: readonly number[];
  /** The y axis gutter in CSS pixels (58 with `yFormat`, uPlot's own otherwise). */
  yAxisSize?: number;
  xExtent?: [number, number];
  yExtent?: [number, number];
  yFormat?: (value: number) => string;
  utc?: boolean;
}

/** The indices of the values with no non-null neighbour: a lone reading the line cannot draw. */
export function isolatedIndices(ys: ArrayLike<number | null | undefined>): number[] {
  const out: number[] = [];
  const absent = (i: number): boolean => i < 0 || i >= ys.length || ys[i] == null;
  for (let i = 0; i < ys.length; i += 1) {
    if (!absent(i) && absent(i - 1) && absent(i + 1)) out.push(i);
  }
  return out;
}

const DEFAULT_HEIGHT = 150;

export function Chart(props: ChartProps) {
  const app = useApp();
  let container: HTMLDivElement | undefined;
  let chart: uPlot | undefined;
  let observer: ResizeObserver | undefined;

  const height = (): number => props.height ?? DEFAULT_HEIGHT;
  const accentFirst = (): boolean => props.accentFirst !== false;

  const build = (): void => {
    if (!container) return;
    chart?.destroy();
    const styles = getComputedStyle(container);
    const cssVar = (name: string, fallback: string): string =>
      styles.getPropertyValue(name).trim() || fallback;
    // Fallbacks mirror the styles.css light-theme tokens (--accent-bg is a color-mix;
    // its literal is the evaluated value). They fire only if the CSS-variable read
    // returns empty and must never render off-lock — change them with the tokens.
    // Axis stroke colors uPlot's tick-label TEXT, so it uses the contrast-passing
    // --text3, never decorative --faint.
    const axisStroke = cssVar('--text3', '#6a6c73');
    const gridStroke = cssVar('--border2', '#f1f1ef');
    const axis: uPlot.Axis = {
      stroke: axisStroke,
      font: "11px 'Geist Mono', monospace",
      grid: { stroke: gridStroke, width: 1 },
      ticks: { stroke: gridStroke, width: 1 },
    };
    // The single series' stroke: the accent, or the neutral tone the caller chose.
    const firstStroke = accentFirst()
      ? cssVar('--accent', '#4f5dff')
      : props.neutralTone === 'ink2'
        ? cssVar('--text2', '#55575e')
        : cssVar('--text', '#17181a');
    const firstPoints: uPlot.Series.Points =
      props.isolatedPoints === true
        ? {
            show: false,
            size: 5,
            fill: firstStroke,
            filter: (u: uPlot, seriesIdx: number) => {
              const idx = isolatedIndices(u.data[seriesIdx] ?? []);
              return idx.length > 0 ? idx : null;
            },
          }
        : { show: false };
    const referenceStroke = cssVar('--text3', '#6a6c73');
    const drawReference = (u: uPlot): void => {
      const at = props.referenceX;
      if (at === null || at === undefined) return;
      const { left, top, width, height: h } = u.bbox;
      const pos = u.valToPos(at, 'x', true);
      if (!Number.isFinite(pos) || pos < left - 1 || pos > left + width + 1) return;
      // Clamped inside the plot so a reset at the span's end stays on screen.
      const x = Math.min(Math.max(Math.round(pos) + 0.5, left + 0.5), left + width - 0.5);
      const ratio = uPlot.pxRatio || 1;
      const ctx = u.ctx;
      ctx.save();
      ctx.strokeStyle = referenceStroke;
      ctx.lineWidth = ratio;
      ctx.setLineDash([4 * ratio, 3 * ratio]);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, top + h);
      ctx.stroke();
      ctx.restore();
    };
    const opts: uPlot.Options = {
      width: container.clientWidth || 540,
      height: height(),
      legend: { show: false },
      cursor: { show: false },
      ...(props.referenceX !== undefined ? { hooks: { draw: [drawReference] } } : {}),
      ...(props.utc
        ? { tzDate: (ts: number) => uPlot.tzDate(new Date(ts * 1000), 'Etc/UTC') }
        : {}),
      scales: {
        x: { time: true, ...(props.xExtent ? { range: () => props.xExtent! } : {}) },
        ...(props.yExtent ? { y: { range: () => props.yExtent! } } : {}),
      },
      axes: [
        {
          ...axis,
          ...(props.hideXAxis === true ? { show: false } : {}),
          ...(props.utc
            ? {
                space: 75,
                values: (_u: uPlot, ticks: number[]) =>
                  ticks.map((t) =>
                    props.xExtent && props.xExtent[1] - props.xExtent[0] > 86400
                      ? new Date(t * 1000).toISOString().slice(5, 10)
                      : new Date(t * 1000).toISOString().slice(11, 16),
                  ),
              }
            : {}),
        },
        {
          ...axis,
          ...(props.yFormat
            ? {
                size: 58,
                values: (_u: uPlot, ticks: number[]) => ticks.map((v) => props.yFormat!(v)),
              }
            : {}),
          ...(props.ySplits !== undefined ? { splits: () => [...props.ySplits!] } : {}),
          ...(props.yAxisSize !== undefined ? { size: props.yAxisSize } : {}),
        },
      ],
      series:
        props.series !== undefined
          ? [
              {},
              ...props.series.map((meta, i) => ({
                label: meta.label,
                stroke:
                  i !== 0
                    ? cssVar('--text3', '#6a6c73')
                    : accentFirst()
                      ? cssVar('--accent', '#4f5dff')
                      : cssVar('--text', '#17181a'),
                ...(i === 0 && accentFirst() ? { fill: cssVar('--accent-bg', '#eff0ff') } : {}),
                ...(meta.dash !== undefined ? { dash: meta.dash } : {}),
                width: i === 0 ? 2 : 1.5,
                points: { show: false },
              })),
            ]
          : [
              {},
              {
                label: props.label ?? 'requests',
                stroke: firstStroke,
                ...(accentFirst() ? { fill: cssVar('--accent-bg', '#eff0ff') } : {}),
                width: 2,
                points: firstPoints,
              },
            ],
    };
    chart = new uPlot(opts, props.data, container);
  };

  onMount(() => {
    if (!container) return;
    build();
    observer = new ResizeObserver(() => {
      if (!container) return;
      chart?.setSize({ width: container.clientWidth || 540, height: height() });
    });
    observer.observe(container);
  });

  // Data changes after mount reuse the instance (cheap redraw), not a rebuild.
  createEffect(
    on(
      () => props.data,
      (data) => chart?.setData(data),
      { defer: true },
    ),
  );
  // A theme toggle re-reads the CSS-var palette → rebuild so the chart re-themes.
  createEffect(
    on(
      () => app.state.theme,
      () => {
        if (chart) build();
      },
      { defer: true },
    ),
  );

  onCleanup(() => {
    observer?.disconnect();
    chart?.destroy();
  });

  // uPlot draws on a canvas, which no computed style can read, so the series is declared
  // on the root instead: `focal` (with its measure) while series 0 takes the accent, and
  // `neutral` otherwise (the Indigo Budget, D11). Chart.series.test.tsx holds the two together.
  return (
    <div
      ref={(el) => {
        container = el;
      }}
      data-series={accentFirst() ? 'focal' : 'neutral'}
      data-measure={accentFirst() ? props.measure : undefined}
      style={{ width: '100%', height: `${String(height())}px` }}
    />
  );
}
