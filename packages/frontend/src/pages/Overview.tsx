import { createEffect, createMemo, For, Match, on, Show, Switch, type JSX } from 'solid-js';
import { BreakdownPanel, METRIC_OPTIONS } from '../components/BreakdownPanel';
import { Segmented } from '../components/Segmented';
import { Chart } from '../components/Chart';
import { RangeSelector } from '../components/RangeSelector';
import {
  BatchJobRows,
  InflightRows,
  RequestRows,
  RequestTableHead,
} from '../components/RequestTable';
import { bucketSeconds, timeseriesToChart, toAgentStrip } from '../data/analytics';
import { BATCH_POLL_MS } from '../data/batchBand';
import { inflightCadenceMs } from '../data/inflight';
import { createPoller } from '../data/poller';
import type { BreakdownMetric } from '../data/api';
import { rangeToParams } from '../data/range';
import { useApp } from '../state/context';
import { Icon } from '../components/Icon';
import { createHeldFailure, Notice } from '../components/Notice';
import { createFigureLoad } from '../data/figureLoad';
import { ReadoutStrip, type ReadoutCell, type ReadoutFocalCell } from '../components/ReadoutStrip';
import { FigureSkeleton } from '../components/FigureSkeleton';
import { FigureText } from '../components/FigureText';
import {
  estimatePricedText,
  estimatedUsageText,
  fmtTokensCompact,
  microsOfUsd,
  money,
  NOT_APPLICABLE,
  share,
  unpricedCountParts,
} from '../data/figures';

const POLL_MS = 15_000;

