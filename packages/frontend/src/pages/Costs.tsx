import { createEffect, on, Show } from 'solid-js';
import { BreakdownPanel, METRIC_OPTIONS } from '../components/BreakdownPanel';
import { createHeldFailure, Notice } from '../components/Notice';
import { ReadoutStrip } from '../components/ReadoutStrip';
import { RangeSelector } from '../components/RangeSelector';
import { Segmented } from '../components/Segmented';
import type { BreakdownMetric } from '../data/api';
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
  const spend = () => state.analyticsSummary?.spend ?? 0;
  const estimated = () => state.analyticsSummary?.estimatedCount ?? 0;
  const nativeSpend = () => state.analyticsSummary?.nativeFamilySpend ?? 0;
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
  // `spend` is cash + unclassified; `cashSpend` is strictly-known cash. Showing the
  // unclassified part separately keeps the headline from claiming precision it lacks.
  const subSpend = () => state.analyticsSummary?.subscriptionSpend ?? 0;
  const unknownSpend = () => state.analyticsSummary?.unknownSpend ?? 0;

  return (
    <div class="rs-page" style="display:flex;flex-direction:column;gap:24px;max-width:1200px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="section-title">Costs · {state.range}</div>
        <RangeSelector />
      </div>

      {/* Info, not Failure (D15): adopt-figure-states requires a failed figure load to show a
          neutral notice, and rewrites only its body. */}
      <Show when={failure.message()}>
        {(msg) => (
          <Notice
            tone="info"
            title="Couldn’t load"
            action={{
              label: 'Retry',
              onClick: () => {
                failure.release();
                void app.loadCosts();
              },
            }}
          >
            Couldn’t load cost analytics — {msg()}
          </Notice>
        )}
      </Show>

      {/* The headline figures as one readout strip (adopt-design-tokens-v2 task 12.2, D10).
          Spend is the view's one Display figure, still qualified as both ledgers and excluding
          subscription, with its estimated count and — when the range holds any — the spend that
          predates subscription tracking. Subscription value and the estimate-priced portion each
          get their own cell, ABSENT rather than "$0" when the range holds none, and each says
          how it relates to the headline: the "+" and "includes" the old sub-line carried. */}
      <ReadoutStrip
        focal={{
          id: 'spend',
          label: `Spend · ${state.range}`,
          figure: `$${spend().toFixed(2)}`,
          sub: (
            <>
              both ledgers, excludes subscription · {estimated()} requests ~estimated
              <Show when={unknownSpend() > 0}>
                <div>
                  includes ${unknownSpend().toFixed(4)} recorded before subscription tracking —
                  cannot be classified
                </div>
              </Show>
            </>
          ),
        }}
        cells={[
          // Prepaid traffic is NOT added to the headline — it is money already spent on a
          // flat-rate plan. Shown beside it so the figure stays visible and the old combined
          // total is still reconstructable.
          ...(subSpend() > 0
            ? [
                {
                  id: 'subscription',
                  label: 'Served on subscription',
                  figure: `$${subSpend().toFixed(4)}`,
                  sub: 'excluded from spend',
                },
              ]
            : []),
          ...(nativeSpend() > 0
            ? [
                {
                  id: 'estimate-priced',
                  label: 'Estimate-priced',
                  figure: `$${nativeSpend().toFixed(4)}`,
                  sub: 'included in spend',
                },
              ]
            : []),
        ]}
      />

      {/* The request mix and cost integrity stay panels, below the strip. */}
      <div class="rs-grid-2" style="display:grid;gap:16px">
        <div class="panel card">
          <div class="stat-label">Free vs prepaid vs paid</div>
          {/* The two PRICED categories are two intensities of the one accent, adjacent,
              so they still read as a single "paid" block subdivided — a second hue would
              break the single-accent lock (green/amber/red are semantic status only). */}
          <div
            data-testid="mix-bar"
            data-series="focal"
            data-measure="request-mix"
            style="display:flex;height:10px;border-radius:4px;overflow:hidden;margin:16px 0 8px;background:var(--chip)"
          >
            <div style={{ width: `${String(segWidth(free()))}%`, background: 'var(--green)' }} />
            <div
              style={{ width: `${String(segWidth(subPriced()))}%`, background: 'var(--accent-bg)' }}
            />
            <div
              style={{ width: `${String(segWidth(cashPriced()))}%`, background: 'var(--accent)' }}
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
              free {segPct(free())}% ({free()})
            </span>
            <span>
              <span
                aria-hidden="true"
                style="display:inline-block;width:8px;height:8px;border-radius:4px;background:var(--accent-deep);vertical-align:0.02em"
              />{' '}
              subscription {segPct(subPriced())}% ({subPriced()})
            </span>
            <span>
              <span
                aria-hidden="true"
                style="display:inline-block;width:8px;height:8px;border-radius:4px;background:var(--accent);vertical-align:0.02em"
              />{' '}
              other priced {segPct(cashPriced())}% ({cashPriced()})
            </span>
            <span>
              <span
                aria-hidden="true"
                style="display:inline-block;width:8px;height:8px;border-radius:4px;background:var(--faint);vertical-align:0.02em"
              />{' '}
              unpriced {segPct(unpriced())}% ({unpriced()})
            </span>
          </div>
          <div class="t-caption" style="color:var(--text3);margin-top:8px">
            By request count. Subscription requests are prepaid at a flat rate, so their cost is
            reported separately rather than counted as spend.
          </div>
          <Show when={notBilled() > 0}>
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
            Every request stores its price snapshot — catalog updates never rewrite history.{' '}
            <span style="color:var(--text3)">{estimated()} requests flagged ~estimated.</span>
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
          loading={state.analyticsBreakdownLoading}
          metric={metric()}
          stale={stale()}
        />
        <div style="display:flex;flex-direction:column;gap:16px">
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
