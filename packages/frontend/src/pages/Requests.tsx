import { createMemo, For, onMount, Show } from 'solid-js';
import { InflightRows, RequestRows, RequestTableHead } from '../components/RequestTable';
import { createPoller } from '../data/poller';

import { filterToRequestParams } from '../data/analytics';
import { inflightCadenceMs, projectInflightRows } from '../data/inflight';
import { useApp } from '../state/context';
import type { RequestFilter } from '../types';

/** Matches the Overview card's cadence, so the two pages go stale at the same rate rather
 *  than for different reasons. The shared budget floors the combined poll+nudge rate. */
const POLL_MS = 15_000;

const FILTERS: [RequestFilter, string][] = [
  ['all', 'All'],
  ['explicit', 'Explicit'],
  ['auto', 'Auto'],
  ['fallback', 'Fallbacks'],
  ['escalated', 'Escalated'],
];

export function Requests(props: { live: boolean }) {
  const app = useApp();
  const { state } = app;

  // Load page 1 (frozen window) on mount. The LIST is NOT polled — it is an append-only
  // log, and its window is frozen at `to = now`. The in-flight band below is not the list:
  // it is not a `request_log` read at all, so it polls on its own terms.
  onMount(() => void app.loadRequests(true));

  /** The band, projected for THIS surface (add-requests-inflight-band).
   *
   * Deduped against this page's own visible rows, not the Overview card's. Running entries
   * and durable rows are disjoint at source, but the shared set also carries *settling*
   * rows — and a window re-frozen during that grace (arriving here, retrying, changing a
   * filter, all of which set `to = now`) can contain the very row still in the band.
   *
   * Filtered through the SAME mapping the paginated query uses, so the band and the list
   * cannot come to disagree about what "auto" means. A filter needing a terminal outcome
   * empties the band rather than guessing at rows that have not finished. */
  /** What the disclosure says. A FAILED probe must not read as "nothing new" — that would
   *  present a stale list as current, which is the thing this exists to prevent. */
  const newRowsLabel = (): string => {
    const n = state.requestsNew;
    if (n === null) return '';
    if (n.unknown) return 'Newer requests may exist · reload';
    if (n.count === 0) return 'Up to date · reload';
    return `${String(n.count)}${n.atLeast ? '+' : ''} new · load`;
  };

  const bandRows = createMemo(() =>
    projectInflightRows(
      state.inflightRows,
      new Set(state.requestList.map((r) => r.id)),
      filterToRequestParams(state.reqFilter),
    ),
  );

  // Freshness (add-requests-freshness). Routed through the SHARED aggregate budget, which
  // already floors the combined poll+nudge rate and already reserves `force` for the
  // mandatory hidden→visible catch-up — inheriting that is why there is no second refresh
  // path. `runImmediately: false` because `onMount` above already loaded page 1; an
  // immediate first tick would issue two resets at setup.
  createPoller({
    fn: (reason) => app.requestAggregateRefresh(() => app.refreshRequestsPage(), reason === 'resume'),
    intervalMs: () => POLL_MS,
    enabled: () => props.live,
    runImmediately: false,
  });

  // Degraded path only: a HEALTHY stream already drives the shared live set app-wide, so
  // the band works here with no poller at all. This covers the case where the stream is
  // unsupported, refused by the per-owner cap, or dropped. Page-scoped and
  // visibility-gated, exactly as the Overview card mounts it.
  createPoller({
    fn: () => app.loadInflight(),
    intervalMs: () => inflightCadenceMs(state.inflightRows.length),
    enabled: () => props.live && state.streamHealth !== 'live',
  });

  return (
    <div class="rs-page" style="display:flex;flex-direction:column;gap:14px;max-width:1200px">
      <div class="rs-wrap" style="display:flex;align-items:center;gap:10px">
        <div class="rs-wrap" style="display:flex;gap:6px">
          <For each={FILTERS}>
            {([id, label]) => (
              <button
                type="button"
                aria-pressed={state.reqFilter === id}
                style={{
                  padding: '5px 12px',
                  'border-radius': '10px',
                  font: "500 12px 'Geist',sans-serif",
                  color: state.reqFilter === id ? 'var(--accent-deep)' : 'var(--text2)',
                  background: state.reqFilter === id ? 'var(--accent-bg)' : 'var(--panel)',
                  border: `1px solid ${state.reqFilter === id ? 'transparent' : 'var(--border)'}`,
                  cursor: 'pointer',
                }}
                onClick={() => app.setFilter(id)}
              >
                {label}
              </button>
            )}
          </For>
        </div>
        <div style="margin-left:auto;font:400 11.5px 'Geist',sans-serif;color:var(--text3)">
          {state.requestList.length} shown{state.requestCursor !== null ? '+' : ''} · click a row to
          inspect the decision
        </div>
      </div>

      <Show when={state.requestListError}>
        {(msg) => (
          <div style="display:flex;align-items:center;gap:10px;padding:9px 14px;background:var(--red-bg);border:1px solid var(--red);border-radius:8px;font:500 12px 'Geist',sans-serif;color:var(--red)">
            <span style="flex:1">Couldn’t load requests — {msg()}</span>
            <button
              type="button"
              class="link-accent"
              style="font-weight:600"
              onClick={() => void app.loadRequests(true)}
            >
              Retry
            </button>
          </div>
        )}
      </Show>

      {/* Shown only while the user is PAGING: an unpaged list refreshes itself, so there is
          nothing to announce. Discarding pages 2..N to deliver freshness would be the worse
          trade, so the page discloses instead. */}
      <Show when={state.requestsPaged && state.requestsNew !== null}>
        {/* A polite live region: the pill appears without user action, so a screen-reader
            user is told the list has fallen behind rather than only sighted users. */}
        <div role="status" style="display:flex;justify-content:center">
          <button
            type="button"
            class="btn-ghost"
            style="font:500 12px 'Geist',sans-serif"
            onClick={() => void app.loadRequests(true)}
          >
            {newRowsLabel()}
          </button>
        </div>
      </Show>

      <div class="panel rs-table-panel rs-table-requests" style="overflow:hidden;border-radius:10px">
        <RequestTableHead />
        {/* Live rows above the completed ones, as the Overview card does. Outside the
            frozen keyset window: nothing here inserts into, reorders or invalidates the
            paginated list, its window, or its cursor. */}
        <Show when={bandRows().length > 0}>
          <InflightRows rows={bandRows()} />
        </Show>
        <Show
          when={state.requestList.length > 0}
          fallback={
            <div style="padding:16px 18px;font:400 12px 'Geist',sans-serif;color:var(--text3)">
              {state.requestListLoading || state.requestWindow === null
                ? 'Loading…'
                : bandRows().length > 0
                  ? 'No completed requests match this filter yet.'
                  : 'No requests match this filter.'}
            </div>
          }
        >
          <RequestRows rows={state.requestList} />
        </Show>
        <Show when={state.requestCursor !== null}>
          <div style="display:flex;justify-content:center;padding:12px;border-top:1px solid var(--border2)">
            <button
              type="button"
              class="link-accent"
              style="font:500 12px 'Geist',sans-serif"
              disabled={state.requestListLoading}
              onClick={() => void app.loadRequests(false)}
            >
              {state.requestListLoading ? 'Loading…' : 'Load more'}
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}
