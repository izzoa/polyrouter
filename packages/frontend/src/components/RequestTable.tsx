import { createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import {
  isKnownRequestStatus,
  labelOf,
  type KnownRequestStatus,
  type RequestRow,
} from '../data/api';
import type { InflightDisplayRow } from '../data/inflight';
import {
  batchProgressLabel,
  batchStatusLabel,
  fmtElapsed,
  type BatchDisplayRow,
} from '../data/batchBand';
import { agentRunLabel, isBatchItem, rowCostParts, startsAgentRun } from '../data/analytics';
import { fmtTime } from '../data/catalog';
import { EST_USAGE_PARTS, fmtLatency, fmtTokensCompact } from '../data/figures';
import { useApp } from '../state/context';
import { FigureText } from './FigureText';
import { Icon } from './Icon';

/** The single column definition for this table. The head and the row cells used to be
 * two independent lists of literals with nothing keeping them aligned; below the locked
 * `table-fit` the stacked record repeats these names per field, so a drift would now be
 * visible to users rather than merely latent. One list, consumed by both. */
const COLUMNS = [
  'Time',
  'Model',
  'Provider',
  'Tier',
  'Decided by',
  'Tokens',
  'Cost',
  'Latency',
  'Status',
] as const;

/** One cell, carrying its field name for the stacked presentation.
 *
 * The label is `aria-hidden` deliberately. A completed request row is a single
 * `<button>` whose accessible name is its flattened text content — visible label text
 * would prepend "Time"/"Model"/… to that name and break the parity the spec requires.
 * Sighted users get the names; assistive technology gets the same name it got at desktop
 * width, where the head is a separate element with no association to the cells anyway. */
function Cell(props: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <span class="rs-cell">
      <span class="rs-cell-label" aria-hidden="true">
        {props.label}
      </span>
      {props.children}
    </span>
  );
}

/** The decision-layer chip: one static chip for every layer, the Chip Tone fill (`.chip`)
 * with Ink 2 text (DESIGN.md Chips), so the word alone names the layer. It used to be a
 * per-layer palette: `cascade` in the amber fill on the amber wash, a status hue as a
 * category at 2.54:1 under the 4.5:1 text floor, and `explicit` in the Selected-state
 * wash, a decorative indigo the Indigo Budget forbids (adopt-design-tokens-v2 task 16.6).
 * An unknown layer renders the same chip (invariant 1: the table is layer-agnostic). */
const LAYER_CHIP_STYLE: JSX.CSSProperties = { color: 'var(--text2)', 'font-weight': '500' };

const STATUS_DOT: Record<KnownRequestStatus, string> = {
  success: 'var(--green)',
  fallback: 'var(--amber)',
  error: 'var(--red)',
  cancelled: 'var(--text3)',
};
const STATUS_TEXT: Record<KnownRequestStatus, string> = {
  success: 'OK',
  fallback: 'Fallback',
  error: 'Error',
  cancelled: 'Cancelled',
};
// `status` is free-form text at the DB — an unknown/legacy value renders neutrally
// instead of crashing on a missing map entry.
const dotFor = (s: string): string => (isKnownRequestStatus(s) ? STATUS_DOT[s] : 'var(--text3)');
const textFor = (s: string): string => (isKnownRequestStatus(s) ? STATUS_TEXT[s] : s || 'unknown');

/** The neutral `batch` chip (add-batch-inference D11a/D12). Neutral on purpose, like
 * the decision-layer chip beside it: the lock reserves amber for status, and a batch
 * is an execution MODE, not a routing decision — the decision layer beside it stays
 * truthful. The glyph is decorative; the word carries the state. */
function BatchChip() {
  return (
    <span
      class="chip"
      style={{
        display: 'inline-flex',
        'align-items': 'center',
        gap: '4px',
        color: 'var(--text2)',
        'font-weight': '500',
      }}
    >
      <Icon name="layers" size={11} />
      batch
    </span>
  );
}

