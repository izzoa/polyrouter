import { For } from 'solid-js';
import { BarRows } from '../components/BarRows';
import { RequestRows, RequestTableHead } from '../components/RequestTable';
import { SEED_FALLBACK_DOTS, SEED_OVERVIEW_NOTES, SEED_SPEND_BY_MODEL_24H } from '../data/seed';
import { app } from '../state/appState';
import type { Range } from '../types';

const RANGES: Range[] = ['24h', '7d', '30d'];

export function Overview(props: { live: boolean }) {
  const { state } = app;
  const chartPts = () => {
    const max = Math.max(...state.chart);
    return state.chart.map((v, i) => [
      Math.round(i * (540 / (state.chart.length - 1))),
      Math.round(120 - (v / max) * 95),
    ]);
  };
  const line = () =>
    `M${chartPts()
      .map((p) => `${String(p[0])},${String(p[1])}`)
      .join(' L')}`;

  return (
    <div style="padding:22px 26px;display:flex;flex-direction:column;gap:14px;max-width:1200px">
      <div style="display:flex;justify-content:flex-end">
        <div style="display:flex;background:var(--panel);border:1px solid var(--border);border-radius:7px;padding:2px">
          <For each={RANGES}>
            {(rg) => (
              <div
                style={{
                  padding: '4px 12px',
                  font: `${state.range === rg ? '500' : '400'} 12px 'Geist',sans-serif`,
                  color: state.range === rg ? 'var(--text)' : 'var(--text3)',
                  background: state.range === rg ? 'var(--chip)' : 'transparent',
                  'border-radius': '5px',
                  cursor: 'pointer',
                }}
                onClick={() => app.setRange(rg)}
              >
                {rg}
              </div>
            )}
          </For>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px">
        <div class="panel card">
          <div class="stat-label">Spend</div>
          <div class="stat-value">${state.stats.spend.toFixed(2)}</div>
          <div class="stat-sub" style="color:var(--green)">
            {SEED_OVERVIEW_NOTES.spendVsList}
          </div>
        </div>
        <div class="panel card">
          <div class="stat-label">Requests</div>
          <div class="stat-value">{state.stats.reqs.toLocaleString()}</div>
          <div class="stat-sub">{SEED_OVERVIEW_NOTES.requestsTrend}</div>
        </div>
        <div class="panel card">
          <div class="stat-label">Tokens</div>
          <div class="stat-value">{((state.stats.tin + state.stats.tout) / 1e6).toFixed(2)}M</div>
          <div class="stat-sub">
            {(state.stats.tin / 1e6).toFixed(2)}M in · {(state.stats.tout / 1e6).toFixed(2)}M out
          </div>
        </div>
        <div class="panel card">
          <div class="stat-label">Fallback rate</div>
          <div class="stat-value">{((state.stats.fb / state.stats.reqs) * 100).toFixed(1)}%</div>
          <div class="stat-sub">
            {state.stats.fb} fired · {state.stats.esc} escalated
          </div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 300px;gap:12px">
        <div class="panel card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <div class="section-title">Requests per hour</div>
            <div style="display:flex;gap:14px;font:400 11px 'Geist',sans-serif;color:var(--text3)">
              <span style="display:flex;align-items:center;gap:5px">
                <span style="width:8px;height:2.5px;background:var(--accent);border-radius:2px" />
                Routed
              </span>
              <span style="display:flex;align-items:center;gap:5px">
                <span style="width:8px;height:2.5px;background:var(--amber);border-radius:2px" />
                Fallback
              </span>
            </div>
          </div>
          <svg
            width="100%"
            height="126"
            viewBox="0 0 540 126"
            preserveAspectRatio="none"
            style="display:block"
          >
            <line x1="0" y1="31" x2="540" y2="31" stroke="var(--border2)" stroke-width="1" />
            <line x1="0" y1="63" x2="540" y2="63" stroke="var(--border2)" stroke-width="1" />
            <line x1="0" y1="95" x2="540" y2="95" stroke="var(--border2)" stroke-width="1" />
            <path d={`${line()} L540,126 L0,126 Z`} fill="var(--accent-bg)" />
            <path
              d={line()}
              fill="none"
              stroke="var(--accent)"
              stroke-width="1.8"
              stroke-linejoin="round"
            />
            <For each={SEED_FALLBACK_DOTS}>
              {(x) => <circle cx={x} cy="116" r="2.2" fill="var(--amber)" />}
            </For>
          </svg>
          <div style="display:flex;justify-content:space-between;font:400 10.5px 'Geist Mono',monospace;color:var(--faint);margin-top:6px">
            <span>00:00</span>
            <span>06:00</span>
            <span>12:00</span>
            <span>18:00</span>
            <span>now</span>
          </div>
        </div>
        <div class="panel card">
          <div class="section-title" style="margin-bottom:14px">
            Spend by model
          </div>
          <BarRows data={SEED_SPEND_BY_MODEL_24H} />
        </div>
      </div>
      <div
        class="panel"
        style="display:flex;align-items:center;gap:16px;padding:11px 18px;flex-wrap:wrap;border-radius:10px"
      >
        <span class="upper-label" style="letter-spacing:.05em">
          Providers
        </span>
        <For each={state.providers}>
          {(p) => (
            <span
              style="display:flex;align-items:center;gap:6px;font:400 12px 'Geist',sans-serif;color:var(--text2);cursor:pointer"
              onClick={() => app.go('providers')}
            >
              <span
                style={{
                  width: '6px',
                  height: '6px',
                  'border-radius': '50%',
                  background: p.status === 'ok' ? 'var(--green)' : 'var(--amber)',
                }}
              />
              {p.name}
              {p.kind === 'local' ? ' · local' : ''}
              {p.status === 'warn' ? ' · circuit half-open' : ''}
            </span>
          )}
        </For>
      </div>
      <div class="panel" style="overflow:hidden;border-radius:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:13px 18px;border-bottom:1px solid var(--border2)">
          <div class="section-title">Recent requests</div>
          <div
            class="link-accent"
            style="font:400 12px 'Geist',sans-serif"
            onClick={() => app.go('requests')}
          >
            View all →
          </div>
        </div>
        <RequestTableHead />
        <RequestRows rows={state.requests.slice(0, 6)} live={props.live} />
      </div>
    </div>
  );
}
