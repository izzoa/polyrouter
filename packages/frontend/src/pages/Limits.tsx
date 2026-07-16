import { For } from 'solid-js';
import { PreviewBanner } from '../components/PreviewBanner';
import { useApp } from '../state/context';

export function Limits() {
  const app = useApp();
  const { state } = app;
  return (
    <div style="padding:22px 26px;display:flex;flex-direction:column;gap:14px;max-width:1200px">
      <PreviewBanner note="Budgets shown here are simulated until the limits change ships." />
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="font:400 12.5px 'Geist',sans-serif;color:var(--text3)">
          Spend counters are atomic across instances — a blocked budget stops requests everywhere at
          once.
        </div>
        <div class="btn-primary" onClick={() => app.openModal('newLimit')}>
          New budget
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <For each={state.limits}>
          {(l) => {
            const pct = () => Math.min(100, Math.round((l.current / l.threshold) * 100));
            const hot = () => pct() >= 80;
            return (
              <div class="panel card">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
                  <div class="section-title" style="color:var(--text)">
                    {l.scope}
                  </div>
                  <span
                    style={{
                      padding: '2px 9px',
                      'border-radius': '10px',
                      font: "500 10.5px 'Geist',sans-serif",
                      background: l.action === 'alert' ? 'var(--chip)' : 'var(--red-bg)',
                      color: l.action === 'alert' ? 'var(--text2)' : 'var(--red)',
                    }}
                  >
                    {l.action === 'alert' ? 'Alert' : 'Block'}
                  </span>
                </div>
                <div style="display:flex;align-items:baseline;gap:6px;margin-bottom:8px">
                  <span style="font:600 20px 'Geist',sans-serif;letter-spacing:-.02em">
                    ${l.current.toFixed(2)}
                  </span>
                  <span style="font:400 12px 'Geist',sans-serif;color:var(--text3)">
                    of ${l.threshold.toFixed(2)} / {l.window}
                  </span>
                  <span
                    class="mono"
                    style={{
                      'margin-left': 'auto',
                      font: "500 12px 'Geist Mono',monospace",
                      color: hot() ? 'var(--amber)' : 'var(--text3)',
                    }}
                  >
                    {pct()}%
                  </span>
                </div>
                <div style="height:6px;background:var(--border2);border-radius:4px;overflow:hidden">
                  <div
                    style={{
                      width: `${String(pct())}%`,
                      height: '100%',
                      background: hot() ? 'var(--amber)' : 'var(--accent)',
                      'border-radius': '4px',
                    }}
                  />
                </div>
                <div style="display:flex;justify-content:space-between;margin-top:10px;font:400 11px 'Geist',sans-serif;color:var(--text3)">
                  <span>{l.note}</span>
                  <span>
                    resets{' '}
                    {l.window === 'day'
                      ? 'in 9h 28m'
                      : l.window === 'week'
                        ? 'Monday 00:00'
                        : 'Aug 1'}
                  </span>
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