/** The figure columns: right-aligned in the head as in every row (task 9.2). */
const FIGURE_COLUMNS: ReadonlySet<string> = new Set(['Tokens', 'Cost', 'Latency']);

export function RequestTableHead() {
  return (
    <div class="table-head">
      <For each={COLUMNS}>
        {(c) => (
          <div class={FIGURE_COLUMNS.has(c) ? 'cell-figure' : undefined} title={c}>
            {c}
          </div>
        )}
      </For>
    </div>
  );
}

export function RequestRow(props: { r: RequestRow }) {
  const app = useApp();
  const { state } = app;
  const selected = () => state.selId === props.r.id;
  return (
    <button
      type="button"
      class="req-row row-hover"
      // The open row's Selected state, the wash and an inset deep-indigo edge, is the
      // `.req-row[aria-expanded='true']` rule in styles.css (adopt-design-tokens-v2 D8).
      // Nothing inline: an inline fill outranks the row's hover tone.
      aria-expanded={selected()}
      aria-controls="inspector-drawer"
      onClick={() => app.select(selected() ? null : props.r.id)}
    >
      <Cell label="Time">
        <span class="figure" style="font-size:0.6875rem;color:var(--text3)">
          {fmtTime(new Date(props.r.createdAt).getTime())}
        </span>
      </Cell>
      {/* Identifiers: cut with an end ellipsis on one line, keeping the full text as
          content and as the hover and focus title (task 9.2). */}
      <Cell label="Model">
        <span
          class="mono cell-id"
          style="font-size:0.75rem;color:var(--text)"
          title={labelOf(props.r.modelLabel, props.r.modelId)}
        >
          {labelOf(props.r.modelLabel, props.r.modelId)}
        </span>
      </Cell>
      <Cell label="Provider">
        <span class="cell-id" title={labelOf(props.r.providerLabel, props.r.providerId)}>
          {labelOf(props.r.providerLabel, props.r.providerId)}
        </span>
      </Cell>
      <Cell label="Tier">
        <span class="cell-id" title={props.r.tierAssigned ?? undefined}>
          {props.r.tierAssigned ?? '—'}
        </span>
      </Cell>
      <Cell label="Decided by">
        <span>
          <span class="chip" style={LAYER_CHIP_STYLE}>
            {props.r.decisionLayer}
            <Show when={props.r.escalated}>
              {/* The mark is decorative; the word carries the state. Before this the arrow was
                  the ONLY difference between an escalated request and a normal one, and it was
                  unlabelled — so escalation was invisible to assistive technology entirely. */}{' '}
              <Icon name="escalated" size={11} />
              <span class="sr-only">escalated</span>
            </Show>
          </span>
          {/* A settled batch item (add-batch-inference task 5.4): the SAME neutral
              chip and glyph the live job row uses, beside the decision layer rather
              than instead of it — the decision really was explicit, and the mode is
              a separate fact. The chip is never the sole carrier: the row's latency
              reads in hours and the inspector names the job. */}
          <Show when={isBatchItem(props.r)}>
            {' '}
            <BatchChip />
          </Show>
        </span>
      </Cell>
      <Cell label="Tokens">
        {/* `↑`/`↓` rather than the words: at real magnitudes "87.2k in / 1.5k out" is 125px
            against a 112px column and wraps to two lines. A figure, so Geist with tabular
            numerals (adopt-design-tokens-v2 task 9.1). Both arrows are present in Geist
            (`geist-latin.woff2`) as in Geist Mono — checked against the cmaps, not the
            `unicode-range` — and the coverage guard fails if a future subset drops them, which
            is the protection `→` never had.
            The words move to screen-reader text: an arrow announces as "up arrow", so the
            compact form would otherwise trade a layout bug for an accessibility one.
            Counts are compact through the one shared formatter (adopt-figure-states D8). A
            count the provider did not report carries `· est. usage` (D3): one Ink 3 unit that
            wraps whole, inside the visible half so the dual pair stays one aria-hidden node
            beside its screen-reader text, which says ", estimated usage" in words. Usage
            estimates are marked here and never on the cost cell. */}
        <span class="figure cell-figure" style="font-size:0.6875rem">
          <span aria-hidden="true">
            {fmtTokensCompact(props.r.inputTokens)}↑ {fmtTokensCompact(props.r.outputTokens)}↓
            <Show when={props.r.usageEstimated}>
              {' '}
              <FigureText parts={EST_USAGE_PARTS} />
            </Show>
          </span>
          <span class="sr-only">
            {fmtTokensCompact(props.r.inputTokens)} tokens in,{' '}
            {fmtTokensCompact(props.r.outputTokens)} out
            {props.r.usageEstimated ? ', estimated usage' : ''}
          </span>
        </span>
      </Cell>
      <Cell label="Cost">
        {/* The request's cost state (adopt-figure-states D1, D4), the one the inspector's
            total renders: each part is a no-wrap unit in its own tone. An amount and the `$0`
            before `free` keep this cell's Ink, `free` is green, `· est.` and `unpriced` are
            Ink 3, and both halves of `$0 · not billed` are Ink 2, so that label still wraps
            only at its dot. */}
        <span class="figure cell-figure" style="font-size:0.6875rem;color:var(--text)">
          <FigureText parts={rowCostParts(props.r)} />
        </span>
      </Cell>
      <Cell label="Latency">
        {/* A batch item's `duration_ms` is the JOB's wall time — the time the caller
            actually waited — which runs to hours. `7412.3s` is not a reading, so it
            is formatted as a job. Latency aggregates exclude these rows entirely. */}
        <span class="figure cell-figure" style="font-size:0.6875rem">
          {isBatchItem(props.r) ? fmtElapsed(props.r.durationMs) : fmtLatency(props.r.durationMs)}
        </span>
      </Cell>
      <Cell label="Status">
        <span style="display:flex;align-items:center;gap:4px">
          <span
            style={{
              width: '6px',
              height: '6px',
              'border-radius': '50%',
              background: dotFor(props.r.status),
              flex: 'none',
            }}
          />
          {textFor(props.r.status)}
        </span>
      </Cell>
    </button>
  );
}

