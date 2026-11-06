import { createEffect, createMemo, Match, on, Show, Switch } from 'solid-js';
import { BreakdownPanel, METRIC_OPTIONS } from '../components/BreakdownPanel';
import { createHeldFailure, Notice } from '../components/Notice';
import { ReadoutStrip, type ReadoutCell, type ReadoutFocalCell } from '../components/ReadoutStrip';
import { FigureSkeleton } from '../components/FigureSkeleton';
import { FigureText } from '../components/FigureText';
import { RangeSelector } from '../components/RangeSelector';
import { Segmented } from '../components/Segmented';
import type { BreakdownMetric } from '../data/api';
import { createFigureLoad } from '../data/figureLoad';
import { estimatedUsageText, microsOfUsd, money, share, unpricedCountParts } from '../data/figures';
import { createPoller } from '../data/poller';
import { useApp } from '../state/context';

const POLL_MS = 15_000;

export function Costs(props: { live: boolean }) {
  const app = useApp();
  const { state } = app;
  const metric = (): BreakdownMetric => state.breakdownMetric;
  /** True while the rows on screen belong to a different range/metric than the one
   * selected — they are not merely old, they are labelled wrongly. */
  const stale = (): boolean => {
    const l = state.breakdownLoadedFor;
    return l === null || l.metric !== state.breakdownMetric || l.range !== state.range;
  };

  // Not deferred → this covers the mount load, hence `runImmediately: false` below.
  createEffect(
    on(
      () => state.range,
      () => void app.loadCosts(),
    ),
  );
  createPoller({
    fn: (reason) => app.requestAggregateRefresh(() => app.loadCosts(), reason === 'resume'),
    intervalMs: () => POLL_MS,
    enabled: () => props.live,
    runImmediately: false,
  });

  // The load-failure notice is held across the 15-second poll (D15): both slices clear their
  // error as they start, which would otherwise re-insert, and re-announce, the notice.
  const failure = createHeldFailure(
    () => state.analyticsSummaryError ?? state.analyticsBreakdownError,
    () => state.analyticsSummaryLoading || state.analyticsBreakdownLoading,
  );
  const estimated = () => state.analyticsSummary?.estimatedCount ?? 0;
  const free = () => state.analyticsSummary?.freeRequests ?? 0;
  const unpriced = () => state.analyticsSummary?.unpricedRequests ?? 0;
  // Requests no provider ran (zero-cost-unbilled-errors). NOT a fifth mix category and not
  // in `total()`: the four segments are computed over requests that ran, and this count is
  // disclosed as one muted caption so the mix does not silently lose rows.
  const notBilled = () => state.analyticsSummary?.notBilledRequests ?? 0;
  // Priced requests split by what actually costs money. `paidRequests` remains the
  // priced TOTAL for API consumers; the card shows the two halves.
  const subPriced = () => state.analyticsSummary?.subscriptionPricedRequests ?? 0;
  const cashPriced = () => state.analyticsSummary?.cashPricedRequests ?? 0;
  const total = () => free() + subPriced() + cashPriced() + unpriced();
  const segPct = (n: number): number => (total() === 0 ? 0 : Math.round((n / total()) * 100));
  /** A non-zero category must stay visible rather than rounding to an invisible sliver. */
  const segWidth = (n: number): number => (n > 0 ? Math.max(segPct(n), 2) : 0);
  /** A legend share in words: a zero total has no share, so it reads `not applicable`, never
   * `0%` (adopt-figure-states D5); the count beside it stays, a measured `(0)`. */
  const segShare = (n: number): string => share(n, total());

  /** The strip's figures come from the summary read alone (adopt-figure-states D5, D11). So
   * do the request mix, its not-billed caption and the cost-integrity count below: the same
   * state gates them, so none shows a zero while the summary loads or a failed read's
   * figures as current. */
  const stripState = createFigureLoad({
    error: () => state.analyticsSummaryError,
    loading: () => state.analyticsSummaryLoading,
    loaded: () => state.analyticsSummary !== null,
    failureShown: () => failure.message() !== null,
  });
  /** The breakdown bars' figure load: their own slice, and never rows labelled for another
   * range or metric (adopt-figure-states D5). */
  const breakdownLoad = createFigureLoad({
    error: () => state.analyticsBreakdownError,
    loading: () => state.analyticsBreakdownLoading,
    loaded: () => !stale(),
    failureShown: () => failure.message() !== null,
  });
  const breakdownWhat = (dimension: string): string =>
    `${metric() === 'tokens' ? 'tokens' : 'spend'} by ${dimension}`;
  /** Retry's landing spot: the strip's panel stays through the failure and the retry. */
  let stripPanel: HTMLDivElement | undefined;

  /** The headline figures as one readout strip (adopt-design-tokens-v2 task 12.2, D10). Spend
   * is the view's one Display figure, still qualified as both ledgers and excluding
   * subscription, with its estimated-usage count and — when the range holds any — the spend
   * that predates subscription tracking. Subscription value and the estimate-priced portion
   * each get their own cell, ABSENT rather than "$0" when the range holds none, and each says
   * how it relates to the headline. On first load only Spend loads, as a skeleton; the two
   * conditional cells stay absent until the summary says they are non-zero, and a failed read
   * removes every figure (adopt-figure-states D11). */
  const readout = (): { focal: ReadoutFocalCell; cells: ReadoutCell[] } => {
    const st = stripState();
    const s = state.analyticsSummary;
    const label = `Spend · ${state.range}`;
    if (st !== 'ready' || s === null) {
      return {
        focal: {
          id: 'spend',
          label,
          figure: st === 'loading' ? <FigureSkeleton what="spend" size="display" /> : '',
          sub: '',
        },
        cells: [],
      };
    }
    const unpriced = unpricedCountParts(s.unpricedRequests);
    const usage = estimatedUsageText(s.estimatedCount);
    // `spend` is cash + unclassified; `cashSpend` is strictly-known cash. Showing the
    // unclassified part separately keeps the headline from claiming precision it lacks.
    const unknown = microsOfUsd(s.unknownSpend);
    const subscription = microsOfUsd(s.subscriptionSpend);
    const estimatePriced = microsOfUsd(s.nativeFamilySpend);
    return {
      focal: {
        id: 'spend',
        label,
        figure: money(microsOfUsd(s.spend), 'cents'),
        qualifier: unpriced.length > 0 ? <FigureText parts={unpriced} /> : undefined,
        sub: (
          <>
            both ledgers, excludes subscription{usage === null ? '' : ` · ${usage}`}
            <Show when={unknown > 0}>
              <div>
                includes {money(unknown, 'cents')} recorded before subscription tracking — cannot be
                classified
              </div>
            </Show>
          </>
        ),
      },
      cells: [
        // Prepaid traffic is NOT added to the headline — it is money already spent on a
        // flat-rate plan. Shown beside it so the figure stays visible and the old combined
        // total is still reconstructable.
        ...(subscription > 0
          ? [
              {
                id: 'subscription',
                label: 'Served on subscription',
                figure: money(subscription, 'cents'),
                sub: 'excluded from spend',
              },
            ]
          : []),
        // Costs' estimate-priced disclosure, at four decimals (adopt-figure-states D2, D3).
        ...(estimatePriced > 0
          ? [
              {
                id: 'estimate-priced',
                label: 'Estimate-priced',
                figure: money(estimatePriced, 'four'),
                sub: 'included in spend',
              },
            ]
          : []),
      ],
    };
  };
  /** Built once per change, so each figure's nodes are created once and inserted once. */
  const strip = createMemo(readout);

  return (
    <div class="rs-page" style="display:flex;flex-direction:column;gap:24px;max-width:1200px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="section-title">Costs · {state.range}</div>
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
              void app.loadCosts();
              queueMicrotask(() => stripPanel?.focus());
            },
          }}
        >
          Cost analytics couldn’t be loaded. Routing is unaffected.
        </Notice>
      </Show>

      <ReadoutStrip
        focal={strip().focal}
        cells={strip().cells}
        focusTarget={(el) => {
          stripPanel = el;
        }}
      />

      {/* The request mix and cost integrity stay panels, below the strip. */}
      <div class="rs-grid-2" style="display:grid;gap:16px">
        <div class="panel card">
          <div class="stat-label">Free vs prepaid vs paid</div>
          {/* The mix is figures from the summary read: a skeleton while it first loads,
              nothing under the page's notice when it failed, never zeros standing in for
              either (adopt-figure-states D5). */}
          <Switch>
            <Match when={stripState() === 'loading'}>
              <div data-testid="mix-loading" style="margin:16px 0 8px">
                <FigureSkeleton what="request mix" size="bar" />
              </div>
            </Match>
            <Match when={stripState() === 'ready'}>
              {/* The two PRICED categories are two intensities of the one accent, adjacent,
                  so they still read as a single "paid" block subdivided — a second hue would
                  break the single-accent lock (green/amber/red are semantic status only). */}
              <div
                data-testid="mix-bar"
                data-series="focal"
                data-measure="request-mix"
                style="display:flex;height:10px;border-radius:4px;overflow:hidden;margin:16px 0 8px;background:var(--chip)"
              >
                <div
                  style={{ width: `${String(segWidth(free()))}%`, background: 'var(--green)' }}
                />
                <div
                  style={{
                    width: `${String(segWidth(subPriced()))}%`,
                    background: 'var(--accent-bg)',
                  }}
                />
                <div
                  style={{
                    width: `${String(segWidth(cashPriced()))}%`,
                    background: 'var(--accent)',
                  }}
                />
                <div
                  style={{ width: `${String(segWidth(unpriced()))}%`, background: 'var(--faint)' }}
                />
              </div>
              {/* Counts beside percentages: this card is routinely rendered over samples
                  small enough that a percentage alone implies precision the sample lacks. */}
              {/* The legend keys the same measure: its two accent squares belong to the request
                  mix, the Costs page's one indigo series (adopt-design-tokens-v2 D11). */}
              <div
                class="t-caption"
                data-series="focal"
                data-measure="request-mix"
                style="display:flex;gap:12px;color:var(--text3);flex-wrap:wrap"
              >
                <span>
                  <span
                    aria-hidden="true"
                    style="display:inline-block;width:8px;height:8px;border-radius:4px;background:var(--green-text);vertical-align:0.02em"
                  />{' '}
                  free {segShare(free())} ({free()})
                </span>
                <span>
                  <span
                    aria-hidden="true"
                    style="display:inline-block;width:8px;height:8px;border-radius:4px;background:var(--accent-deep);vertical-align:0.02em"
                  />{' '}
                  subscription {segShare(subPriced())} ({subPriced()})
                </span>
                <span>
                  <span
                    aria-hidden="true"
                    style="display:inline-block;width:8px;height:8px;border-radius:4px;background:var(--accent);vertical-align:0.02em"
                  />{' '}
                  other priced {segShare(cashPriced())} ({cashPriced()})
                </span>
                <span>
                  <span
                    aria-hidden="true"
                    style="display:inline-block;width:8px;height:8px;border-radius:4px;background:var(--faint);vertical-align:0.02em"
                  />{' '}
                  unpriced {segShare(unpriced())} ({unpriced()})
                </span>
              </div>
            </Match>
          </Switch>
          <div class="t-caption" style="color:var(--text3);margin-top:8px">
            By request count. Subscription requests are prepaid at a flat rate, so their cost is
            reported separately rather than counted as spend.
          </div>
          <Show when={stripState() === 'ready' && notBilled() > 0}>
            <div
              data-testid="not-billed-caption"
              class="t-caption"
              style="color:var(--text3);margin-top:4px"
            >
              {notBilled()} not billed — requests no provider ran, so they are not in the mix above.
            </div>
          </Show>
        </div>
        <div class="panel card">
          <div class="stat-label">Cost integrity</div>
          <div class="t-dense" style="color:var(--text2)">
            Every request stores its price snapshot — catalog updates never rewrite history.
            {/* The estimated-usage count in words, absent at zero (adopt-figure-states D3),
                and, like the strip's conditional cells, absent until the summary commits and
                after a failed read. */}
            <Show when={stripState() === 'ready' && estimatedUsageText(estimated())}>
              {(usage) => (
                <>
                  {' '}
                  <span style="color:var(--text3)">{usage()}.</span>
                </>
              )}
            </Show>
          </div>
        </div>
      </div>

      {/* ONE selector for all three panels: re-ranking model, provider and agent together
          is what makes the comparison legible, and three independent metric states on one
          screen is more machinery than the question deserves. */}
      <div
        class="rs-wrap"
        style="display:flex;align-items:center;justify-content:space-between;gap:8px"
      >
        <div class="t-dense" style="color:var(--text3)">
          {metric() === 'tokens'
            ? 'Ranked by tokens consumed — all recorded work, including cached and superseded cascade attempts.'
            : 'Ranked by spend — excludes subscription-backed traffic.'}
        </div>
        <Segmented
          options={METRIC_OPTIONS}
          value={metric()}
          onChange={(m) => {
            app.setBreakdownMetric(m);
          }}
        />
      </div>

      <div class="rs-grid-2" style="display:grid;gap:16px">
        <BreakdownPanel
          title={`${metric() === 'tokens' ? 'Tokens' : 'Spend'} by model · ${state.range}`}
          rows={state.analyticsBreakdown.model}
          load={breakdownLoad()}
          metric={metric()}
          what={breakdownWhat('model')}
        />
        <div style="display:flex;flex-direction:column;gap:16px">
          <BreakdownPanel
            title="By provider"
            rows={state.analyticsBreakdown.provider}
            load={breakdownLoad()}
            metric={metric()}
            what={breakdownWhat('provider')}
          />
          <BreakdownPanel
            title="By agent"
            rows={state.analyticsBreakdown.agent}
            load={breakdownLoad()}
            metric={metric()}
            what={breakdownWhat('agent')}
          />
        </div>
      </div>
    </div>
  );
}
