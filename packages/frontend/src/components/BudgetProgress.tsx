import { Show } from 'solid-js';
import type { BudgetProgressEntry } from '../data/budgetProgress';
import { progressClock } from '../data/budgetProgress';
import type { BudgetDto } from '../data/api';
import { BudgetChart } from './BudgetChart';

export function budgetMoney(micros: number): string {
  return micros > 0 && micros < 10000 ? '<$0.01' : `$${(micros / 1000000).toFixed(2)}`;
}
export const budgetBasis = (b: BudgetDto): string =>
  b.meteringBasis === 'notional'
    ? 'Includes subscription value at API rates'
    : 'Money spent · cash + unknown';
const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;

export function BudgetProgress(props: {
  budget: BudgetDto;
  scope: string;
  entry?: BudgetProgressEntry | undefined;
  now: number;
  retry: () => void;
}) {
  const snapshot = () => props.entry?.snapshot;
  const clock = () => progressClock(props.entry ?? { loading: false, error: null }, props.now);
  const usable = () => snapshot() && !clock().expired;
  const fallback = () =>
    clock().expired
      ? 'Period ended · awaiting current progress'
      : (props.entry?.error ??
        (props.entry?.loading || !props.entry
          ? 'Loading budget progress…'
          : 'Budget progress unavailable'));
  return (
    <div class="budget-progress">
      <Show
        when={usable()}
        fallback={
          <div class="budget-progress-status">
            <p>{fallback()}</p>
            <Show when={!props.entry?.loading}>
              <button type="button" class="btn-ghost" onClick={props.retry}>
                Retry progress
              </button>
            </Show>
          </div>
        }
      >
        <div class="budget-progress-headline">
          <div>
            <strong>{budgetMoney(snapshot()!.spentMicros)}</strong>{' '}
            <span>of {budgetMoney(snapshot()!.amountMicros)} used</span>
          </div>
          <Show when={snapshot()!.usedPercent !== null}>
            <span class="budget-percentage">
              {snapshot()!.usedPercent!.toFixed(1).replace(/\.0$/, '')}%
            </span>
          </Show>
        </div>
        <p class="budget-allowance">
          {snapshot()!.overspendMicros > 0
            ? `${budgetMoney(snapshot()!.overspendMicros)} over budget`
            : `${budgetMoney(snapshot()!.remainingMicros)} remaining`}
          <Show when={snapshot()!.spentMicros >= snapshot()!.amountMicros}>
            <span>
              {' '}
              ·{' '}
              {props.budget.enabled
                ? props.budget.action === 'alert'
                  ? 'Alert threshold reached'
                  : 'Recorded threshold reached'
                : 'Budget disabled'}
            </span>
          </Show>
        </p>
        <Show when={snapshot()!.amountMicros === 0}>
          <p>Configured amount {props.budget.amount.toString()} USD is below metering precision.</p>
        </Show>
        <figure class="budget-figure" aria-label={`${props.budget.name} recorded budget progress`}>
          <div class="budget-chart-key">
            <span>Recorded spend</span>
            <span class="budget-ceiling-key">
              Budget ceiling {budgetMoney(snapshot()!.amountMicros)}
            </span>
          </div>
          <BudgetChart snapshot={snapshot()!} />
          <figcaption>
            {props.scope} · {budgetBasis(props.budget)}. Period {utc(snapshot()!.period.start)} to{' '}
            {utc(snapshot()!.period.end)}. Recorded {budgetMoney(snapshot()!.spentMicros)} of{' '}
            {budgetMoney(snapshot()!.amountMicros)}. Pending batches{' '}
            {budgetMoney(snapshot()!.pendingMicros)}.
            <Show when={snapshot()!.availableMicros !== null}>
              {' '}
              Available after pending batches {budgetMoney(snapshot()!.availableMicros!)}.
              <Show when={snapshot()!.availableMicros === 0 && snapshot()!.remainingMicros > 0}>
                {' '}
                Pending batches occupy the remaining allowance.
              </Show>
            </Show>
            <Show when={snapshot()!.provenance.usageEstimated}> Includes estimated usage.</Show>
            <Show when={snapshot()!.provenance.priceEstimated}> Includes estimated pricing.</Show>
            <Show when={snapshot()!.provenance.unknownSpendMicros > 0}>
              {' '}
              Unclassified spend {budgetMoney(snapshot()!.provenance.unknownSpendMicros)}.
            </Show>
            <Show when={snapshot()!.provenance.unpricedRows > 0}>
              {' '}
              {snapshot()!.provenance.unpricedRows} metered rows are unpriced; their cost is
              unknown.
            </Show>
            <Show when={snapshot()!.provenance.meteredRows === 0}>
              {' '}
              No metered activity this period.
            </Show>
            <Show
              when={
                snapshot()!.provenance.meteredRows > 0 &&
                snapshot()!.spentMicros === 0 &&
                snapshot()!.provenance.unpricedRows === 0
              }
            >
              {' '}
              Metered activity has zero recorded cost.
            </Show>
            <span class="budget-freshness">
              Resets {utc(snapshot()!.period.end)} · Updated {utc(props.entry!.asOf!)}
              {clock().stale ? ' · Stale recorded progress' : ''}
              {props.entry?.error ? ' · Refresh failed' : ''}
            </span>
          </figcaption>
        </figure>
        <Show when={clock().stale}>
          <button type="button" class="btn-ghost" onClick={props.retry}>
            Retry progress
          </button>
        </Show>
      </Show>
    </div>
  );
}
