import { createEffect, on, onCleanup, onMount, Show } from 'solid-js';
import { BarRows } from '../components/BarRows';
import { RangeSelector } from '../components/RangeSelector';
import { breakdownToSpend } from '../data/analytics';
import type { BreakdownRow } from '../data/api';
import { useApp } from '../state/context';

const POLL_MS = 15_000;

/** A reactive spend-breakdown panel (props are Solid getters, so it re-renders as
 * the breakdown slice loads / the range changes). */
function BreakdownPanel(props: { title: string; rows: BreakdownRow[]; loading: boolean }) {
  return (
    <div class="panel card">
      <div class="section-title" style="margin-bottom:14px">
        {props.title}
      </div>
      <Show
        when={props.rows.length > 0}
        fallback={
          <div style="font:400 12px 'Geist',sans-serif;color:var(--text3)">
            {props.loading ? 'Loading…' : 'No spend in this range'}
          </div>
        }
      >
        <BarRows data={breakdownToSpend(props.rows)} />
      </Show>
    </div>
  );
}

export function Costs(props: { live: boolean }) {
  const app = useApp();
  const { state } = app;

  createEffect(
    on(
      () => state.range,
      () => void app.loadCosts(),
    ),
  );
  onMount(() => {
    if (!props.live) return;
    const timer = setInterval(() => void app.loadCosts(), POLL_MS);
    onCleanup(() => clearInterval(timer));
  });

  const spend = () => state.analyticsSummary?.spend ?? 0;
  const estimated = () => state.analyticsSummary?.estimatedCount ?? 0;
  const free = () => state.analyticsSummary?.freeRequests ?? 0;
  const paid = () => state.analyticsSummary?.paidRequests ?? 0;
  const unpriced = () => state.analyticsSummary?.unpricedRequests ?? 0;
  const total = () => free() + paid() + unpriced();
  const segPct = (n: number): number => (total() === 0 ? 0 : Math.round((n / total()) * 100));

  return (
    <div style="padding:22px 26px;display:flex;flex-direction:column;gap:14px;max-width:1200px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="section-title">Costs · {state.range}</div>
        <RangeSelector />
      </div>

      <Show when={state.analyticsSummaryError ?? state.analyticsBreakdownError}>
        {(msg) => (
          <div style="display:flex;align-items:center;gap:10px;padding:9px 14px;background:var(--red-bg);border:1px solid var(--red);border-radius:8px;font:500 12px 'Geist',sans-serif;color:var(--red)">
            <span style="flex:1">Couldn’t load cost analytics — {msg()}</span>
            <span
              class="link-accent"
              style="cursor:pointer;font-weight:600"
              onClick={() => void app.loadCosts()}
            >
              Retry
            </span>
          </div>
        )}
      </Show>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
        <div class="panel card">
          <div class="stat-label">Spend · {state.range}</div>
          <div class="stat-value">${spend().toFixed(2)}</div>
          <div class="stat-sub">
            both ledgers · <span style="color:var(--text3)">{estimated()} requests ~estimated</span>
          </div>
        </div>
        <div class="panel card">
          <div class="stat-label">Free vs paid vs unpriced</div>
          <div style="display:flex;height:10px;border-radius:5px;overflow:hidden;margin:14px 0 8px;background:var(--chip)">
            <div style={{ width: `${String(segPct(free()))}%`, background: 'var(--green)' }} />
            <div style={{ width: `${String(segPct(paid()))}%`, background: 'var(--accent)' }} />
            <div style={{ width: `${String(segPct(unpriced()))}%`, background: 'var(--faint)' }} />
          </div>
          <div style="display:flex;gap:12px;font:400 11px 'Geist',sans-serif;color:var(--text3);flex-wrap:wrap">
            <span>
              <span style="color:var(--green)">■</span> {segPct(free())}% free
            </span>
            <span>
              <span style="color:var(--accent)">■</span> {segPct(paid())}% paid
            </span>
            <span>
              <span style="color:var(--faint)">■</span> {segPct(unpriced())}% unpriced
            </span>
          </div>
          <div style="font:400 10.5px 'Geist',sans-serif;color:var(--faint);margin-top:6px">
            By request count. Subscription/API split lands in a later change.
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

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <BreakdownPanel
          title={`Spend by model · ${state.range}`}
          rows={state.analyticsBreakdown.model}
          loading={state.analyticsBreakdownLoading}
        />
        <div style="display:flex;flex-direction:column;gap:12px">
          <BreakdownPanel
            title="By provider"
            rows={state.analyticsBreakdown.provider}
            loading={state.analyticsBreakdownLoading}
          />
          <BreakdownPanel
            title="By agent"
            rows={state.analyticsBreakdown.agent}
            loading={state.analyticsBreakdownLoading}
          />
        </div>
      </div>
    </div>
  );
}
