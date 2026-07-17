import { createEffect, For, on, onCleanup, onMount, Show } from 'solid-js';
import { BarRows } from '../components/BarRows';
import { Chart } from '../components/Chart';
import { RangeSelector } from '../components/RangeSelector';
import { RequestRows, RequestTableHead } from '../components/RequestTable';
import { breakdownToSpend, bucketSeconds, pct, timeseriesToChart } from '../data/analytics';
import { rangeToParams } from '../data/range';
import { useApp } from '../state/context';

const POLL_MS = 15_000;

export function Overview(props: { live: boolean }) {
  const app = useApp();
  const { state } = app;

  // Load on mount + on range change; poll on a bounded interval (gated by `live`,
  // cleared on unmount). The requests list is not polled.
  createEffect(
    on(
      () => state.range,
      () => void app.loadOverview(),
    ),
  );
  onMount(() => {
    if (!props.live) return;
    const timer = setInterval(() => void app.loadOverview(), POLL_MS);
    onCleanup(() => clearInterval(timer));
  });

  const spend = () => state.analyticsSummary?.spend ?? 0;
  const reqs = () => state.analyticsSummary?.requests ?? 0;
  const tin = () => state.analyticsSummary?.inputTokens ?? 0;
  const tout = () => state.analyticsSummary?.outputTokens ?? 0;
  const successCount = () => state.analyticsSummary?.successCount ?? 0;
  const fallbackCount = () => state.analyticsSummary?.fallbackCount ?? 0;
  const escalatedCount = () => state.analyticsSummary?.escalatedCount ?? 0;
  const chartData = () =>
    timeseriesToChart(state.analyticsSeries, bucketSeconds(rangeToParams(state.range, Date.now()).bucket));
  const errorMsg = () =>
    state.analyticsSummaryError ??
    state.analyticsSeriesError ??
    state.analyticsBreakdownError ??
    state.recentRequestsError;

  return (
    <div style="padding:22px 26px;display:flex;flex-direction:column;gap:14px;max-width:1200px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="section-title">Overview · {state.range}</div>
        <RangeSelector />
      </div>

      <Show when={errorMsg()}>
        {(msg) => (
          <div style="display:flex;align-items:center;gap:10px;padding:9px 14px;background:var(--red-bg);border:1px solid var(--red);border-radius:8px;font:500 12px 'Geist',sans-serif;color:var(--red)">
            <span style="flex:1">Couldn’t load analytics — {msg()}</span>
            <button
              type="button"
              class="link-accent"
              style="font-weight:600"
              onClick={() => void app.loadOverview()}
            >
              Retry
            </button>
          </div>
        )}
      </Show>

      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px">
        <div class="panel card">
          <div class="stat-label">Spend · {state.range}</div>
          <div class="stat-value">${spend().toFixed(2)}</div>
          <div class="stat-sub">
            {state.analyticsSummary?.estimatedCount ?? 0} flagged ~estimated
          </div>
        </div>
        <div class="panel card">
          <div class="stat-label">Requests</div>
          <div class="stat-value">{reqs().toLocaleString()}</div>
          <div class="stat-sub">
            {state.analyticsSummaryLoading && state.analyticsSummary === null ? 'loading…' : ' '}
          </div>
        </div>
        <div class="panel card">
          <div class="stat-label">Tokens</div>
          <div class="stat-value">{((tin() + tout()) / 1e6).toFixed(2)}M</div>
          <div class="stat-sub">
            {(tin() / 1e6).toFixed(2)}M in · {(tout() / 1e6).toFixed(2)}M out
          </div>
        </div>
        <div class="panel card">
          <div class="stat-label">Success rate</div>
          <div class="stat-value">{reqs() === 0 ? '—' : pct(successCount(), reqs())}</div>
          <div class="stat-sub">
            {reqs() === 0
              ? 'no requests yet'
              : `fallback ${pct(fallbackCount(), reqs())} · escalated ${pct(escalatedCount(), reqs())}`}
          </div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 300px;gap:12px">
        <div class="panel card">
          <div class="section-title" style="margin-bottom:12px">
            Requests · {state.range}
          </div>
          <Show
            when={state.analyticsSeries.length > 0}
            fallback={
              <div style="height:150px;display:flex;align-items:center;justify-content:center;font:400 12px 'Geist',sans-serif;color:var(--text3)">
                {state.analyticsSeriesLoading ? 'Loading…' : 'No requests in this range'}
              </div>
            }
          >
            <Chart data={chartData()} label="requests" height={150} />
          </Show>
        </div>
        <div class="panel card">
          <div class="section-title" style="margin-bottom:14px">
            Spend by model
          </div>
          <Show
            when={state.analyticsBreakdown.model.length > 0}
            fallback={
              <div style="font:400 12px 'Geist',sans-serif;color:var(--text3)">
                {state.analyticsBreakdownLoading ? 'Loading…' : 'No spend in this range'}
              </div>
            }
          >
            <BarRows data={breakdownToSpend(state.analyticsBreakdown.model)} />
          </Show>
        </div>
      </div>

      <div
        class="panel"
        style="display:flex;align-items:center;gap:16px;padding:11px 18px;flex-wrap:wrap;border-radius:10px"
      >
        <span class="upper-label" style="letter-spacing:.05em">
          Providers
        </span>
        <Show
          when={state.providers.length > 0}
          fallback={
            <span style="font:400 12px 'Geist',sans-serif;color:var(--text3)">
              None yet — add one under Providers.
            </span>
          }
        >
          <For each={state.providers}>
            {(p) => (
              <button
                type="button"
                style="display:flex;align-items:center;gap:6px;font:400 12px 'Geist',sans-serif;color:var(--text2);cursor:pointer"
                aria-label={`${p.name} — ${
                  p.status === 'ok' ? 'healthy' : p.status === 'error' ? 'failing' : 'not tested'
                }`}
                title={p.status === 'ok' ? 'healthy' : p.status === 'error' ? 'failing' : 'not tested'}
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

      <div class="panel" style="overflow:hidden;border-radius:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:13px 18px;border-bottom:1px solid var(--border2)">
          <div class="section-title">Recent requests</div>
          <button
            type="button"
            class="link-accent"
            style="font:400 12px 'Geist',sans-serif"
            onClick={() => app.go('requests')}
          >
            View all →
          </button>
        </div>
        <RequestTableHead />
        <Show
          when={state.recentRequests.length > 0}
          fallback={
            <div style="padding:16px 18px;font:400 12px 'Geist',sans-serif;color:var(--text3)">
              {state.recentRequestsLoading ? 'Loading…' : 'No requests in this range yet.'}
            </div>
          }
        >
          <RequestRows rows={state.recentRequests} />
        </Show>
      </div>
    </div>
  );
}
