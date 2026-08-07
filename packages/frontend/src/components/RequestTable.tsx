import { createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { labelOf, type RequestRow, type RequestStatus } from '../data/api';
import type { InflightDisplayRow } from '../data/inflight';
import { rowCostLabel } from '../data/analytics';
import { fmtTime, fmtTokens } from '../data/catalog';
import { useApp } from '../state/context';
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

/** Decision-layer chip palette. Any unknown layer renders neutral (invariant 1 —
 * the table is layer-agnostic). */
const CHIP: Record<string, { bg: string; fg: string }> = {
  explicit: { bg: 'var(--accent-bg)', fg: 'var(--accent-deep)' },
  header: { bg: 'var(--chip)', fg: 'var(--text2)' },
  default: { bg: 'var(--chip)', fg: 'var(--text2)' },
  structural: { bg: 'var(--chip)', fg: 'var(--text2)' },
  cascade: { bg: 'var(--amber-bg)', fg: 'var(--amber)' },
};
const NEUTRAL_CHIP = { bg: 'var(--chip)', fg: 'var(--text2)' };

const STATUS_DOT: Record<RequestStatus, string> = {
  success: 'var(--green)',
  fallback: 'var(--amber)',
  error: 'var(--red)',
  cancelled: 'var(--text3)',
};
const STATUS_TEXT: Record<RequestStatus, string> = {
  success: 'OK',
  fallback: 'Fallback',
  error: 'Error',
  cancelled: 'Cancelled',
};
// `status` is free-form text at the DB — an unknown/legacy value renders neutrally
// instead of crashing on a missing map entry.
const dotFor = (s: string): string => STATUS_DOT[s as RequestStatus] ?? 'var(--text3)';
const textFor = (s: string): string => STATUS_TEXT[s as RequestStatus] ?? (s || 'unknown');

export function RequestTableHead() {
  return (
    <div class="table-head">
      <For each={COLUMNS}>{(c) => <div>{c}</div>}</For>
    </div>
  );
}

export function RequestRow(props: { r: RequestRow }) {
  const app = useApp();
  const { state } = app;
  const selected = () => state.selId === props.r.id;
  const chip = () => CHIP[props.r.decisionLayer] ?? NEUTRAL_CHIP;
  return (
    <button
      type="button"
      class="req-row row-hover"
      style={{ background: selected() ? 'var(--accent-bg)' : 'transparent' }}
      aria-expanded={selected()}
      aria-controls="inspector-drawer"
      onClick={() => app.select(selected() ? null : props.r.id)}
    >
            <Cell label="Time">
        <span class="mono" style="font-size:11px;color:var(--text3)">
          {fmtTime(new Date(props.r.createdAt).getTime())}
        </span>
      </Cell>
      <Cell label="Model">
        <span class="mono" style="font-size:11.5px;color:var(--text)">
          {labelOf(props.r.modelLabel, props.r.modelId)}
        </span>
      </Cell>
      <Cell label="Provider">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          {labelOf(props.r.providerLabel, props.r.providerId)}
        </span>
      </Cell>
      <Cell label="Tier">
        <span>{props.r.tierAssigned ?? '—'}</span>
      </Cell>
      <Cell label="Decided by">
        <span>
          <span
            style={{
              padding: '2px 8px',
              background: chip().bg,
              color: chip().fg,
              'border-radius': '10px',
              'font-size': '11px',
              'font-weight': '500',
            }}
          >
            {props.r.decisionLayer}
            <Show when={props.r.escalated}>
              {/* The mark is decorative; the word carries the state. Before this the arrow was
                  the ONLY difference between an escalated request and a normal one, and it was
                  unlabelled — so escalation was invisible to assistive technology entirely. */}
              {' '}
              <Icon name="escalated" size={11} />
              <span class="sr-only">escalated</span>
            </Show>
          </span>
        </span>
      </Cell>
      <Cell label="Tokens">
        {/* `↑`/`↓` rather than the words: at real magnitudes "87.2k in / 1.5k out" is 125px
            against a 112px column and wraps to two lines. Both arrows are present in Geist
            Mono — checked against the font's cmap, not its `unicode-range` — and the coverage
            guard fails if a future subset drops them, which is the protection `→` never had.
            The words move to screen-reader text: an arrow announces as "up arrow", so the
            compact form would otherwise trade a layout bug for an accessibility one. */}
        <span class="mono" style="font-size:11px">
          <span aria-hidden="true">
            {fmtTokens(props.r.inputTokens)}↑ {fmtTokens(props.r.outputTokens)}↓
          </span>
          <span class="sr-only">
            {fmtTokens(props.r.inputTokens)} tokens in, {fmtTokens(props.r.outputTokens)} out
          </span>
        </span>
      </Cell>
      <Cell label="Cost">
        <span class="mono" style="font-size:11px;color:var(--text)">
          {rowCostLabel(props.r)}
        </span>
      </Cell>
      <Cell label="Latency">
        <span class="mono" style="font-size:11px">
          {(props.r.durationMs / 1000).toFixed(1)}s
        </span>
      </Cell>
      <Cell label="Status">
        <span style="display:flex;align-items:center;gap:5px">
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

export function RequestRows(props: { rows: RequestRow[] }) {
  return <For each={props.rows}>{(r) => <RequestRow r={r} />}</For>;
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
  const chip = (): { bg: string; fg: string } => CHIP[props.r.decisionLayer] ?? NEUTRAL_CHIP;
  const elapsed = (): number => Math.max(0, (props.now - props.r.startedAt) / 1000);
  return (
    // Non-interactive by design (no terminal detail to inspect yet). No aria-label:
    // a bare div has no role to hang one on, and the row's own text already reads
    // out completely — time, model, provider, tier, layer, and "Running".
    <div class="req-row" style={{ cursor: 'default' }}>
            <Cell label="Time">
        <span class="mono" style="font-size:11px;color:var(--text3)">
          {fmtTime(props.r.startedAt)}
        </span>
      </Cell>
      <Cell label="Model">
        <span class="mono" style="font-size:11.5px;color:var(--text)">
          {props.r.modelLabel ?? '—'}
        </span>
      </Cell>
      <Cell label="Provider">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          {props.r.providerLabel ?? '—'}
        </span>
      </Cell>
      <Cell label="Tier">
        <span>{props.r.tierAssigned ?? '—'}</span>
      </Cell>
      <Cell label="Decided by">
        <span>
          <span
            style={{
              padding: '2px 8px',
              background: chip().bg,
              color: chip().fg,
              'border-radius': '10px',
              'font-size': '11px',
              'font-weight': '500',
            }}
          >
            {props.r.decisionLayer}
          </span>
        </span>
      </Cell>
      <Cell label="Tokens">
        <span class="mono" style="font-size:11px;color:var(--text3)">
          —
        </span>
      </Cell>
      <Cell label="Cost">
        <span class="mono" style="font-size:11px;color:var(--text3)">
          —
        </span>
      </Cell>
      <Cell label="Latency">
        <span class="mono" style="font-size:11px;color:var(--text2)">
          {elapsed().toFixed(1)}s
        </span>
      </Cell>
      <Cell label="Status">
        <span style="display:flex;align-items:center;gap:5px;color:var(--text2)">
          <span
            aria-hidden="true"
            style={{
              width: '6px',
              height: '6px',
              'border-radius': '50%',
              background: props.r.phase === 'settling' ? 'var(--faint)' : 'var(--accent)',
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
