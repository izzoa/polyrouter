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
import { topLayer, type LayerEntry } from '../a11y';
import {
  agentRunLabel,
  isBatchItem,
  rowCostLabel,
  rowCostParts,
  startsAgentRun,
} from '../data/analytics';
import { fmtTime } from '../data/catalog';
import { EST_USAGE_PARTS, fmtLatency, fmtTokensCompact } from '../data/figures';
import { stepKey } from '../data/step';
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

type Column = (typeof COLUMNS)[number];

/** Each column's class (add-docked-inspector design D11): the head cell and every row's cell
 * carry it, so the priority forms can place a cell on its track, hide a moved column's head
 * label, and lay out a moved field on line two — by column, never by position. */
const COLUMN_CLASS: Record<Column, string> = {
  Time: 'rs-col-time',
  Model: 'rs-col-model',
  Provider: 'rs-col-provider',
  Tier: 'rs-col-tier',
  'Decided by': 'rs-col-decided',
  Tokens: 'rs-col-tokens',
  Cost: 'rs-col-cost',
  Latency: 'rs-col-latency',
  Status: 'rs-col-status',
};

/** One cell, carrying its field name for the stacked presentation and for line two.
 *
 * The label is `aria-hidden` deliberately. A completed request row is a single
 * `<button>` whose accessible name is its flattened text content — visible label text
 * would prepend "Time"/"Model"/… to that name and break the parity the spec requires.
 * Sighted users get the names; assistive technology gets the same name it got at desktop
 * width, where the head is a separate element with no association to the cells anyway. */
