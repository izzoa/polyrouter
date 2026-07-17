import { For, Show, onMount } from 'solid-js';
import { BASE_URL } from '../data/catalog';
import { useApp } from '../state/context';
import type { Agent } from '../types';

/** Compact USD for the per-agent 24h spend cell (sub-cent shown to 4dp). */
function fmtSpend(v: number): string {
  if (v === 0) return '$0';
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

const GRID = '1.3fr 1fr 1.2fr 0.9fr 0.8fr 0.9fr 1.2fr';

function fmtWhen(iso: string | null): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'never';
  const secs = Math.round((Date.now() - t) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${String(Math.floor(secs / 60))}m ago`;
  if (secs < 86400) return `${String(Math.floor(secs / 3600))}h ago`;
  return new Date(t).toLocaleDateString();
}

export function Agents() {
  const app = useApp();
  const { state } = app;

  onMount(() => void app.loadAgentStats());

  const remove = (a: Agent): void => {
    if (globalThis.confirm(`Delete agent "${a.name}"? Its key stops working immediately.`)) {
      void app.deleteAgent(a);
    }
  };

  return (
    <div style="padding:22px 26px;display:flex;flex-direction:column;gap:14px;max-width:1200px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="font:400 12.5px 'Geist',sans-serif;color:var(--text3)">
          Each agent gets its own API key — point it at{' '}
          <span class="mono" style="font-size:11.5px;color:var(--text2)">
            {BASE_URL}
          </span>
        </div>
        <button type="button" class="btn-primary" onClick={() => app.openModal('newAgent')}>
          New agent
        </button>
      </div>
      <Show when={state.agentsError}>
        <div style="font:400 11.5px 'Geist',sans-serif;color:var(--red)">
          Couldn’t load agents: {state.agentsError}
        </div>
      </Show>
      <div class="panel" style="overflow:hidden;border-radius:10px">
        <div class="table-head" style={{ 'grid-template-columns': GRID }}>
          <div>Agent</div>
          <div>Harness</div>
          <div>Key</div>
          <div>Requests · 24h</div>
          <div>Spend · 24h</div>
          <div>Last used</div>
          <div style="text-align:right">Actions</div>
        </div>
        <Show
          when={state.agents.length > 0}
          fallback={
            <div style="padding:22px 18px;font:400 12.5px 'Geist',sans-serif;color:var(--text3)">
              No agents yet. Create one to mint a key.
            </div>
          }
        >
          <For each={state.agents}>
            {(a) => (
              <div
                class="row-hover"
                style={{
                  display: 'grid',
                  'grid-template-columns': GRID,
                  gap: '0 14px',
                  padding: '11px 18px',
                  'border-bottom': '1px solid var(--border2)',
                  font: "400 12.5px 'Geist',sans-serif",
                  color: 'var(--text2)',
                  'align-items': 'center',
                }}
              >
                <div style="font-weight:500;color:var(--text)">{a.name}</div>
                <div>
                  <span class="chip">{a.harness}</span>
                </div>
                <div class="mono" style="font-size:11px;color:var(--text3)">
                  {a.prefix}…
                </div>
                <div class="mono" style="font-size:11.5px;color:var(--text2)">
                  {state.agentStatsLoaded ? (state.agentStats[a.id]?.requests ?? 0) : '—'}
                </div>
                <div class="mono" style="font-size:11.5px;color:var(--text2)">
                  {state.agentStatsLoaded ? fmtSpend(state.agentStats[a.id]?.spend ?? 0) : '—'}
                </div>
                <div style="font-size:11.5px;color:var(--text3)">{fmtWhen(a.lastUsedAt)}</div>
                <div style="display:flex;gap:6px;justify-content:flex-end">
                  <button type="button" class="btn-ghost" onClick={() => void app.rotateKey(a)}>
                    Rotate key
                  </button>
                  <button
                    type="button"
                    class="btn-ghost btn-ghost--amber"
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
      <div style="font:400 11px 'Geist',sans-serif;color:var(--text3);padding:0 2px">
        Per-agent request and spend figures cover the last 24 hours.
      </div>
    </div>
  );
}
