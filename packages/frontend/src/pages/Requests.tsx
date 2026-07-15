import { For } from 'solid-js';
import { RequestRows, RequestTableHead } from '../components/RequestTable';
import { app } from '../state/appState';
import type { RequestFilter, RoutedRequest } from '../types';

const FILTERS: [RequestFilter, string][] = [
  ['all', 'All'],
  ['explicit', 'Explicit'],
  ['auto', 'Auto'],
  ['fallback', 'Fallbacks'],
  ['escalated', 'Escalated'],
];

export function filterRequests(requests: RoutedRequest[], filter: RequestFilter): RoutedRequest[] {
  if (filter === 'all') return requests;
  return requests.filter((r) =>
    filter === 'auto'
      ? r.layer === 'structural' || r.layer === 'escalated'
      : filter === 'explicit'
        ? r.layer === 'explicit' || r.layer === 'header'
        : filter === 'fallback'
          ? r.status === 'fallback'
          : r.escalated,
  );
}

export function Requests(props: { live: boolean }) {
  const { state } = app;
  const filtered = () => filterRequests(state.requests, state.reqFilter);

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
          {filtered().length} of {state.requests.length} recent · click a row to inspect the
          decision
        </div>
      </div>
      <div class="panel" style="overflow:hidden;border-radius:10px">
        <RequestTableHead />
        <RequestRows rows={filtered()} live={props.live} />
      </div>
    </div>
  );
}
