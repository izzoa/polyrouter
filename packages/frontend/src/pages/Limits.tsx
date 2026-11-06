import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { createPoller } from '../data/poller';
import { BudgetProgress, budgetBasis, budgetMoney } from '../components/BudgetProgress';
import { pageTitle } from '../components/Topbar';
import type { BudgetDto } from '../data/api';
import { FROM_DIALOG } from '../state/appState';
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

  /** Delete asks first, in the shared destructive confirmation (adopt-red-destructive-actions
   * D6 / D7). The card, and with it this trigger, goes on success: focus lands on the page
   * title (D8). */
  const removeBudget = (b: BudgetDto): void => {
    app.confirmDestructive({
      title: `Delete budget "${b.name}"?`,
      body: 'New requests will no longer be enforced by it.',
      commitLabel: 'Delete budget',
      busyLabel: 'Deleting…',
      run: () => app.deleteBudget(b.id, FROM_DIALOG),
      fallbackFocus: pageTitle,
    });
  };

  const agentName = (agentId: string | null): string => {
    if (agentId === null) return agentId ?? '';
    return state.agents.find((a) => a.id === agentId)?.name ?? agentId;
  };
  const channelName = (id: string): string => state.channels.find((c) => c.id === id)?.name ?? id;
  const scopeLabel = (b: BudgetDto): string =>
    b.scope === 'agent' ? `Agent · ${agentName(b.agentId)}` : 'Global';

  return (
    <div class="rs-page" style="display:flex;flex-direction:column;gap:24px;max-width:1200px">
      <div class="limits-intro">
        <div class="t-body" style="color:var(--text3)">
          Progress counts recorded spend from the UTC period start, including earlier spend.
          Postpaid requests and reconciliation can exceed a cap; allowance after pending batches
          does not guarantee admission.
        </div>
        <button type="button" class="btn-primary" onClick={() => app.openBudget()}>
          New budget
        </button>
      </div>

      <Show when={state.budgetsError}>
        <div class="t-caption" style="color:var(--red-text)">
          Couldn’t load budgets: {state.budgetsError}
        </div>
      </Show>

      <Show
        when={state.budgets.length > 0}
        fallback={
          <div class="panel card t-body" style="color:var(--text3)">
            {state.budgetsLoading ? 'Loading budgets…' : 'No budgets yet. Create one to cap spend.'}
          </div>
        }
      >
        <div class="rs-grid-2" style="display:grid;gap:16px">
          <For each={state.budgets}>
            {(b) => (
              <article class="panel card budget-card" aria-label={b.name}>
                <div class="budget-card-header">
                  <h2 class="section-title budget-card-title">{b.name}</h2>
                  <span
                    class="chip"
                    style={{
                      font: "500 0.6875rem/1rem 'Geist',sans-serif",
                      background: b.action === 'alert' ? 'var(--chip)' : 'var(--red-bg)',
                      color: b.action === 'alert' ? 'var(--text2)' : 'var(--red-text)',
                    }}
                  >
                    {b.action === 'alert' ? 'Alert' : 'Block'}
                  </span>
                </div>
                <div class="budget-scope">
                  {scopeLabel(b)} · {budgetBasis(b)}
                </div>
                {/* The configured amount at cents (adopt-figure-states D2). It is entered in
                    dollars and can sit below one micro-dollar, so it reaches the formatter
                    unrounded: a sub-cent amount reads `<$0.01`, never `$0.00` or `$1e-7`. */}
                <div class="budget-config" data-testid="budget-config">
                  Budget {budgetMoney(b.amount * 1_000_000)} / {b.window}
                </div>
                <BudgetProgress
                  budget={b}
                  scope={scopeLabel(b)}
                  entry={state.budgetProgress[b.id]}
                  now={now()}
                  retry={retry}
                />
                <div class="t-caption" style="color:var(--text3)">
                  <Show
                    when={b.notifyChannelIds.length > 0}
                    fallback={
                      b.action === 'block' ? 'block action · postpaid cap' : 'no channels wired'
                    }
                  >
                    notifies: {b.notifyChannelIds.map(channelName).join(', ')}
                  </Show>
                </div>
                <div data-testid="budget-actions" style="display:flex;gap:8px;margin-top:8px">
                  <button type="button" class="btn-ghost" onClick={() => app.openBudget(b)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    class="btn-ghost btn-ghost--destructive"
                    onClick={() => removeBudget(b)}
                  >
                    Delete
                  </button>
                  <span
                    style={{
                      'margin-left': 'auto',
                      'align-self': 'center',
                      font: "400 0.6875rem/1rem 'Geist',sans-serif",
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
