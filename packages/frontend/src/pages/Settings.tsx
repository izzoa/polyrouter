import { For, Show } from 'solid-js';
import { PreviewBanner } from '../components/PreviewBanner';
import { Toggle } from '../components/Toggle';
import { BASE_URL } from '../data/catalog';
import { useApp } from '../state/context';

export function Settings() {
  const app = useApp();
  const { state } = app;
  const session = () => state.session;
  const isAdmin = () => session()?.role === 'admin' && session()?.mode === 'selfhosted';

  return (
    <div style="padding:22px 26px;display:flex;flex-direction:column;gap:12px;max-width:760px">
      <div class="panel card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div class="section-title" style="margin-bottom:12px">
            Instance
          </div>
          <div class="btn-ghost" onClick={() => void app.signOut()}>
            Log out
          </div>
        </div>
        <div style="display:grid;grid-template-columns:140px 1fr;gap:8px 16px;font:400 12.5px 'Geist',sans-serif;color:var(--text2);align-items:center">
          <div style="color:var(--text3)">Account</div>
          <div>
            {session()?.email ?? '—'}
            <Show when={session()?.role}>
              {(role) => (
                <span class="chip" style="font-size:10.5px;color:var(--text3);margin-left:6px">
                  {role()}
                </span>
              )}
            </Show>
          </div>
          <div style="color:var(--text3)">Mode</div>
          <div class="mono" style="font-size:11.5px">
            {session()?.mode ?? '—'}
          </div>
          <div style="color:var(--text3)">Endpoint</div>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="mono" style="font-size:11.5px">
              {BASE_URL}
            </span>
            <span
              class="link-accent"
              style="font-size:11.5px"
              onClick={() => app.copy(BASE_URL, 'Endpoint copied')}
            >
              Copy
            </span>
          </div>
          <div style="color:var(--text3)">Version</div>
          <div class="mono" style="font-size:11.5px">
            v0.4.1 · postgres 16 · redis 7
          </div>
        </div>
        <Show when={session()?.mode === 'selfhosted'}>
          <div style="font:400 11px 'Geist',sans-serif;color:var(--text3);margin-top:10px;line-height:1.5">
            Self-hosted loopback uses auto-login with no session cookie — “Log out” is inert here
            and you’ll land straight back in.
          </div>
        </Show>
      </div>

      <div class="panel card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:20px">
          <div>
            <div class="section-title" style="margin-bottom:3px">
              Log prompt & response bodies
            </div>
            <div style="font:400 11.5px 'Geist',sans-serif;color:var(--text3);line-height:1.5">
              Off by default — polyrouter stores metadata only (tokens, cost, latency, decision).
              Bodies never leave this box either way.
              <Show when={!isAdmin()}>
                <span style="color:var(--amber)"> Admin only.</span>
              </Show>
            </div>
          </div>
          <Toggle
            on={state.bodyLog}
            size="md"
            locked={!isAdmin()}
            onToggle={() => {
              if (isAdmin()) app.toggleBodyLog();
            }}
          />
        </div>
      </div>

      <div class="panel card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <div class="section-title">Notifications</div>
          <div
            class="link-accent"
            style="font:500 12px 'Geist',sans-serif"
            onClick={() => app.addChannel()}
          >
            + Add channel
          </div>
        </div>
        <div style="margin-bottom:10px">
          <PreviewBanner note="Notification channels are simulated until the notifications change ships." />
        </div>
        <div style="font:400 11.5px 'Geist',sans-serif;color:var(--text3);margin-bottom:12px">
          Budget alerts, provider-down and failure spikes fan out to every enabled channel —
          delivered async, never blocking a request.
        </div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <For each={state.channels}>
            {(c) => (
              <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--bg);border:1px solid var(--border2);border-radius:8px">
                <Toggle on={c.enabled} onToggle={() => app.toggleChannel(c.id)} />
                <div style="min-width:0">
                  <div style="font:500 12.5px 'Geist',sans-serif;color:var(--text)">
                    {c.name}{' '}
                    <span
                      class="chip mono"
                      style="font:500 10px 'Geist Mono',monospace;color:var(--text3);margin-left:4px"
                    >
                      {c.kind}
                    </span>
                  </div>
                  <div style="font:400 11px 'Geist',sans-serif;color:var(--text3)">{c.detail}</div>
                </div>
                <div style="margin-left:auto;display:flex;align-items:center;gap:10px">
                  <span
                    style={{
                      font: "400 11px 'Geist',sans-serif",
                      color: c.lastOk === true ? 'var(--green)' : 'var(--text3)',
                    }}
                  >
                    {c.testing ? 'sending…' : c.last}
                  </span>
                  <div
                    class="btn-ghost"
                    style="background:var(--panel)"
                    onClick={() => app.testChannel(c.id)}
                  >
                    {c.testing ? '…' : 'Send test'}
                  </div>
                </div>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
