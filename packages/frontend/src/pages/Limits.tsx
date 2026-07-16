import { For, onMount, Show } from 'solid-js';
import type { BudgetDto } from '../data/api';
import { useApp } from '../state/context';

// NOTE (#20 deferred): the live "current spend" bar the prototype showed is gone —
// the budget API is config-only and the reconciled spend counter isn't exposed yet.
// This page configures budgets; live spend lands with a later change.

export function Limits() {
  const app = useApp();
  const { state } = app;

  onMount(() => void app.loadLimits());

  const agentName = (agentId: string | null): string => {
    if (agentId === null) return agentId ?? '';
    return state.agents.find((a) => a.id === agentId)?.name ?? agentId;
  };
  const channelName = (id: string): string => state.channels.find((c) => c.id === id)?.name ?? id;
  const scopeLabel = (b: BudgetDto): string =>
    b.scope === 'agent' ? `Agent · ${agentName(b.agentId)}` : 'Global';

  return (
    <div style="padding:22px 26px;display:flex;flex-direction:column;gap:14px;max-width:1200px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="font:400 12.5px 'Geist',sans-serif;color:var(--text3)">
          Spend counters are atomic across instances — a blocked budget stops requests everywhere at
          once.
        </div>
        <div class="btn-primary" onClick={() => app.openBudget()}>
          New budget
        </div>
      </div>

      <Show when={state.budgetsError}>
        <div style="font:400 11.5px 'Geist',sans-serif;color:var(--red)">
          Couldn’t load budgets: {state.budgetsError}
        </div>
      </Show>

      <Show
        when={state.budgets.length > 0}
        fallback={
          <div class="panel card" style="font:400 12.5px 'Geist',sans-serif;color:var(--text3)">
            {state.budgetsLoading ? 'Loading budgets…' : 'No budgets yet. Create one to cap spend.'}
          </div>
        }
      >
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <For each={state.budgets}>
            {(b) => (
              <div class="panel card" style={{ opacity: b.enabled ? '1' : '0.6' }}>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                  <div class="section-title" style="color:var(--text)">
                    {b.name}
                  </div>
                  <span
                    style={{
                      padding: '2px 9px',
                      'border-radius': '10px',
                      font: "500 10.5px 'Geist',sans-serif",
                      background: b.action === 'alert' ? 'var(--chip)' : 'var(--red-bg)',
                      color: b.action === 'alert' ? 'var(--text2)' : 'var(--red)',
                    }}
                  >
                    {b.action === 'alert' ? 'Alert' : 'Block'}
                  </span>
                </div>
                <div style="display:flex;align-items:baseline;gap:6px;margin-bottom:8px">
                  <span style="font:600 20px 'Geist',sans-serif;letter-spacing:-.02em">
                    ${b.amount.toFixed(2)}
                  </span>
                  <span style="font:400 12px 'Geist',sans-serif;color:var(--text3)">
                    / {b.window}
                  </span>
                  <span
                    class="chip"
                    style="margin-left:auto;font:500 10.5px 'Geist',sans-serif;color:var(--text3)"
                  >
                    {scopeLabel(b)}
                  </span>
                </div>
                <div style="font:400 11px 'Geist',sans-serif;color:var(--text3);line-height:1.5">
                  <Show
                    when={b.notifyChannelIds.length > 0}
                    fallback={
                      b.action === 'block'
                        ? 'hard stop — requests rejected at limit'
                        : 'no channels wired'
                    }
                  >
                    notifies: {b.notifyChannelIds.map(channelName).join(', ')}
                  </Show>
                </div>
                <div style="display:flex;gap:6px;margin-top:10px">
                  <div class="btn-ghost" onClick={() => app.openBudget(b)}>
                    Edit
                  </div>
                  <div
                    class="btn-ghost btn-ghost--amber"
                    onClick={() => void app.deleteBudget(b.id)}
                  >
                    Delete
                  </div>
                  <span
                    style={{
                      'margin-left': 'auto',
                      'align-self': 'center',
                      font: "400 11px 'Geist',sans-serif",
                      color: b.enabled ? 'var(--green)' : 'var(--faint)',
                    }}
                  >
                    {b.enabled ? 'enabled' : 'disabled'}
                  </span>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