export function Overview(props: { live: boolean }) {
  const app = useApp();
  const { state } = app;

  // Load on mount + on range change (this effect is NOT deferred, so it covers the
  // mount load — which is why the analytics poller below passes
  // `runImmediately: false`). The requests list is not polled.
  createEffect(
    on(
      () => state.range,
      () => {
        void app.loadOverview();
        // The agent strip rides the RANGE, not the poll: per-agent volume over a
        // window does not change meaningfully every 15 seconds, and adding a fifth
        // endpoint to the polled fan-out would raise the idle cost of an open
        // dashboard by a quarter for no freshness anyone can perceive.
        void app.loadAgentStrip();
      },
    ),
  );

  // Both pollers are visibility-gated and single-flight, and stop on unmount
  // (phase1-tune-dashboard-polling).
  createPoller({
    // Routed through the SHARED poll+nudge budget so a stream nudge consumes this
    // slot rather than adding to it; `resume` is forced so phase 1's mandatory
    // hidden→visible catch-up is never suppressed by the floor.
    fn: (reason) => app.requestAggregateRefresh(() => app.loadOverview(), reason === 'resume'),
    intervalMs: () => POLL_MS,
    enabled: () => props.live,
    runImmediately: false, // the range effect above already loaded at mount
  });
  // Fast, separate poll for live in-flight rows (add-inflight-requests). This one DOES
  // run immediately — it subsumes the former mount-time `void app.loadInflight()` call
  // rather than adding to it, so mount issues exactly one in-flight fetch. Its cadence
  // relaxes only while provably empty and snaps back on the first observed row.
  createPoller({
    fn: () => app.loadInflight(),
    intervalMs: () => inflightCadenceMs(state.inflightRows.length),
    // A HEALTHY stream supersedes this poll — exactly one continuous driver feeds the
    // live rows at a time (the stream's low-rate authoritative reconciliation read is
    // a verifier, not a second driver). Any degradation resumes it automatically.
    enabled: () => props.live && state.streamHealth !== 'live',
  });

  // The batch partition's own read (add-batch-inference D11). Separate from the
  // in-flight poll because the two carry different evidence and must never settle
  // each other; visibility-gated and floored the same way, and NOT suppressed by a
  // healthy stream — `batch.updated` is a nudge that consumes this read, not a
  // second driver that replaces it.
  createPoller({
    fn: () => app.loadBatchBand(),
    intervalMs: () => BATCH_POLL_MS,
    enabled: () => props.live,
  });

  /** Strip entries, derived — keyless traffic kept but not made actionable. */
  const agentStrip = () => toAgentStrip(state.agentStrip);
  /** The agent strip's own Retry (adopt-figure-states D5, flag F9). The strip rides the range,
   * not the page's poll, so its failure is its own notice: the page's Retry reloads the
   * polled slices and would never clear it. Its load starts by clearing the failure, so the
   * notice (and this Retry in it) unmounts at once; focus then goes to the strip's panel,
   * which stays mounted through the failure and the retry, never to <body>. */
  let agentPanel: HTMLDivElement | undefined;
  const retryAgentStrip = (): void => {
    void app.loadAgentStrip();
    queueMicrotask(() => agentPanel?.focus());
  };
  const metric = (): BreakdownMetric => state.breakdownMetric;
  /** True while the rows on screen belong to a different range/metric than the one selected —
   * they are not merely old, they are labelled wrongly. Overview lacked this, so navigating
   * here after flipping the metric on Costs briefly rendered the TOKEN top-N under a "Spend by
   * model" heading: right values, wrong models, bars not in descending order. */
  const breakdownStale = (): boolean => {
    const l = state.breakdownLoadedFor;
    return l === null || l.metric !== state.breakdownMetric || l.range !== state.range;
  };

  const chartData = () =>
    timeseriesToChart(
      state.analyticsSeries,
      bucketSeconds(rangeToParams(state.range, Date.now()).bucket),
    );
  const errorMsg = () =>
    state.analyticsSummaryError ??
    state.analyticsSeriesError ??
    state.analyticsBreakdownError ??
    state.recentRequestsError;
  // The load-failure notice is held across the 15-second poll (D15): every slice clears its
  // error as it starts, which would otherwise re-insert, and re-announce, the notice.
  const failure = createHeldFailure(
    errorMsg,
    () =>
      state.analyticsSummaryLoading ||
      state.analyticsSeriesLoading ||
      state.analyticsBreakdownLoading ||
      state.recentRequestsLoading,
  );

  /** The readout strip's figures come from the summary read alone (D11): a failure of
   * another slice shows the notice but leaves them (adopt-figure-states D5). */
  const stripState = createFigureLoad({
    error: () => state.analyticsSummaryError,
    loading: () => state.analyticsSummaryLoading,
    loaded: () => state.analyticsSummary !== null,
    failureShown: () => failure.message() !== null,
  });
  /** Retry's landing spot: the strip's panel stays through the failure and the retry. */
  let stripPanel: HTMLDivElement | undefined;
  /** The chart, the breakdown bars and the recent rows are figures from their own reads, each
   * gated on its own slice the same way (adopt-figure-states D5): a failed read's figures are
   * removed under the notice, never shown as current, and a failed read is never shown as a
   * measured empty range. */
  const failureShown = (): boolean => failure.message() !== null;
  const seriesLoad = createFigureLoad({
    error: () => state.analyticsSeriesError,
    loading: () => state.analyticsSeriesLoading,
    loaded: () => state.analyticsSeriesLoaded,
    failureShown,
  });
  const breakdownLoad = createFigureLoad({
    error: () => state.analyticsBreakdownError,
    loading: () => state.analyticsBreakdownLoading,
    loaded: () => !breakdownStale(),
    failureShown,
  });
  const recentLoad = createFigureLoad({
    error: () => state.recentRequestsError,
    loading: () => state.recentRequestsLoading,
    loaded: () => state.recentRequestsLoaded,
    failureShown,
  });

  /** The readout strip's four cells in the state they are in. */
  const readout = (): { focal: ReadoutFocalCell; cells: ReadoutCell[] } => {
    const st = stripState();
    const s = state.analyticsSummary;
    const label = `Spend · ${state.range}`;
    if (st !== 'ready' || s === null) {
      // Loading: a skeleton in each figure slot, every sub-line empty, never `$0.00`, `0`,
      // `0.00M` or `loading…`. Failed: the figures are removed, with no skeleton left.
      const slot = (what: string, size: 'display' | 'title'): JSX.Element =>
        st === 'loading' ? <FigureSkeleton what={what} size={size} /> : '';
      return {
        focal: { id: 'spend', label, figure: slot('spend', 'display'), sub: '' },
        cells: [
          { id: 'requests', label: 'Requests', figure: slot('requests', 'title'), sub: ' ' },
          { id: 'tokens', label: 'Tokens', figure: slot('tokens', 'title'), sub: ' ' },
          {
            id: 'success',
            label: 'Success rate',
            figure: slot('success rate', 'title'),
            sub: ' ',
          },
        ],
      };
    }
    const tin = s.inputTokens;
    const tout = s.outputTokens;
    /** Cache is part of the work. `inputTokens` is recorded as *uncached* input — the
     * adapters subtract cached tokens out and record them separately — so the headline used
     * to omit a cached workload's largest component while looking exact. */
    const tcache = s.cacheReadTokens + s.cacheWriteTokens;
    const reqs = s.requests;
    const unpriced = unpricedCountParts(s.unpricedRequests);
    const disclosures = [
      estimatePricedText(microsOfUsd(s.nativeFamilySpend)),
      estimatedUsageText(s.estimatedCount),
    ].filter((t): t is string => t !== null);
    return {
      focal: {
        id: 'spend',
        label,
        figure: money(microsOfUsd(s.spend), 'cents'),
        qualifier: unpriced.length > 0 ? <FigureText parts={unpriced} /> : undefined,
        sub: disclosures.join(' · '),
      },
      cells: [
        { id: 'requests', label: 'Requests', figure: reqs.toLocaleString(), sub: ' ' },
        {
          id: 'tokens',
          label: 'Tokens',
          figure: fmtTokensCompact(tin + tout + tcache),
          sub: (
            <>
              {/* Same reason as the requests table: the worded form wraps to two lines below
                  the narrow threshold. `cached` keeps its word — it is a third quantity, not
                  the other half of a pair, and an arrow would imply a direction it does not
                  have. */}
              <span aria-hidden="true">
                {fmtTokensCompact(tin)}↑ {fmtTokensCompact(tout)}↓
              </span>
              <span class="sr-only">
                {fmtTokensCompact(tin)} tokens in, {fmtTokensCompact(tout)} out
              </span>
              <Show when={tcache > 0}> · {fmtTokensCompact(tcache)} cached</Show>
            </>
          ),
        },
        // An empty range has no rate: `not applicable` in Ink 3, and a sentence that says why
        // (adopt-figure-states D5), never `—`, `0%` or `no requests yet`. Words, not a figure,
        // so they may wrap in a narrow cell rather than overflow it.
        reqs === 0
          ? {
              id: 'success',
              label: 'Success rate',
              figure: <span style="color:var(--text3);white-space:normal">{NOT_APPLICABLE}</span>,
              sub: 'No requests in this range',
            }
          : {
              id: 'success',
              label: 'Success rate',
              figure: share(s.successCount, reqs, 1),
              sub: `fallback ${share(s.fallbackCount, reqs, 1)} · escalated ${share(s.escalatedCount, reqs, 1)}`,
            },
      ],
    };
  };
  /** Built once per change, so each figure's nodes are created once and inserted once. */
  const strip = createMemo(readout);

  return (
    <div class="rs-page" style="display:flex;flex-direction:column;gap:24px;max-width:1200px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="section-title">Overview · {state.range}</div>
        <RangeSelector />
      </div>

      {/* Info, not Failure (D15): a failed figure load is a neutral notice that names what
          failed, without the raw error (adopt-figure-states D5). Retry leaves focus on the
          strip's panel, which stays mounted, once its load has started. */}
      <Show when={failure.message() !== null}>
        <Notice
          tone="info"
          title="Couldn’t load"
          action={{
            label: 'Retry',
            onClick: () => {
              failure.release();
              void app.loadOverview();
              queueMicrotask(() => stripPanel?.focus());
            },
          }}
        >
          Analytics couldn’t be loaded. Routing is unaffected.
        </Notice>
      </Show>

      {/* The headline figures as one readout strip (adopt-design-tokens-v2 task 12.1, D10):
          spend is the view's one Display figure; requests, tokens and success rate are Title
          cells. Every sub-line is the one its tile carried. */}
      <ReadoutStrip
        focal={strip().focal}
        cells={strip().cells}
        focusTarget={(el) => {
          stripPanel = el;
        }}
      />

      <div class="rs-grid-main-side" style="display:grid;gap:16px">
        <div class="panel card">
          <div class="section-title" style="margin-bottom:12px">
            Requests · {state.range}
          </div>
          <Show
            when={seriesLoad() === 'ready' && state.analyticsSeries.length > 0}
            fallback={
              <div
                data-testid="series-state"
                class="t-dense"
                style="height:150px;display:flex;align-items:center;justify-content:center;color:var(--text3)"
              >
                <Switch>
                  <Match when={seriesLoad() === 'loading'}>
                    <FigureSkeleton what="requests over time" size="line" />
                  </Match>
                  <Match when={seriesLoad() === 'ready'}>No requests in this range</Match>
                </Switch>
              </div>
            }
          >
            <Chart data={chartData()} label="requests" measure="requests" height={150} />
          </Show>
        </div>
        {/* The metric selector is shared with Costs — one preference, settable from either
            page — so flipping it here re-ranks both. That is deliberate: the archived
            requirement covers "the Overview and Costs pages", and a preference with only one
            place to set it was the odd arrangement. */}
        <BreakdownPanel
          title={`${metric() === 'tokens' ? 'Tokens' : 'Spend'} by model`}
          rows={state.analyticsBreakdown.model}
          load={breakdownLoad()}
          metric={metric()}
          what={`${metric() === 'tokens' ? 'tokens' : 'spend'} by model`}
          action={
            <Segmented
              options={METRIC_OPTIONS}
              value={metric()}
              onChange={(m) => {
                app.setBreakdownMetric(m);
              }}
            />
          }
        />
      </div>

      {/* Which agents are accruing this range's requests (add-agent-request-attribution).
          Same low-weight strip pattern as Providers below — the page already carries four
          stat cards, a chart, a breakdown panel and the recent-requests table, and the
          design lock allows one focal point per screen, so a fifth PANEL would be the
          wrong weight. Activating an agent hands the filtered evidence to Requests, which
          is also what makes that filter discoverable. */}
      {/* ONE panel, two labelled rows — agents and providers are both "the set of
          things wired into this router, with their state". Two structurally identical
          strips stacked would read as the same section repeated. */}
      <div
        ref={(el) => {
          agentPanel = el;
        }}
        tabindex={-1}
        data-testid="agent-strip"
        class="panel"
        style="display:flex;flex-direction:column;gap:8px;padding:12px 16px;border-radius:10px"
      >
        <div class="rs-wrap" style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
          <span class="upper-label" style="letter-spacing:.05em">
            Agents
          </span>
          <Show
            when={state.agentStripLoaded}
            fallback={
              /* Never a zero here: an unloaded strip is UNKNOWN, not measured-empty — and a
                 FAILED load must not keep reading as "still working". While it loads, the
                 shared skeleton names what loads; a failed load is the shared Info notice
                 with its own Retry, taking the rest of the row (adopt-figure-states D5). */
              <Show
                when={state.agentStripError !== null}
                fallback={
                  <span class="t-dense" style="color:var(--text3)">
                    <FigureSkeleton what="agent activity" size="note" />
                  </span>
                }
              >
                <Notice
                  tone="info"
                  title="Couldn’t load"
                  style={{ flex: '1 1 auto' }}
                  action={{ label: 'Retry', onClick: retryAgentStrip }}
                >
                  Agent activity couldn’t be loaded. Routing is unaffected.
                </Notice>
              </Show>
            }
          >
            <Show
              when={agentStrip().length > 0}
              fallback={
                <span class="t-dense" style="color:var(--text3)">
                  No agent activity in this range.
                </span>
              }
            >
              <For each={agentStrip()}>
                {(a) => (
                  <Show
                    when={a.filterable}
                    fallback={
                      /* Keyless traffic: shown so the total is honest, but an empty agent
                       id is a rejected filter, so there is no action to offer. */
                      <span
                        class="t-dense"
                        style="display:flex;align-items:center;gap:8px;color:var(--text3)"
                        title="Requests recorded without an agent key"
                      >
                        {a.label}
                        <span class="figure" style="font-size:0.6875rem">
                          {a.requests.toLocaleString()}
                        </span>
                      </span>
                    }
                  >
                    <button
                      type="button"
                      class="t-dense"
                      style="display:flex;align-items:center;gap:8px;color:var(--text2);cursor:pointer"
                      aria-label={`${a.label} — ${String(a.requests)} requests; show them`}
                      onClick={() => {
                        app.setAgentFilter(a.key);
                        app.go('requests');
                      }}
                    >
                      {a.label}
                      <span class="figure" style="font-size:0.6875rem;color:var(--text3)">
                        {a.requests.toLocaleString()}
                      </span>
                    </button>
                  </Show>
                )}
              </For>
              <Show when={state.agentStripTruncated}>
                <span class="t-caption" style="color:var(--text3)">
                  top {agentStrip().length} shown
                </span>
              </Show>
            </Show>
          </Show>
        </div>

        <div
          class="rs-wrap"
          style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding-top:8px;border-top:1px solid var(--border2)"
        >
          <span class="upper-label" style="letter-spacing:.05em">
            Providers
          </span>
          <Show
            when={state.providers.length > 0}
            fallback={
              <span class="t-dense" style="color:var(--text3)">
                None yet — add one under Providers.
              </span>
            }
          >
            <For each={state.providers}>
              {(p) => (
                <button
                  type="button"
                  class="t-dense"
                  style="display:flex;align-items:center;gap:8px;color:var(--text2);cursor:pointer"
                  aria-label={`${p.name} — ${
                    p.status === 'ok' ? 'healthy' : p.status === 'error' ? 'failing' : 'not tested'
                  }`}
                  title={
                    p.status === 'ok' ? 'healthy' : p.status === 'error' ? 'failing' : 'not tested'
                  }
                  onClick={() => app.go('providers')}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: '6px',
                      height: '6px',
                      'border-radius': '50%',
                      background:
                        p.status === 'ok'
                          ? 'var(--green)'
                          : p.status === 'error'
                            ? 'var(--red)'
                            : 'var(--faint)',
                    }}
                  />
                  {p.name}
                  {p.kind === 'local' ? ' · local' : ''}
                </button>
              )}
            </For>
          </Show>
        </div>
      </div>

      <div
        class="panel rs-table-panel rs-table-requests"
        style="overflow:hidden;border-radius:10px"
      >
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border2)">
          <div class="section-title">Recent requests</div>
          <button
            type="button"
            class="link-accent t-dense"

            onClick={() => app.go('requests')}
          >
            View all <Icon name="arrowRight" size={12} />
          </button>
        </div>
        <RequestTableHead />
        {/* Two live partitions, combined only here (D11): a job row can never be
            settled by an in-flight snapshot, nor a request row by a batch read. */}
        <Show when={state.batchRows.length > 0}>
          <BatchJobRows rows={state.batchRows} />
        </Show>
        <Show when={state.inflightRows.length > 0}>
          <InflightRows rows={state.inflightRows} />
        </Show>
        {/* A failed read's rows are removed under the notice, and the empty sentence is not
            shown in their place: a failed read is not a measured empty range. */}
        <Show when={recentLoad() === 'ready' && state.recentRequests.length > 0}>
          <RequestRows rows={state.recentRequests} />
        </Show>
        <Show
          when={
            recentLoad() !== 'failed' &&
            (recentLoad() === 'loading' || state.recentRequests.length === 0) &&
            state.inflightRows.length === 0 &&
            state.batchRows.length === 0
          }
        >
          <div class="t-dense" style="padding:16px;color:var(--text3)">
            {recentLoad() === 'loading' ? 'Loading…' : 'No requests in this range yet.'}
          </div>
        </Show>
      </div>
    </div>
  );
}
