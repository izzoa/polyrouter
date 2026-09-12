import { createMemo, For, onMount, Show } from 'solid-js';
import {
  BatchJobRows,
  InflightRows,
  RequestRows,
  RequestTableHead,
} from '../components/RequestTable';
import { createPoller } from '../data/poller';

import { filterToRequestParams } from '../data/analytics';
import { BATCH_POLL_MS } from '../data/batchBand';
import { inflightCadenceMs, projectInflightRows } from '../data/inflight';
import { useApp } from '../state/context';
import type { RequestFilter, RequestMode } from '../types';

/** Matches the Overview card's cadence, so the two pages go stale at the same rate rather
 *  than for different reasons. The shared budget floors the combined poll+nudge rate. */
const POLL_MS = 15_000;

/** How a request was RUN — orthogonal to how it was routed, so it is its own
 * control rather than another chip in the routing row (add-batch-inference 5.4). */
const MODES: [RequestMode, string][] = [
  ['all', 'All'],
  ['sync', 'Sync'],
  ['batch', 'Batch'],
];

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

  /** The batch partition for THIS surface. A job has no terminal outcome yet, so a
   * filter that needs one (a status, an escalation) empties it — the same rule the
   * in-flight projection follows — and the Mode filter's `sync` hides it outright. */
  const batchBandRows = createMemo(() => {
    if (state.reqMode === 'sync') return [];
    const params = filterToRequestParams(state.reqFilter);
    if (params.status !== undefined || params.escalated !== undefined) return [];
    if (params.decisionLayers !== undefined) return []; // a job's mode is not a layer
    // The agent filter is ATTRIBUTABLE here (add-agent-request-attribution):
    // `batch_job.agent_id` is NOT NULL and rides the wire, so a job is FILTERED —
    // never hidden. Emptying this band would conceal running work the page can
    // correctly place.
    const agent = state.reqAgentId;
    if (agent === null) return state.batchRows;
    return state.batchRows.filter((r) => r.agentId === agent);
  });

  /** The in-flight band BEFORE the agent filter. Kept separate so the page can tell
   * "nothing is running" apart from "running work exists that this filter cannot
   * attribute" — the distinction the disclosure below depends on. */
  const attributableInflight = createMemo(() =>
    projectInflightRows(
      state.inflightRows,
      new Set(state.requestList.map((r) => r.id)),
      filterToRequestParams(state.reqFilter),
    ),
  );

  /** `InflightEntry` carries no agent id, so under an agent filter these rows cannot
   * be attributed. The band empties rather than displaying rows it cannot place. */
  const bandRows = createMemo(() =>
    state.reqAgentId === null ? attributableInflight() : [],
  );

  /** True only when the filter is HIDING live work. A permanent banner would train
   * people to ignore it; this appears exactly when there is something to disclose. */
  const inflightHidden = createMemo(
    () => state.reqAgentId !== null && attributableInflight().length > 0,
  );

  // Freshness (add-requests-freshness). Routed through the SHARED aggregate budget, which
  // already floors the combined poll+nudge rate and already reserves `force` for the
  // mandatory hidden→visible catch-up — inheriting that is why there is no second refresh
  // path. `runImmediately: false` because `onMount` above already loaded page 1; an
  // immediate first tick would issue two resets at setup.
  createPoller({
    fn: (reason) =>
      app.requestAggregateRefresh(() => app.refreshRequestsPage(), reason === 'resume'),
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

  // The batch partition's read (add-batch-inference D11) — its own driver, and not
  // suppressed by a healthy stream: `batch.updated` consumes this read rather than
  // replacing it.
  createPoller({
    fn: () => app.loadBatchBand(),
    intervalMs: () => BATCH_POLL_MS,
    enabled: () => props.live,
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
        <div
          class="rs-wrap"
          style="display:flex;align-items:center;gap:6px;padding-left:10px;margin-left:10px;border-left:1px solid var(--border)"
        >
          <span
            id="req-mode-label"
            style="font:500 11px 'Geist',sans-serif;color:var(--text3);text-transform:uppercase;letter-spacing:.04em"
          >
            Mode
          </span>
          <div role="group" aria-labelledby="req-mode-label" style="display:flex;gap:6px">
            <For each={MODES}>
              {([id, label]) => (
                <button
                  type="button"
                  aria-pressed={state.reqMode === id}
                  style={{
                    padding: '5px 12px',
                    'border-radius': '10px',
                    font: "500 12px 'Geist',sans-serif",
                    color: state.reqMode === id ? 'var(--accent-deep)' : 'var(--text2)',
                    background: state.reqMode === id ? 'var(--accent-bg)' : 'var(--panel)',
                    border: `1px solid ${state.reqMode === id ? 'transparent' : 'var(--border)'}`,
                    cursor: 'pointer',
                  }}
                  onClick={() => app.setMode(id)}
                >
                  {label}
                </button>
              )}
            </For>
          </div>
        </div>
        {/* Agent selection is its OWN control, not another routing chip: the chips above
            are one enum ("how was it routed") and the agent is an orthogonal axis, so the
            two must compose rather than replace each other. A select rather than chips
            because the list is unbounded — a tenant may run dozens of agents. */}
        <div
          class="rs-wrap"
          style="display:flex;align-items:center;gap:6px;padding-left:10px;margin-left:10px;border-left:1px solid var(--border)"
        >
          <label
            for="req-agent"
            style="font:500 11px 'Geist',sans-serif;color:var(--text3);text-transform:uppercase;letter-spacing:.04em"
          >
            Agent
          </label>
          <select
            class="select"
            id="req-agent"
            style="padding:4px 8px;font:500 12px 'Geist',sans-serif;max-width:180px"
            value={state.reqAgentId ?? ''}
            onChange={(e) => app.setAgentFilter(e.currentTarget.value === '' ? null : e.currentTarget.value)}
          >
            <option value="">All agents</option>
            <For each={state.agents}>{(a) => <option value={a.id}>{a.name}</option>}</For>
          </select>
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

      <div
        class="panel rs-table-panel rs-table-requests"
        style="overflow:hidden;border-radius:10px"
      >
        <RequestTableHead />
        {/* Live rows above the completed ones, as the Overview card does. Outside the
            frozen keyset window: nothing here inserts into, reorders or invalidates the
            paginated list, its window, or its cursor. */}
        <Show when={batchBandRows().length > 0}>
          <BatchJobRows rows={batchBandRows()} />
        </Show>
        <Show when={bandRows().length > 0}>
          <InflightRows rows={bandRows()} />
        </Show>
        {/* An emptied band must never read as "nothing is running". The in-flight
            payload carries no agent id, so under an agent filter these rows exist but
            cannot be placed — say that, rather than asserting an absence the page
            cannot verify. `role="status"` because it appears without user action. */}
        <Show when={inflightHidden()}>
          <div
            role="status"
            class="rs-inflight-hidden"
            style="padding:9px 18px;border-bottom:1px solid var(--border2);font:400 11.5px 'Geist',sans-serif;color:var(--text3)"
          >
            {attributableInflight().length} live request
            {attributableInflight().length === 1 ? ' is' : 's are'} running but can’t be
            attributed to an agent yet — clear the agent filter to see them.
          </div>
        </Show>
        <Show
          when={state.requestList.length > 0}
          fallback={
            <div style="padding:16px 18px;font:400 12px 'Geist',sans-serif;color:var(--text3)">
              {state.requestListLoading || state.requestWindow === null
                ? 'Loading…'
                : bandRows().length > 0 || batchBandRows().length > 0
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
