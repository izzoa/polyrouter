import { For } from 'solid-js';
import { BASE_URL } from '../data/catalog';
import { app } from '../state/appState';

const GRID = '1.3fr 1fr 1.2fr 0.9fr 0.8fr 0.8fr 1.2fr';

export function Agents() {
  const { state } = app;
  return (
    <div style="padding:22px 26px;display:flex;flex-direction:column;gap:14px;max-width:1200px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="font:400 12.5px 'Geist',sans-serif;color:var(--text3)">
          Each agent gets its own API key — point it at{' '}
          <span class="mono" style="font-size:11.5px;color:var(--text2)">
            {BASE_URL}
          </span>
        </div>
        <div class="btn-primary" onClick={() => app.openModal('newAgent')}>
          New agent
        </div>
      </div>
      <div class="panel" style="overflow:hidden;border-radius:10px">
        <div class="table-head" style={{ 'grid-template-columns': GRID }}>
          <div>Agent</div>
          <div>Harness</div>
          <div>Key</div>
          <div>Requests · 24h</div>
          <div>Spend · 24h</div>
          <div>Last used</div>
          <div style="text-align:right">Actions</div>
        </div>
        <For each={state.agents}>
          {(a) => (
            <div
              class="row-hover"
              style={{
                display: 'grid',
                'grid-template-columns': GRID,
                gap: '0 14px',
                padding: '11px 18px',
                'border-bottom': '1px solid var(--border2)',
                font: "400 12.5px 'Geist',sans-serif",
                color: 'var(--text2)',
                'align-items': 'center',
              }}
            >
              <div style="font-weight:500;color:var(--text)">{a.name}</div>
              <div>
                <span class="chip">{a.harness}</span>
              </div>
              <div class="mono" style="font-size:11px;color:var(--text3)">
                {a.prefix}…
              </div>
              <div class="mono" style="font-size:11.5px">
                {a.reqs}
              </div>
              <div class="mono" style="font-size:11.5px">
                {a.spend}
              </div>
              <div style="font-size:11.5px;color:var(--text3)">{a.last}</div>
              <div style="display:flex;gap:6px;justify-content:flex-end">
                <div class="btn-ghost" onClick={() => app.revealSnippet(a)}>
                  Snippet
                </div>
                <div class="btn-ghost btn-ghost--amber" onClick={() => app.rotateKey(a)}>
                  Rotate key
                </div>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
