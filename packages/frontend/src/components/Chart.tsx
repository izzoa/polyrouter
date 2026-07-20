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
  data: [number[], ...number[][]];
  label?: string;
  height?: number;
  /** Multi-series mode (add-auto-performance-view): one entry per y-array.
   * Series 0 uses the locked accent; the rest use neutral tones distinguished
   * by DASH pattern (never color alone — WCAG 1.4.1); label rendering is the
   * caller's (direct labels beside the chart). */
  series?: { label: string; dash?: number[] }[];
}

const DEFAULT_HEIGHT = 150;

export function Chart(props: ChartProps) {
  const app = useApp();
  let container: HTMLDivElement | undefined;
  let chart: uPlot | undefined;
  let observer: ResizeObserver | undefined;

  const height = (): number => props.height ?? DEFAULT_HEIGHT;

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
    const opts: uPlot.Options = {
      width: container.clientWidth || 540,
      height: height(),
      legend: { show: false },
      cursor: { show: false },
      scales: { x: { time: true } },
      axes: [axis, { ...axis }],
      series:
        props.series !== undefined
          ? [
              {},
              ...props.series.map((meta, i) => ({
                label: meta.label,
                stroke: i === 0 ? cssVar('--accent', '#4f5dff') : cssVar('--text3', '#6a6c73'),
                ...(i === 0 ? { fill: cssVar('--accent-bg', '#eff0ff') } : {}),
                ...(meta.dash !== undefined ? { dash: meta.dash } : {}),
                width: i === 0 ? 2 : 1.5,
                points: { show: false },
              })),
            ]
          : [
              {},
              {
                label: props.label ?? 'requests',
                stroke: cssVar('--accent', '#4f5dff'),
                fill: cssVar('--accent-bg', '#eff0ff'),
                width: 2,
                points: { show: false },
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

  return (
    <div
      ref={(el) => {
        container = el;
      }}
      style={{ width: '100%', height: `${String(height())}px` }}
    />
  );
}
