import { createEffect, createMemo, createSignal, Index, on, onCleanup, Show } from 'solid-js';
import type { PlanUsageHistoryDto } from '../data/api';
import {
  PLAN_USAGE_GRAPH_COPY,
  planUsageGraphs,
  type PlanUsageGraphView,
} from '../data/planUsageHistory';
import { useApp } from '../state/context';
import type { Provider } from '../types';
import { Chart } from './Chart';
import { FigureSkeleton } from './FigureSkeleton';
import { Notice } from './Notice';

/** The plot's height in CSS pixels: a compact track under a card's usage line. The skeleton
 * (`.fig-skel-chart`) holds the same height, so the card does not jump when the history lands. */
export const PLAN_USAGE_GRAPH_HEIGHT = 64;
/** Percent axis ticks: the track's floor, middle and ceiling (grid lines at all three). */
const Y_SPLITS = [0, 50, 100] as const;
const yTick = (v: number): string => (v >= 100 ? '100%' : v <= 0 ? '0' : '');
/** The y gutter: room for `100%` in the chart's 11px axis face beside uPlot's tick and gap (a
 * 36px gutter clipped it to `00%`, seen in the browser). */
const Y_AXIS_SIZE = 44;

/**
 * One window's graph (add-subscription-usage-history, design D6): a `figure` whose `figcaption`
 * states the window, its latest percent (or `unknown` / `no reading yet`), its reset and the range
 * the graph covers, in words; the drawing itself is `aria-hidden`.
 *
 * Used percent on a fixed 0–100 axis over the window's span, as an Ink 2 line with no fill (never
 * indigo: one graph per window on every card would spend the Indigo Budget many times). A null is
 * a gap, a lone reading is a dot, and the reset is a dashed reference line labelled in the caption.
 * A window with no known percent draws the empty track and nothing on it. uPlot does not animate,
 * so reduced motion has nothing to still here; the loading skeleton's pulse is stilled by the
 * stylesheet's guard.
 */
export function PlanUsageChart(props: { graph: PlanUsageGraphView }) {
  return (
    <figure class="pu-graph" data-usage-graph={props.graph.key}>
      <figcaption class="pu-graph-caption">
        <span class="pu-graph-head">
          <span class="pu-graph-name">{props.graph.label}</span>
          {' · '}
          <span class="pu-graph-figure" data-known={props.graph.known ? 'true' : 'false'}>
            {props.graph.figure}
          </span>
          <Show when={props.graph.reset}>
            {(reset) => (
              <>
                {' · '}
                <span
                  class="pu-graph-reset"
                  data-reference={props.graph.referenceX !== null ? 'true' : undefined}
                >
                  {reset()}
                </span>
              </>
            )}
          </Show>
        </span>
        {/* A flex container drops this space visually; the caption's text keeps it, so the two
            lines never read as one run-on word. */}{' '}
        <span class="pu-graph-range">
          {props.graph.latest === null
            ? props.graph.range
            : `${props.graph.range} · ${props.graph.latest}`}
        </span>
      </figcaption>
      <div class="pu-graph-plot" aria-hidden="true">
        <Chart
          data={props.graph.data}
          label="used percent"
          height={PLAN_USAGE_GRAPH_HEIGHT}
          accentFirst={false}
          neutralTone="ink2"
          isolatedPoints
          hideXAxis
          xExtent={props.graph.xExtent}
          yExtent={[0, 100]}
          ySplits={Y_SPLITS}
          yAxisSize={Y_AXIS_SIZE}
          yFormat={yTick}
          referenceX={props.graph.referenceX}
        />
      </div>
    </figure>
  );
}

/**
 * A subscription card's usage graphs, under its usage line (dashboard-core "A subscription
 * provider card graphs each usage window over its span").
 *
 * The history is read once when the graphs mount and again whenever `reads` moves (the card bumps
 * it after a Refresh usage succeeds). While the FIRST read is in flight one chart-sized skeleton
 * stands in; a re-read keeps the graphs on screen. A failed read removes them (never shown stale)
 * for the shared Info notice with its Retry, in place; the usage line above is untouched. After
 * Retry, focus goes to the group, never the page.
 *
 * Account windows are charted directly; model buckets inside a native disclosure, as the line
 * lists them, mounted only while it is open.
 */
export function PlanUsageGraphs(props: {
  provider: Provider;
  /** Moves after each successful Refresh usage: the history is read again. */
  reads: number;
  /** The card's clock, so a reset that passes re-states the captions. */
  now: number;
}) {
  const app = useApp();
  const [history, setHistory] = createSignal<PlanUsageHistoryDto | null>(null);
  const [failed, setFailed] = createSignal(false);
  const [bucketsOpen, setBucketsOpen] = createSignal(false);
  let group: HTMLDivElement | undefined;
  let alive = true;
  let seq = 0;
  onCleanup(() => {
    alive = false;
  });

  const load = (): void => {
    const mine = (seq += 1);
    setFailed(false);
    app.loadPlanUsageHistory(props.provider.id).then(
      (answer) => {
        if (!alive || mine !== seq) return;
        setHistory(answer);
      },
      () => {
        if (!alive || mine !== seq) return;
        setHistory(null);
        setFailed(true);
      },
    );
  };
  // Not deferred: the first run is the mount's read.
  createEffect(on(() => props.reads, load));

  const retry = (): void => {
    load();
    // The notice, and its Retry with it, has unmounted: focus goes to the group (D8).
    queueMicrotask(() => group?.focus({ preventScroll: true }));
  };

  const graphs = createMemo(() => {
    const h = history();
    return h === null ? null : planUsageGraphs(props.provider, h, props.now);
  });

  return (
    <div
      ref={(el) => {
        group = el;
      }}
      class="pu-graphs"
      role="group"
      aria-label={`${props.provider.name} usage history`}
      tabindex="-1"
      data-usage-graphs
    >
      <Show
        when={!failed()}
        fallback={
          <Notice
            tone="info"
            title={PLAN_USAGE_GRAPH_COPY.failedTitle}
            action={{ label: PLAN_USAGE_GRAPH_COPY.retry, onClick: retry }}
            data-usage-graphs-failure
          >
            {PLAN_USAGE_GRAPH_COPY.failed}
          </Notice>
        }
      >
        <Show
          when={graphs()}
          fallback={
            <div data-usage-graphs-loading>
              <FigureSkeleton what={PLAN_USAGE_GRAPH_COPY.loading} size="chart" />
            </div>
          }
        >
          {(g) => (
            <>
              <Index each={g().accounts}>{(graph) => <PlanUsageChart graph={graph()} />}</Index>
              <Show when={g().buckets.length > 0}>
                <details
                  class="pu-graph-buckets"
                  data-usage-graph-buckets
                  onToggle={(e) => setBucketsOpen(e.currentTarget.open)}
                >
                  <summary>{`model limit graphs (${String(g().buckets.length)})`}</summary>
                  <Show when={bucketsOpen()}>
                    <div class="pu-graph-bucket-list">
                      <Index each={g().buckets}>
                        {(graph) => <PlanUsageChart graph={graph()} />}
                      </Index>
                    </div>
                  </Show>
                </details>
              </Show>
            </>
          )}
        </Show>
      </Show>
    </div>
  );
}
