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
  /** `[secs[], counts[]]` — x is epoch SECONDS (uPlot's native unit). */
  data: [number[], number[]];
  label?: string;
  height?: number;
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
    const axisStroke = cssVar('--faint', '#9aa0aa');
    const gridStroke = cssVar('--border2', 'rgba(120,120,130,0.15)');
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
      series: [
        {},
        {
          label: props.label ?? 'requests',
          stroke: cssVar('--accent', '#6366f1'),
          fill: cssVar('--accent-bg', 'rgba(99,102,241,0.12)'),
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
