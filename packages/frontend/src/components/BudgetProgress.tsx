import { createEffect, on, onCleanup, Show } from 'solid-js';
import type { BudgetProgressEntry } from '../data/budgetProgress';
import { AWAITING_CONFIGURATION, progressClock } from '../data/budgetProgress';
import type { BudgetDto } from '../data/api';
import { EXPIRED, money } from '../data/figures';
import { BudgetChart } from './BudgetChart';
import { FigureSkeleton } from './FigureSkeleton';
import { StackedLabel } from './StackedLabel';
import { createFocusReturn } from './busy';

/** A Limits amount at cents (adopt-figure-states D2): a positive amount below a cent reads
 * `<$0.01`, never `$0.00`. */
export function budgetMoney(micros: number): string {
  return money(micros, 'cents');
}

/** A failed progress read with no retained snapshot (adopt-figure-states D5, D6). */
export const PROGRESS_FAILED = 'Budget progress couldn’t be loaded.';
export const budgetBasis = (b: BudgetDto): string =>
  b.meteringBasis === 'notional'
    ? 'Includes subscription value at API rates'
    : 'Money spent · cash + unknown';
const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
/** A snapshot's UTC hours and minutes, for the stale caption: the freshness line it sits on
 * states the reset time in UTC, so the zone is named there. */
const hhmm = (iso: string) => iso.slice(11, 16);

/** The no-progress Retry. When it unmounts while it holds focus (its card's reload has
 * started, whenever that is), focus moves to `focusOnUnmount` before the button leaves the
 * document, so it never falls to <body>. Cleanup runs before the node is removed. */
function RetryProgress(props: {
  onClick: () => void;
  focusOnUnmount: () => HTMLElement | undefined;
}) {
  let button: HTMLButtonElement | undefined;
  onCleanup(() => {
    if (button === undefined || document.activeElement !== button) return;
    const target = props.focusOnUnmount();
    if (target?.isConnected === true) target.focus();
  });
  return (
    <button
      type="button"
      class="btn-ghost"
      ref={(el) => {
        button = el;
      }}
      onClick={() => props.onClick()}
    >
      Retry progress
    </button>
  );
}

export function BudgetProgress(props: {
  budget: BudgetDto;
  scope: string;
  entry?: BudgetProgressEntry | undefined;
  now: number;
  retry: () => void;
}) {
  const snapshot = () => props.entry?.snapshot;
  const clock = () => progressClock(props.entry ?? { loading: false, error: null }, props.now);
  // The stale card's Retry is natively disabled while it reloads, which drops its focus to
  // <body>; when the reload settles and the button is still there (a failed refresh), focus
  // goes back to it (`createFocusReturn`, D14).
  const retryFocus = createFocusReturn();
  createEffect(
    on(
      () => props.entry?.loading === true,
      (loading, was) => {
        if (was === true && !loading) retryFocus.restore();
      },
    ),
  );
  const usable = () => snapshot() && !clock().expired;
  /** What a card without usable progress says, each state in its own words
   * (adopt-figure-states D5, D6): an ended period is expired; a first read loads as a
   * skeleton (null); a configuration mismatch waits; a failed read says so; anything else is
   * unavailable. */
  const fallback = (): string | null => {
    if (clock().expired) return EXPIRED;
    const error = props.entry?.error ?? null;
    if (error === AWAITING_CONFIGURATION) return error;
    if (error !== null) return PROGRESS_FAILED;
    return props.entry?.loading || !props.entry ? null : 'Budget progress unavailable';
  };
  // The no-progress Retry is hidden while its reload runs, so it unmounts as its load starts
  // and its focus would fall to <body>. This region stays mounted through the failure and the
  // retry, so it takes focus instead (adopt-figure-states D5, "Where Retry leaves focus"). The
  // hand-off follows the unmount itself (`RetryProgress`), not a fixed microtask after the
  // click: the loader marks a card loading only when that card's 20-budget chunk starts, and a
  // Retry pressed during a running cycle only queues one, so the button can go much later.
  let region: HTMLDivElement | undefined;
  return (
    <div
      class="budget-progress"
      tabindex={-1}
      ref={(el) => {
        region = el;
      }}
      data-testid="budget-progress"
    >
      <Show
        when={usable()}
        fallback={
          <div class="budget-progress-status">
            <p>
              <Show
                when={fallback()}
                fallback={<FigureSkeleton what="budget progress" size="line" />}
              >
                {(text) => text()}
              </Show>
            </p>
            <Show when={!props.entry?.loading}>
              <RetryProgress onClick={props.retry} focusOnUnmount={() => region} />
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
          {/* An overage reads as over budget, in red status text; the words carry it. */}
          <Show
            when={snapshot()!.overspendMicros > 0}
            fallback={`${budgetMoney(snapshot()!.remainingMicros)} remaining`}
          >
            <span style="color:var(--red-text)" data-testid="budget-over">
              {budgetMoney(snapshot()!.overspendMicros)} over budget
            </span>
          </Show>
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
        {/* The configured amount through the shared formatter at cents, unrounded, as the
            card's configured line prints it (dashboard-core "A non-zero amount never prints as
            zero"): a sub-micro-dollar amount reads `<$0.01`, never the raw `1e-7 USD`. */}
        <Show when={snapshot()!.amountMicros === 0}>
          <p>
            Configured amount {budgetMoney(props.budget.amount * 1_000_000)} is below metering
            precision.
          </p>
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
            {/* Stale is one state with one caption for both causes, a failed refresh and a
                snapshot older than 45 seconds: the snapshot's own time, never advanced
                (adopt-figure-states D6). */}
            <span class="budget-freshness">
              Resets {utc(snapshot()!.period.end)} ·{' '}
              <Show when={clock().stale} fallback={`Updated ${utc(props.entry!.asOf!)}`}>
                <span style="color:var(--amber-text)" data-testid="budget-stale">
                  as of {hhmm(props.entry!.asOf!)} · stale
                </span>
              </Show>
            </span>
          </figcaption>
        </figure>
        {/* Stale progress stays on the card while it reloads, so its Retry stays too: busy
            while the reload is in flight (adopt-design-tokens-v2 D14). The no-progress Retry
            above hides instead, its status line saying the progress is loading. */}
        <Show when={clock().stale}>
          <button
            type="button"
            class="btn-ghost"
            disabled={props.entry?.loading === true}
            aria-busy={props.entry?.loading === true ? true : undefined}
            onClick={() => {
              retryFocus.capture();
              props.retry();
              if (props.entry?.loading !== true) retryFocus.drop();
            }}
          >
            <StackedLabel
              alt={props.entry?.loading === true}
              rest="Retry progress"
              altLabel="Retrying…"
            />
          </button>
        </Show>
      </Show>
    </div>
  );
}
