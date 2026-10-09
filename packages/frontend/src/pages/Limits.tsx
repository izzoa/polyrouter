import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { createPoller } from '../data/poller';
import { BudgetProgress, budgetBasis } from '../components/BudgetProgress';
import type { BudgetDto } from '../data/api';
import { useApp } from '../state/context';

export function Limits(props: { live?: boolean }) {
  const app = useApp();
  const { state } = app;
  const [now, setNow] = createSignal(performance.now());
  onMount(() => {
    void app.loadLimits();
    const timer = setInterval(() => setNow(performance.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  onCleanup(() => app.stopLimitsProgress());
  createPoller({
    fn: (reason) =>
      app.requestAggregateRefresh(
        () => app.loadBudgetProgress(reason === 'resume'),
        reason === 'resume',
      ),
    intervalMs: () => 15000,
    enabled: () => props.live !== false,
    runImmediately: false,
  });
  const retry = (): void => {
    void app.requestAggregateRefresh(() => app.loadBudgetProgress(true), true);
  };

  const removeBudget = (b: BudgetDto): void => {
    if (
      globalThis.confirm(
        `Delete budget "${b.name}"? New requests will no longer be enforced by it.`,
      )
    ) {
      void app.deleteBudget(b.id);
    }
  };

  const agentName = (agentId: string | null): string => {
    if (agentId === null) return agentId ?? '';
    return state.agents.find((a) => a.id === agentId)?.name ?? agentId;
  };
  const channelName = (id: string): string => state.channels.find((c) => c.id === id)?.name ?? id;
  const scopeLabel = (b: BudgetDto): string =>
    b.scope === 'agent' ? `Agent · ${agentName(b.agentId)}` : 'Global';

  return (
    <div class="rs-page" style="display:flex;flex-direction:column;gap:14px;max-width:1200px">
      <div class="limits-intro">
        <div style="font:400 12.5px 'Geist',sans-serif;color:var(--text3)">
          Progress counts recorded spend from the UTC period start, including earlier spend.
          Postpaid requests and reconciliation can exceed a cap; allowance after pending batches
          does not guarantee admission.
        </div>
        <button type="button" class="btn-primary" onClick={() => app.openBudget()}>
          New budget
        </button>
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
        <div class="rs-grid-2" style="display:grid;gap:12px">
          <For each={state.budgets}>
            {(b) => (
              <article class="panel card budget-card" aria-label={b.name}>
                <div class="budget-card-header">
                  <h2 class="section-title budget-card-title">{b.name}</h2>
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
                <div class="budget-scope">
                  {scopeLabel(b)} · {budgetBasis(b)}
                </div>
                <div class="budget-config">
                  Budget $
                  {b.amount > 0 && b.amount < 0.01 ? b.amount.toString() : b.amount.toFixed(2)} /{' '}
                  {b.window}
                </div>
                <BudgetProgress
                  budget={b}
                  scope={scopeLabel(b)}
                  entry={state.budgetProgress[b.id]}
                  now={now()}
                  retry={retry}
                />
                <div style="font:400 11px 'Geist',sans-serif;color:var(--text3);line-height:1.5">
                  <Show
                    when={b.notifyChannelIds.length > 0}
                    fallback={
                      b.action === 'block' ? 'block action · postpaid cap' : 'no channels wired'
                    }
                  >
                    notifies: {b.notifyChannelIds.map(channelName).join(', ')}
                  </Show>
                </div>
                <div style="display:flex;gap:6px;margin-top:10px">
                  <button type="button" class="btn-ghost" onClick={() => app.openBudget(b)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    class="btn-ghost btn-ghost--amber"
                    onClick={() => removeBudget(b)}
                  >
                    Delete
                  </button>
                  <span
                    style={{
                      'margin-left': 'auto',
                      'align-self': 'center',
                      font: "400 11px 'Geist',sans-serif",
                      color: b.enabled ? 'var(--green-text)' : 'var(--text3)',
                    }}
                  >
                    {b.enabled ? 'enabled' : 'disabled'}
                  </span>
                </div>
              </article>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