/**
 * The agent a run of rows belongs to (add-agent-request-attribution).
 *
 * A boundary rather than a tenth column: the listing is time-ordered and one
 * agent's traffic arrives in runs, so a marker drawn only on CHANGE carries the
 * same information without squeezing eight existing tracks or pushing the
 * container-query stack breakpoint wider. It is a sibling block, NOT part of the
 * row grid (the grid lives on `.req-row` itself), so it costs the table no track
 * at any width and degrades into the stacked presentation unchanged.
 *
 * Text, never colour: the design lock is single-accent, and `dashboard-core`
 * forbids indicating a state by a decorative mark alone.
 */
function AgentBoundary(props: { label: string }): JSX.Element {
  return <div class="rs-agent-boundary">{props.label}</div>;
}

export function RequestRows(props: { rows: RequestRow[] }) {
  return (
    <For each={props.rows}>
      {(r, i) => (
        <>
          <Show when={startsAgentRun(props.rows, i())}>
            <AgentBoundary label={agentRunLabel(r)} />
          </Show>
          <RequestRow r={r} />
        </>
      )}
    </For>
  );
}

/**
 * Live batch JOB rows (add-batch-inference task 5.2), rendered in the same band as
 * the live request rows and in the same visual vocabulary — but they are a
 * different kind of thing, so every cell says so: a neutral `batch` chip instead
 * of a decision layer, the job's progress on its OWN line beneath the status (so
 * it can never widen the status column), an elapsed time formatted for hours
 * rather than seconds, and neutral token/cost cells because a job has no cost
 * until it settles. A reservation is never rendered as spend (D13).
 *
 * Non-selectable, like a running request: there is no terminal detail to inspect
 * yet, and the settled item rows carry it once there is.
 */
