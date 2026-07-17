import { For } from 'solid-js';
import { labelOf, type RequestRow, type RequestStatus } from '../data/api';
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
