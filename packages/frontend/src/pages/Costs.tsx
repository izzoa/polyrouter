import { createEffect, on, Show } from 'solid-js';
import { BarRows } from '../components/BarRows';
import { RangeSelector } from '../components/RangeSelector';
import { Segmented } from '../components/Segmented';
import { breakdownToSpend, breakdownToTokens, fmtTokens } from '../data/analytics';
import type { BreakdownMetric, BreakdownRow } from '../data/api';
import { createPoller } from '../data/poller';
import { useApp } from '../state/context';

const POLL_MS = 15_000;

/** A reactive breakdown panel (props are Solid getters, so it re-renders as the breakdown
 * slice loads / the range or metric changes).
 *
 * `stale` blanks the rows while a refetch is in flight for a DIFFERENT metric: the rows
 * stay mounted during loading, so without it flipping the selector would show dollar
 * values under a "tokens" heading until the response landed. */
function BreakdownPanel(props: {
  title: string;
  rows: BreakdownRow[];
  loading: boolean;
  metric: BreakdownMetric;
  stale: boolean;
}) {
  const tokens = (): boolean => props.metric === 'tokens';
  const data = () => (tokens() ? breakdownToTokens(props.rows) : breakdownToSpend(props.rows));
  return (
    <div class="panel card">
      <div class="section-title" style="margin-bottom:14px">
        {props.title}
      </div>
      <Show
        when={props.rows.length > 0 && !props.stale}
        fallback={
          <div style="font:400 12px 'Geist',sans-serif;color:var(--text3)">
            {props.loading || props.stale
              ? 'Loading…'
              : tokens()
                ? 'No usage in this range'
                : 'No spend in this range'}
          </div>
        }
      >
        <BarRows data={data()} {...(tokens() ? { format: fmtTokens } : {})} />
      </Show>
    </div>
  );
}