export function BatchJobRows(props: { rows: BatchDisplayRow[] }) {
  const now = useNow();
  return <For each={props.rows}>{(r) => <BatchJobRow r={r} now={now()} />}</For>;
}

function BatchJobRow(props: { r: BatchDisplayRow; now: number }) {
  const label = () => batchStatusLabel(props.r);
  const progress = () => batchProgressLabel(props.r);
  // `Cancelling` pulses amber — a state the user asked for and is waiting on;
  // `Reconciling` pulses faint — polyrouter cannot yet confirm the provider took
  // the job. Everything else is a steady dot. The app's reduced-motion query
  // forces iteration-count 1, so each settles to a static dot. A running or queued
  // job's dot is neutral (`--text3`), never indigo: the Indigo Budget keeps the accent
  // for one control and one series per view (adopt-design-tokens-v2 D11).
  const dot = (): string => {
    if (props.r.phase === 'settling') return 'var(--faint)';
    if (props.r.status === 'cancelling') return 'var(--amber)';
    if (props.r.status === 'submission_unknown') return 'var(--faint)';
    return 'var(--text3)';
  };
  const pulses = (): boolean =>
    props.r.phase !== 'settling' &&
    (props.r.status === 'cancelling' ||
      props.r.status === 'submission_unknown' ||
      props.r.status === 'in_progress');
  return (
    <div class="req-row row-hover" style={{ cursor: 'default' }} data-batch-row={props.r.id}>
      <Cell label="Time">
        <span class="figure" style="font-size:0.6875rem;color:var(--text3)">
          {fmtTime(Date.parse(props.r.submittedAt))}
        </span>
      </Cell>
      <Cell label="Model">
        <span
          class="mono cell-id"
          style="font-size:0.75rem;color:var(--text)"
          title={props.r.modelLabel ?? props.r.modelId}
        >
          {props.r.modelLabel ?? props.r.modelId}
        </span>
      </Cell>
      <Cell label="Provider">
        <span class="cell-id" title={props.r.providerLabel ?? props.r.providerId}>
          {props.r.providerLabel ?? props.r.providerId}
        </span>
      </Cell>
      <Cell label="Tier">
        <span class="cell-id" title={props.r.tierAssigned ?? undefined}>
          {props.r.tierAssigned ?? '—'}
        </span>
      </Cell>
      <Cell label="Decided by">
        <span>
          <BatchChip />
        </span>
      </Cell>
      <Cell label="Tokens">
        <span class="figure cell-figure" style="font-size:0.6875rem;color:var(--text3)">
          —
        </span>
      </Cell>
      <Cell label="Cost">
        {/* A reservation is money PROMISED, not spent — it is never shown here (D13);
            the Batches page labels it as reserved where there is room to say so. */}
        <span class="figure cell-figure" style="font-size:0.6875rem;color:var(--text3)">
          —
        </span>
      </Cell>
      <Cell label="Latency">
        <span class="figure cell-figure" style="font-size:0.6875rem;color:var(--text2)">
          {fmtElapsed(props.now - Date.parse(props.r.submittedAt))}
        </span>
      </Cell>
      <Cell label="Status">
        <span style="display:flex;flex-direction:column;gap:4px;color:var(--text2);min-width:0">
          <span style="display:flex;align-items:center;gap:4px">
            <span
              aria-hidden="true"
              style={{
                width: '6px',
                height: '6px',
                'border-radius': '50%',
                background: dot(),
                flex: 'none',
                ...(pulses() ? { animation: 'pulse 1.5s ease-in-out infinite' } : {}),
              }}
            />
            {label()}
          </span>
          {/* On its OWN line: at real magnitudes "In progress 1204 of 5000" is wider
              than the status column, and a bare `fr` track would let it shift every
              other column (D17). */}
          <Show when={progress()}>
            {(p) => (
              <span class="figure" style="font-size:0.6875rem;color:var(--text3)">
                {p()}
              </span>
            )}
          </Show>
        </span>
      </Cell>
    </div>
  );
}

