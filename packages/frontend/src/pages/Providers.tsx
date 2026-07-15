import { For } from 'solid-js';
import { app } from '../state/appState';

export function Providers() {
  const { state } = app;
  return (
    <div style="padding:22px 26px;display:flex;flex-direction:column;gap:14px;max-width:1200px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="font:400 12.5px 'Geist',sans-serif;color:var(--text3)">
          Your keys, your accounts — requests go straight from this box to the provider.
        </div>
        <div class="btn-primary" onClick={() => app.openModal('newProvider')}>
          Add provider
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
        <For each={state.providers}>
          {(p) => (
            <div class="panel card" style="display:flex;flex-direction:column;gap:10px">
              <div style="display:flex;align-items:center;justify-content:space-between">
                <div style="display:flex;align-items:center;gap:8px">
                  <span
                    style={{
                      width: '8px',
                      height: '8px',
                      'border-radius': '50%',
                      background: p.status === 'ok' ? 'var(--green)' : 'var(--amber)',
                      flex: 'none',
                    }}
                  />
                  <span style="font:500 13.5px 'Geist',sans-serif;color:var(--text)">{p.name}</span>
                </div>
                <span class="chip" style="font:500 10.5px 'Geist',sans-serif;color:var(--text3)">
                  {p.kind}
                </span>
              </div>
              <div
                style={{
                  font: "400 11.5px 'Geist',sans-serif",
                  color: p.status === 'ok' ? 'var(--green)' : 'var(--amber)',
                }}
              >
                {p.status === 'ok'
                  ? 'Healthy · circuit closed'
                  : 'Rate-limited · circuit half-open, retrying in 41s'}
              </div>
              <div
                class="mono"
                style="display:flex;gap:14px;font:400 11px 'Geist Mono',monospace;color:var(--text3)"
              >
                <span>{p.models} models</span>
                <span>{p.reqs} req · 24h</span>
                <span>{p.spend}</span>
              </div>
              <div style="display:flex;gap:6px;margin-top:2px">
                <div class="btn-ghost" onClick={() => app.say(`${p.name}: connection OK (214ms)`)}>
                  Test
                </div>
                <div
                  class="btn-ghost"
                  onClick={() => app.say(`${p.name}: catalog synced — ${String(p.models)} models`)}
                >
                  Sync models
                </div>
              </div>
            </div>
          )}
        </For>
      </div>
      <div style="font:400 11.5px 'Geist',sans-serif;color:var(--text3);padding:0 2px">
        Subscription providers reuse flat-rate plans — this may conflict with the provider's terms
        of service. Pair them with an API-key fallback.
      </div>
    </div>
  );
}