function Cell(props: { label: Column; children: JSX.Element }): JSX.Element {
  return (
    <span class={`rs-cell ${COLUMN_CLASS[props.label]}`}>
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

/** The one line a step of the inspector announces (add-docked-inspector design D10;
 * dashboard-analytics "Each step of the inspector is announced in one line"): the request's
 * absolute time, its model, its status in words and its cost, `·`-separated — each through the
 * formatter its row's cell renders with (`fmtTime`, the model label, the status word,
 * `rowCostLabel`), so the line reads as the row just reached, figure-state words included, and
 * its cost is the inspector's receipt total too (both are `rowCostParts`). */
export function requestStepLine(r: RequestRow): string {
  return [
    fmtTime(new Date(r.createdAt).getTime()),
    labelOf(r.modelLabel, r.modelId),
    textFor(r.status),
    rowCostLabel(r),
  ].join(' · ');
}

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

/** The escalated mark: a decorative glyph and the word that carries the state. Before this the
 * arrow was the ONLY difference between an escalated request and a normal one, and it was
 * unlabelled — so escalation was invisible to assistive technology entirely. */
function EscalatedMark() {
  return (
    <>
      <Icon name="escalated" size={11} />
      <span class="sr-only">escalated</span>
    </>
  );
}

/** One DOM for every form of the table (add-docked-inspector design D11). After the
 * priority-one cells, ONE outer wrapper holds two inner ones: the priority-three cells, then
 * the priority-two cells. Each is `display: contents` in the one-line form, so every cell is a
 * grid item there; a narrowed form makes the priority-three wrapper (form one) or the outer one
 * (form two, and a row that cannot open in the docked list) the flex line on row two. One
 * wrapper could not do both: once it is a flex line its cells are flex items, and grid
 * placement cannot move one back to line one. Phrasing content only — a completed row is a
 * `<button>`. */
function SubLine(props: { p3: JSX.Element; p2: JSX.Element }): JSX.Element {
  return (
    <span class="rs-subline">
      <span class="rs-sub-p3">{props.p3}</span>
      <span class="rs-sub-p2">{props.p2}</span>
    </span>
  );
}

/** The figure columns: right-aligned in the head as in every row (task 9.2). */
const FIGURE_COLUMNS: ReadonlySet<string> = new Set(['Tokens', 'Cost', 'Latency']);

export function RequestTableHead() {
  return (
    <div class="table-head">
      {/* Flat, one element per column in `COLUMNS` order, in every form: a narrowed form
          hides the head labels of the columns it moves to line two, so the labels left name
          line one's cells in the same order (design D11). */}
      <For each={COLUMNS}>
        {(c) => (
          <div
            class={FIGURE_COLUMNS.has(c) ? `${COLUMN_CLASS[c]} cell-figure` : COLUMN_CLASS[c]}
            title={c}
          >
            {c}
          </div>
        )}
      </For>
    </div>
  );
}

/** The rendered row of request `id`, found by its `data-request-id` — the inspector's restore
 * target on close (add-docked-inspector D6), compared on the id itself, never a selector built
 * from it. `null` when that request has no row on screen. */
export function renderedRequestRow(id: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>('button.req-row[data-request-id]')) {
    if (el.dataset['requestId'] === id) return el;
  }
  return null;
}

/** The request table panel on screen — the Requests page's ("Requests") or the Overview card's
 * ("Recent requests"): a named region with `tabindex="-1"`, so focus can land on the list when
 * the row it was meant for is not rendered (D6). */
export function requestTablePanel(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.rs-table-requests[role="region"]');
}

/** The inspector is the topmost layer — the arbiter's own ordering, so a menu, popup or dialog
 * open above it owns the arrow keys and stepping stands down (add-docked-inspector D8). */
export function inspectorIsTopmost(layers: readonly LayerEntry[]): boolean {
  const root = topLayer(layers)?.root();
  return root !== undefined && root.id === 'inspector-drawer';
}

export function RequestRow(props: { r: RequestRow }) {
  const app = useApp();
  const { state } = app;
  const selected = () => state.selId === props.r.id;
  /** Docked stepping (add-docked-inspector D8; dashboard-analytics "Docked stepping moves the
   * selection without leaving the list"). Only while the inspector is docked — the modal
   * presentations step through Previous / Next — and relative to THIS row, the focused one,
   * not the selection. Each guard is checked, not inferred from where focus is: a composing
   * input method, a modifier, a target other than the row itself, and any layer above the
   * inspector all leave the key exactly as it would be with no inspector open. A handled key
   * prevents its default, even at a bound, so the page never also scrolls. Focus moves to the
   * row stepped to without a scroll jump, and the row is then brought into view inside the
   * page's pane. */
  const onKeyDown = (e: KeyboardEvent & { currentTarget: HTMLButtonElement }): void => {
    if (!app.inspectorDocked()) return;
    const dir = stepKey(e);
    if (dir === null || e.target !== e.currentTarget) return;
    if (!inspectorIsTopmost(state.layers)) return;
    e.preventDefault();
    const id = app.stepSelection(dir, props.r.id);
    if (id === null) return;
    const next = renderedRequestRow(id);
    next?.focus({ preventScroll: true });
    next?.scrollIntoView({ block: 'nearest' });
  };
  /** Activation (add-docked-inspector D6). Another row selects; the selected row never closes
   * the inspector — closing is Escape or its Close control in every presentation. Docked, the
   * panel takes no focus on open, so re-activating the open row is the one-key route into it,
   * and the row keeps `aria-expanded="true"` because the panel is still open. In a modal
   * presentation the selected row sits behind the scrim, so this branch is not reachable
   * there; it would only focus the modal that already holds focus. */
  const activate = (row: HTMLButtonElement): void => {
    if (!selected()) {
      app.select(props.r.id);
      // Docked, the row keeps focus by an explicit call, never by the browser's click
      // default: Safari and Firefox on macOS do not focus a <button> on a mouse click, so
      // focus would land on the table panel and the arrow keys would scroll the page instead
      // of stepping. Modal, the dialog takes focus on registration.
      if (app.inspectorDocked()) row.focus({ preventScroll: true });
      return;
    }
    document.getElementById('inspector-drawer')?.focus();
  };
  return (
    <button
      type="button"
      class="req-row row-hover"
      data-request-id={props.r.id}
      // The open row's Selected state, the wash and an inset deep-indigo edge, is the
      // `.req-row[aria-expanded='true']` rule in styles.css (adopt-design-tokens-v2 D8).
      // Nothing inline: an inline fill outranks the row's hover tone.
      aria-expanded={selected()}
      aria-controls="inspector-drawer"
      onClick={(e) => activate(e.currentTarget)}
      onKeyDown={onKeyDown}
    >
      {/* Priority one first — time, model, cost, status — then the second line's wrapper. The
          DOM order is the same in every form, so the row's accessible name is too; each cell
          takes its track by explicit placement, so line one keeps today's column order
          (design D11). */}
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
          {/* The docked compact list hides the Decided-by cell, which carries these two marks,
              so the status cell carries them there, after the status word (dashboard-analytics
              "A completed row's state marks move to its status cell while docked"). The same
              components as the Decided-by cell; displayed ONLY under `.rs-docked-list` at the
              dock threshold, where the Decided-by copy is not, so exactly one copy is ever in
              the accessibility tree. */}
          <Show when={props.r.escalated || isBatchItem(props.r)}>
            <span class="rs-docked-marks">
              <Show when={props.r.escalated}>
                <EscalatedMark />
              </Show>
              <Show when={isBatchItem(props.r)}>
                <BatchChip />
              </Show>
            </span>
          </Show>
        </span>
      </Cell>
      <SubLine
        p3={
          <>
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
                    {' '}
                    <EscalatedMark />
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
          </>
        }
        p2={
          <>
            <Cell label="Tokens">
              {/* `↑`/`↓` rather than the words: at real magnitudes "87.2k in / 1.5k out" is
                  125px against a 112px column and wraps to two lines. A figure, so Geist with
                  tabular numerals (adopt-design-tokens-v2 task 9.1). Both arrows are present
                  in Geist (`geist-latin.woff2`) as in Geist Mono — checked against the cmaps,
                  not the `unicode-range` — and the coverage guard fails if a future subset
                  drops them, which is the protection `→` never had.
                  The words move to screen-reader text: an arrow announces as "up arrow", so
                  the compact form would otherwise trade a layout bug for an accessibility one.
                  Counts are compact through the one shared formatter (adopt-figure-states D8).
                  A count the provider did not report carries `· est. usage` (D3): one Ink 3
                  unit that wraps whole, inside the visible half so the dual pair stays one
                  aria-hidden node beside its screen-reader text, which says ", estimated
                  usage" in words. Usage estimates are marked here and never on the cost
                  cell. */}
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
            <Cell label="Latency">
              {/* A batch item's `duration_ms` is the JOB's wall time — the time the caller
                  actually waited — which runs to hours. `7412.3s` is not a reading, so it
                  is formatted as a job. Latency aggregates exclude these rows entirely. */}
              <span class="figure cell-figure" style="font-size:0.6875rem">
                {isBatchItem(props.r)
                  ? fmtElapsed(props.r.durationMs)
                  : fmtLatency(props.r.durationMs)}
              </span>
            </Cell>
          </>
        }
      />
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
      <Cell label="Cost">
        {/* A reservation is money PROMISED, not spent — it is never shown here (D13);
            the Batches page labels it as reserved where there is room to say so. */}
        <span class="figure cell-figure" style="font-size:0.6875rem;color:var(--text3)">
          —
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
      {/* A job cannot open — it has no detail surface — so in the docked list it keeps every
          field on this second line (dashboard-analytics "Rows that cannot open keep every
          field in the docked list"). */}
      <SubLine
        p3={
          <>
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
          </>
        }
        p2={
          <>
            <Cell label="Tokens">
              <span class="figure cell-figure" style="font-size:0.6875rem;color:var(--text3)">
                —
              </span>
            </Cell>
            <Cell label="Latency">
              <span class="figure cell-figure" style="font-size:0.6875rem;color:var(--text2)">
                {fmtElapsed(props.now - Date.parse(props.r.submittedAt))}
              </span>
            </Cell>
          </>
        }
      />
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
    // out completely — time, model, "Running", then provider, tier and layer.
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
      <Cell label="Cost">
        <span class="figure cell-figure" style="font-size:0.6875rem;color:var(--text3)">
          —
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
      {/* A live row cannot open — it has no detail surface yet — so in the docked list it keeps
          every field on this second line, its latency still ticking. */}
      <SubLine
        p3={
          <>
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
          </>
        }
        p2={
          <>
            <Cell label="Tokens">
              <span class="figure cell-figure" style="font-size:0.6875rem;color:var(--text3)">
                —
              </span>
            </Cell>
            <Cell label="Latency">
              <span class="figure cell-figure" style="font-size:0.6875rem;color:var(--text2)">
                {fmtLatency(elapsed())}
              </span>
            </Cell>
          </>
        }
      />
    </div>
  );
}