/** One shared 1s ticker for the live latency column (not per-row). */
function useNow(): () => number {
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(t));
  });
  return now;
}

/** Live in-flight rows (add-inflight-requests): rendered ABOVE the completed rows.
 * Non-selectable (no terminal detail yet); a pulsing "Running" status and a latency
 * that ticks client-side from `startedAt`; token/cost cells are neutral placeholders. */
export function InflightRows(props: { rows: InflightDisplayRow[] }) {
  const now = useNow();
  return <For each={props.rows}>{(r) => <InflightRunningRow r={r} now={now()} />}</For>;
}

function InflightRunningRow(props: { r: InflightDisplayRow; now: number }) {
  /** Milliseconds since admission, ticking with the shared clock (`fmtLatency` clamps). */
  const elapsed = (): number => props.now - props.r.startedAt;
  return (
    // Non-interactive by design (no terminal detail to inspect yet). No aria-label:
    // a bare div has no role to hang one on, and the row's own text already reads
    // out completely — time, model, provider, tier, layer, and "Running".
    <div class="req-row row-hover" style={{ cursor: 'default' }}>
      <Cell label="Time">
        <span class="figure" style="font-size:0.6875rem;color:var(--text3)">
          {fmtTime(props.r.startedAt)}
        </span>
      </Cell>
      <Cell label="Model">
        <span
          class="mono cell-id"
          style="font-size:0.75rem;color:var(--text)"
          title={props.r.modelLabel ?? undefined}
        >
          {props.r.modelLabel ?? '—'}
        </span>
      </Cell>
      <Cell label="Provider">
        <span class="cell-id" title={props.r.providerLabel ?? undefined}>
          {props.r.providerLabel ?? '—'}
        </span>
      </Cell>
      <Cell label="Tier">
        <span class="cell-id" title={props.r.tierAssigned ?? undefined}>
          {props.r.tierAssigned ?? '—'}
        </span>
      </Cell>
      <Cell label="Decided by">
        <span>
          <span class="chip" style={LAYER_CHIP_STYLE}>
            {props.r.decisionLayer}
          </span>
        </span>
      </Cell>
      <Cell label="Tokens">
        <span class="figure cell-figure" style="font-size:0.6875rem;color:var(--text3)">
          —
        </span>
      </Cell>
      <Cell label="Cost">
        <span class="figure cell-figure" style="font-size:0.6875rem;color:var(--text3)">
          —
        </span>
      </Cell>
      <Cell label="Latency">
        <span class="figure cell-figure" style="font-size:0.6875rem;color:var(--text2)">
          {fmtLatency(elapsed())}
        </span>
      </Cell>
      <Cell label="Status">
        <span style="display:flex;align-items:center;gap:4px;color:var(--text2)">
          <span
            aria-hidden="true"
            style={{
              width: '6px',
              height: '6px',
              'border-radius': '50%',
              // Neutral while running, never indigo (the Indigo Budget, D11).
              background: props.r.phase === 'settling' ? 'var(--faint)' : 'var(--text3)',
              flex: 'none',
              // Reuses the global `pulse` keyframe; the app's reduced-motion media
              // query forces iteration-count 1, so it settles to a static dot. A settling
              // row does not pulse: it is no longer in progress, and reduced-motion
              // behaviour is unchanged either way.
              ...(props.r.phase === 'settling'
                ? {}
                : { animation: 'pulse 1.5s ease-in-out infinite' }),
            }}
          />
          {/* A row in the settling bridge has FINISHED — its durable row is being written.
              Saying "Running" there asserts an outcome that has already been decided, for
              up to the grace period, on every surface that renders these rows. */}
          {props.r.phase === 'settling' ? 'Finishing' : 'Running'}
        </span>
      </Cell>
    </div>
  );
}
