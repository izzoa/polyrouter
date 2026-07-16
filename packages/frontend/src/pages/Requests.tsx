import { For, onMount, Show } from 'solid-js';
import { RequestRows, RequestTableHead } from '../components/RequestTable';
import { useApp } from '../state/context';
import type { RequestFilter } from '../types';

const FILTERS: [RequestFilter, string][] = [
  ['all', 'All'],
  ['explicit', 'Explicit'],
  ['auto', 'Auto'],
  ['fallback', 'Fallbacks'],
  ['escalated', 'Escalated'],
];

export function Requests() {
  const app = useApp();
  const { state } = app;

  // Load page 1 (frozen window) on mount. The list is NOT polled — it is an
  // append-only log; only the aggregate pages poll.
  onMount(() => void app.loadRequests(true));

  return (
    <div style="padding:22px 26px;display:flex;flex-direction:column;gap:14px;max-width:1200px">
      <div style="display:flex;align-items:center;gap:10px">
        <div style="display:flex;gap:6px">
          <For each={FILTERS}>
            {([id, label]) => (
              <div
                style={{
                  padding: '5px 12px',
                  'border-radius': '14px',
                  font: "500 12px 'Geist',sans-serif",
                  color: state.reqFilter === id ? 'var(--accent-deep)' : 'var(--text2)',
                  background: state.reqFilter === id ? 'var(--accent-bg)' : 'var(--panel)',
                  border: `1px solid ${state.reqFilter === id ? 'transparent' : 'var(--border)'}`,
                  cursor: 'pointer',
                }}
                onClick={() => app.setFilter(id)}
              >
                {label}
              </div>
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
            <span
              class="link-accent"
              style="cursor:pointer;font-weight:600"
              onClick={() => void app.loadRequests(true)}
            >
              Retry
            </span>
          </div>
        )}
      </Show>

      <div class="panel" style="overflow:hidden;border-radius:10px">
        <RequestTableHead />
        <Show
          when={state.requestList.length > 0}
          fallback={
            <div style="padding:16px 18px;font:400 12px 'Geist',sans-serif;color:var(--text3)">
              {state.requestListLoading || state.requestWindow === null
                ? 'Loading…'
                : 'No requests match this filter.'}
            </div>
          }
        >
          <RequestRows rows={state.requestList} />
        </Show>
        <Show when={state.requestCursor !== null}>
          <div style="display:flex;justify-content:center;padding:12px;border-top:1px solid var(--border2)">
            <span
              class="link-accent"
              style="cursor:pointer;font:500 12px 'Geist',sans-serif"
              onClick={() => void app.loadRequests(false)}
            >
              {state.requestListLoading ? 'Loading…' : 'Load more'}
            </span>
          </div>
        </Show>
      </div>
    </div>
  );
}
