import { For, Show, onMount } from 'solid-js';
import { BASE_URL } from '../data/catalog';
import { fmtWhen } from '../data/format';
import { FROM_DIALOG } from '../state/appState';
import { useApp } from '../state/context';
import type { Agent } from '../types';
import { StackedLabel } from '../components/StackedLabel';
import { pageTitle } from '../components/Topbar';
import { createBusyMap } from '../components/busy';

/** Compact USD for the per-agent 24h spend cell (sub-cent shown to 4dp). */
function fmtSpend(v: number): string {
  if (v === 0) return '$0';
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

/** One column definition, consumed by the head and by each stacked record's field
 * labels — the two used to be independent literals with nothing keeping them aligned. */
/** The figure columns: right-aligned in the head as in every row (task 9.2). */
const FIGURE_COLUMNS: ReadonlySet<string> = new Set(['Requests · 24h', 'Spend · 24h']);

const COLUMNS = [
  'Agent',
  'Harness',
  'Key',
  'Requests · 24h',
  'Spend · 24h',
  'Last used',
  'Actions',
] as const;

export function Agents() {
  const app = useApp();
  const { state } = app;
  // Rotate key starts a request and stays on screen while it runs (D14), per agent.
  const rotating = createBusyMap();

  onMount(() => void app.loadAgentStats());

  /** Delete asks first, in the shared destructive confirmation (adopt-red-destructive-actions
   * D6 / D7). Its body is the forward-looking guarantee: an agent key is cached across
   * instances and in-flight requests finish, so "immediately" would overpromise. The row,
   * and with it this trigger, goes on success, so focus lands on the page title (D8). */
  const remove = (a: Agent): void => {
    app.confirmDestructive({
      title: `Delete agent "${a.name}"?`,
      body: 'New requests with its key will be refused.',
      commitLabel: 'Delete agent',
      busyLabel: 'Deleting…',
      run: () => app.deleteAgent(a, FROM_DIALOG),
      fallbackFocus: pageTitle,
    });
  };

  return (
    <div class="rs-page" style="display:flex;flex-direction:column;gap:24px;max-width:1200px">
      {/* Wraps on a phone: a button's label never wraps (the height family), so at 320px the
          row puts New agent under the sentence rather than past the pane's edge. */}
      <div
        class="rs-wrap"
        style="display:flex;justify-content:space-between;align-items:center;gap:8px"
      >
        <div class="t-body" style="color:var(--text3)">
          Each agent gets its own API key — point it at{' '}
          <span class="mono" style="font-size:0.75rem;color:var(--text2)">
            {BASE_URL}
          </span>
        </div>
        <button type="button" class="btn-primary" onClick={() => app.openModal('newAgent')}>
          New agent
        </button>
      </div>
      <Show when={state.agentsError}>
        <div class="t-caption" style="color:var(--red-text)">
          Couldn’t load agents: {state.agentsError}
        </div>
      </Show>
      <div class="panel rs-table-panel rs-table-agents" style="overflow:hidden;border-radius:10px">
        <div class="table-head">
          <For each={COLUMNS}>
            {(c, i) => (
              <div
                class={FIGURE_COLUMNS.has(c) ? 'cell-figure' : undefined}
                style={i() === COLUMNS.length - 1 ? 'text-align:right' : undefined}
                title={c}
              >
                {c}
              </div>
            )}
          </For>
        </div>
        <Show
          when={state.agents.length > 0}
          fallback={
            <div class="t-body" style="padding:24px 16px;color:var(--text3)">
              No agents yet. Create one to mint a key.
            </div>
          }
        >
          <For each={state.agents}>
            {(a) => (
              <div
                class="row-hover rs-agent-row"
                style={{
                  font: "400 0.75rem/1rem 'Geist',sans-serif",
                  color: 'var(--text2)',
                  'align-items': 'center',
                }}
              >
                <div style="font-weight:500;color:var(--text);min-width:0">
                  <span class="rs-cell-label">Agent</span>
                  {/* An identifier: cut with an end ellipsis, full text kept (task 9.2). */}
                  <span class="cell-id" title={a.name}>
                    {a.name}
                  </span>
                </div>
                <div>
                  <span class="rs-cell-label">Harness</span>
                  <span class="chip">{a.harness}</span>
                </div>
                <div class="mono" style="font-size:0.6875rem;color:var(--text3);min-width:0">
                  <span class="rs-cell-label">Key</span>
                  <span class="cell-id" title={`${a.prefix}…`}>
                    {a.prefix}…
                  </span>
                </div>
                <div class="figure cell-figure" style="font-size:0.75rem;color:var(--text2)">
                  <span class="rs-cell-label">Requests · 24h</span>
                  {state.agentStatsLoaded ? (state.agentStats[a.id]?.requests ?? 0) : '—'}
                </div>
                <div class="figure cell-figure" style="font-size:0.75rem;color:var(--text2)">
                  <span class="rs-cell-label">Spend · 24h</span>
                  {state.agentStatsLoaded ? fmtSpend(state.agentStats[a.id]?.spend ?? 0) : '—'}
                </div>
                <div style="font-size:0.6875rem;color:var(--text3)">
                  <span class="rs-cell-label">Last used</span>
                  {fmtWhen(a.lastUsedAt)}
                </div>
                <div class="rs-agent-actions">
                  <span class="rs-cell-label">Actions</span>
                  <button
                    type="button"
                    class="btn-ghost"
                    disabled={rotating.busy(a.id)}
                    aria-busy={rotating.busy(a.id) ? true : undefined}
                    onClick={() => void rotating.run(a.id, () => app.rotateKey(a))}
                  >
                    <StackedLabel
                      alt={rotating.busy(a.id)}
                      rest="Rotate key"
                      altLabel="Rotating…"
                    />
                  </button>
                  <button
                    type="button"
                    class="btn-ghost btn-ghost--destructive"
                    onClick={() => remove(a)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            )}
          </For>
        </Show>
      </div>
      <div class="t-caption" style="color:var(--text3);padding:0 4px">
        Per-agent request and spend figures cover the last 24 hours.
      </div>
    </div>
  );
}
