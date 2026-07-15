import { For, Show } from 'solid-js';
import { fmtCost, fmtTime, fmtTokens } from '../data/catalog';
import { app } from '../state/appState';
import type { DecisionLayer, RoutedRequest } from '../types';

const GRID = '66px 1.5fr 1.1fr 0.8fr 1.1fr 0.9fr 0.7fr 0.6fr 0.8fr';

const CHIP: Record<DecisionLayer, { bg: string; fg: string }> = {
  explicit: { bg: 'var(--accent-bg)', fg: 'var(--accent-deep)' },
  header: { bg: 'var(--chip)', fg: 'var(--text2)' },
  structural: { bg: 'var(--chip)', fg: 'var(--text2)' },
  escalated: { bg: 'var(--amber-bg)', fg: 'var(--amber)' },
};

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

export function RequestRow(props: { r: RoutedRequest; animate: boolean }) {
  const { state } = app;
  const selected = () => state.selId === props.r.id;
  const chip = () => CHIP[props.r.layer];
  return (
    <div
      class="req-row row-hover"
      style={{
        'grid-template-columns': GRID,
        background: selected() ? 'var(--accent-bg)' : 'transparent',
        animation: props.animate ? 'rowin 1.6s ease-out' : 'none',
      }}
      onClick={() => app.select(selected() ? null : props.r.id)}
    >
      <div class="mono" style="font-size:11px;color:var(--text3)">
        {fmtTime(props.r.ts)}
      </div>
      <div class="mono" style="font-size:11.5px;color:var(--text)">
        {props.r.model}
      </div>
      <div style="display:flex;align-items:center;gap:5px;min-width:0">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          {props.r.provider}
        </span>
        <Show when={props.r.tag}>
          <span style="font-size:10px;color:var(--text3);border:1px solid var(--border);border-radius:4px;padding:0 4px;flex:none">
            {props.r.tag}
          </span>
        </Show>
      </div>
      <div>{props.r.tier}</div>
      <div>
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
          {props.r.layer === 'escalated' ? 'escalated ↗' : props.r.layer}
        </span>
      </div>
      <div class="mono" style="font-size:11px">
        {fmtTokens(props.r.tin)} → {fmtTokens(props.r.tout)}
      </div>
      <div
        class="mono"
        style={{
          'font-size': '11px',
          color: props.r.tag === 'local' ? 'var(--green)' : 'var(--text)',
        }}
      >
        {fmtCost(props.r)}
        {props.r.estimated ? '~' : ''}
      </div>
      <div class="mono" style="font-size:11px">
        {(props.r.ms / 1000).toFixed(1)}s
      </div>
      <div style="display:flex;align-items:center;gap:5px">
        <span
          style={{
            width: '6px',
            height: '6px',
            'border-radius': '50%',
            background: props.r.status === 'ok' ? 'var(--green)' : 'var(--amber)',
            flex: 'none',
          }}
        />
        {props.r.status === 'ok' ? 'OK' : 'Fallback'}
      </div>
    </div>
  );
}

export function RequestRows(props: { rows: RoutedRequest[]; live: boolean }) {
  const newestId = () => app.state.requests[0]?.id;
  return (
    <For each={props.rows}>
      {(r) => <RequestRow r={r} animate={props.live && r.id === newestId()} />}
    </For>
  );
}
