import { createSignal, For, onCleanup, onMount } from 'solid-js';
import { labelOf, type InflightRow, type RequestRow, type RequestStatus } from '../data/api';
import { rowCostLabel } from '../data/analytics';
import { fmtTime, fmtTokens } from '../data/catalog';
import { useApp } from '../state/context';

const GRID = '66px 1.5fr 1.1fr 0.8fr 1.1fr 0.9fr 0.7fr 0.6fr 0.8fr';

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
    <div class="table-head" style={{ 'grid-template-columns': GRID }}>
      <div>Time</div>
      <div>Model</div>
      <div>Provider</div>
      <div>Tier</div>
      <div>Decided by</div>
      <div>Tokens</div>
      <div>Cost</div>
      <div>Latency</div>
      <div>Status</div>
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
      style={{
        'grid-template-columns': GRID,
        background: selected() ? 'var(--accent-bg)' : 'transparent',
      }}
      aria-expanded={selected()}
      aria-controls="inspector-drawer"
      onClick={() => app.select(selected() ? null : props.r.id)}
    >
      <span class="mono" style="font-size:11px;color:var(--text3)">
        {fmtTime(new Date(props.r.createdAt).getTime())}
      </span>
      <span class="mono" style="font-size:11.5px;color:var(--text)">
        {labelOf(props.r.modelLabel, props.r.modelId)}
      </span>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
        {labelOf(props.r.providerLabel, props.r.providerId)}
      </span>
      <span>{props.r.tierAssigned ?? '—'}</span>
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
          {props.r.escalated ? `${props.r.decisionLayer} ↗` : props.r.decisionLayer}
        </span>
      </span>
      <span class="mono" style="font-size:11px">
        {fmtTokens(props.r.inputTokens)} → {fmtTokens(props.r.outputTokens)}
      </span>
      <span class="mono" style="font-size:11px;color:var(--text)">
        {rowCostLabel(props.r)}
      </span>
      <span class="mono" style="font-size:11px">
        {(props.r.durationMs / 1000).toFixed(1)}s
      </span>
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
export function InflightRows(props: { rows: InflightRow[] }) {
  const now = useNow();
  return <For each={props.rows}>{(r) => <InflightRunningRow r={r} now={now()} />}</For>;
}

function InflightRunningRow(props: { r: InflightRow; now: number }) {
  const chip = (): { bg: string; fg: string } => CHIP[props.r.decisionLayer] ?? NEUTRAL_CHIP;
  const elapsed = (): number => Math.max(0, (props.now - props.r.startedAt) / 1000);
  return (
    // Non-interactive by design (no terminal detail to inspect yet). No aria-label:
    // a bare div has no role to hang one on, and the row's own text already reads
    // out completely — time, model, provider, tier, layer, and "Running".
    <div class="req-row" style={{ 'grid-template-columns': GRID, cursor: 'default' }}>
      <span class="mono" style="font-size:11px;color:var(--text3)">
        {fmtTime(props.r.startedAt)}
      </span>
      <span class="mono" style="font-size:11.5px;color:var(--text)">
        {props.r.modelLabel ?? '—'}
      </span>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
        {props.r.providerLabel ?? '—'}
      </span>
      <span>{props.r.tierAssigned ?? '—'}</span>
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
      <span class="mono" style="font-size:11px;color:var(--text3)">
        —
      </span>
      <span class="mono" style="font-size:11px;color:var(--text3)">
        —
      </span>
      <span class="mono" style="font-size:11px;color:var(--text2)">
        {elapsed().toFixed(1)}s
      </span>
      <span style="display:flex;align-items:center;gap:5px;color:var(--text2)">
        <span
          aria-hidden="true"
          style={{
            width: '6px',
            height: '6px',
            'border-radius': '50%',
            background: 'var(--accent)',
            flex: 'none',
            // Reuses the global `pulse` keyframe; the app's reduced-motion media
            // query forces iteration-count 1, so it settles to a static dot.
            animation: 'pulse 1.5s ease-in-out infinite',
          }}
        />
        Running
      </span>
    </div>
  );
}