const METRIC_OPTIONS = [
  { id: 'spend' as BreakdownMetric, label: 'spend' },
  { id: 'tokens' as BreakdownMetric, label: 'tokens' },
];

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

  const spend = () => state.analyticsSummary?.spend ?? 0;
  const estimated = () => state.analyticsSummary?.estimatedCount ?? 0;
  const nativeSpend = () => state.analyticsSummary?.nativeFamilySpend ?? 0;
  const free = () => state.analyticsSummary?.freeRequests ?? 0;
  const unpriced = () => state.analyticsSummary?.unpricedRequests ?? 0;
  // Priced requests split by what actually costs money. `paidRequests` remains the
  // priced TOTAL for API consumers; the card shows the two halves.
  const subPriced = () => state.analyticsSummary?.subscriptionPricedRequests ?? 0;
  const cashPriced = () => state.analyticsSummary?.cashPricedRequests ?? 0;
  const total = () => free() + subPriced() + cashPriced() + unpriced();
  const segPct = (n: number): number => (total() === 0 ? 0 : Math.round((n / total()) * 100));
  /** A non-zero category must stay visible rather than rounding to an invisible sliver. */
  const segWidth = (n: number): number => (n > 0 ? Math.max(segPct(n), 2) : 0);
  // `spend` is cash + unclassified; `cashSpend` is strictly-known cash. Showing the
  // unclassified part separately keeps the headline from claiming precision it lacks.
  const subSpend = () => state.analyticsSummary?.subscriptionSpend ?? 0;
  const unknownSpend = () => state.analyticsSummary?.unknownSpend ?? 0;

  return (
    <div class="rs-page" style="display:flex;flex-direction:column;gap:14px;max-width:1200px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="section-title">Costs · {state.range}</div>
        <RangeSelector />
      </div>

      <Show when={state.analyticsSummaryError ?? state.analyticsBreakdownError}>
        {(msg) => (
          <div style="display:flex;align-items:center;gap:10px;padding:9px 14px;background:var(--red-bg);border:1px solid var(--red);border-radius:8px;font:500 12px 'Geist',sans-serif;color:var(--red)">
            <span style="flex:1">Couldn’t load cost analytics — {msg()}</span>
            <button
              type="button"
              class="link-accent"
              style="font-weight:600"
              onClick={() => void app.loadCosts()}
            >
              Retry
            </button>
          </div>
        )}
      </Show>

      <div class="rs-grid-3" style="display:grid;gap:12px">
        <div class="panel card">
          <div class="stat-label">Spend · {state.range}</div>
          <div class="stat-value">${spend().toFixed(2)}</div>
          <div class="stat-sub">
            both ledgers, excludes subscription ·{' '}
            <span style="color:var(--text3)">{estimated()} requests ~estimated</span>
            <Show when={nativeSpend() > 0}>
              <span style="color:var(--text3)">
                {' '}· includes ${nativeSpend().toFixed(4)} estimate-priced
              </span>
            </Show>
            {/* Prepaid traffic is NOT added to the headline — it is money already spent
                on a flat-rate plan. Shown beside it so the figure stays visible and the
                old combined total is still reconstructable. Absent, not "$0.00", when
                the range has none. */}
            <Show when={subSpend() > 0}>
              <div style="color:var(--accent-deep);margin-top:2px">
                + ${subSpend().toFixed(4)} served on subscription
              </div>
            </Show>
            <Show when={unknownSpend() > 0}>
              <div style="color:var(--text3);margin-top:2px">
                includes ${unknownSpend().toFixed(4)} recorded before subscription
                tracking — cannot be classified
              </div>
            </Show>
          </div>
        </div>
        <div class="panel card">
          <div class="stat-label">Free vs prepaid vs paid</div>
          {/* The two PRICED categories are two intensities of the one accent, adjacent,
              so they still read as a single "paid" block subdivided — a second hue would
              break the single-accent lock (green/amber/red are semantic status only). */}
          <div
            data-testid="mix-bar"
            style="display:flex;height:10px;border-radius:5px;overflow:hidden;margin:14px 0 8px;background:var(--chip)"
          >
            <div style={{ width: `${String(segWidth(free()))}%`, background: 'var(--green)' }} />
            <div
              style={{ width: `${String(segWidth(subPriced()))}%`, background: 'var(--accent-bg)' }}
            />
            <div
              style={{ width: `${String(segWidth(cashPriced()))}%`, background: 'var(--accent)' }}
            />
            <div style={{ width: `${String(segWidth(unpriced()))}%`, background: 'var(--faint)' }} />
          </div>
          {/* Counts beside percentages: this card is routinely rendered over samples
              small enough that a percentage alone implies precision the sample lacks. */}
          <div style="display:flex;gap:12px;font:400 11px 'Geist',sans-serif;color:var(--text3);flex-wrap:wrap">
            <span>
              <span style="color:var(--green-text)">■</span> free {segPct(free())}% ({free()})
            </span>
            <span>
              <span style="color:var(--accent-deep)">■</span> subscription{' '}
              {segPct(subPriced())}% ({subPriced()})
            </span>
            <span>
              <span style="color:var(--accent)">■</span> other priced {segPct(cashPriced())}% (
              {cashPriced()})
            </span>
            <span>
              <span style="color:var(--faint)">■</span> unpriced {segPct(unpriced())}% (
              {unpriced()})
            </span>
          </div>
          <div style="font:400 10.5px 'Geist',sans-serif;color:var(--text3);margin-top:6px">
            By request count. Subscription requests are prepaid at a flat rate, so their
            cost is reported separately rather than counted as spend.
          </div>
        </div>
        <div class="panel card">
          <div class="stat-label">Cost integrity</div>
          <div style="font:400 12px 'Geist',sans-serif;color:var(--text2);line-height:1.55">
            Every request stores its{' '}
            <span class="mono" style="font-size:11px">
              price snapshot
            </span>{' '}
            — catalog updates never rewrite history.{' '}
            <span style="color:var(--text3)">{estimated()} requests flagged ~estimated.</span>
          </div>
        </div>
      </div>

      {/* ONE selector for all three panels: re-ranking model, provider and agent together
          is what makes the comparison legible, and three independent metric states on one
          screen is more machinery than the question deserves. */}
      <div class="rs-wrap" style="display:flex;align-items:center;justify-content:space-between;gap:10px">
        <div style="font:400 12px 'Geist',sans-serif;color:var(--text3)">
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

      <div class="rs-grid-2" style="display:grid;gap:12px">
        <BreakdownPanel
          title={`${metric() === 'tokens' ? 'Tokens' : 'Spend'} by model · ${state.range}`}
          rows={state.analyticsBreakdown.model}
          loading={state.analyticsBreakdownLoading}
          metric={metric()}
          stale={stale()}
        />
        <div style="display:flex;flex-direction:column;gap:12px">
          <BreakdownPanel
            title="By provider"
            rows={state.analyticsBreakdown.provider}
            loading={state.analyticsBreakdownLoading}
            metric={metric()}
            stale={stale()}
          />
          <BreakdownPanel
            title="By agent"
            rows={state.analyticsBreakdown.agent}
            loading={state.analyticsBreakdownLoading}
            metric={metric()}
            stale={stale()}
          />
        </div>
      </div>
    </div>
  );
}
