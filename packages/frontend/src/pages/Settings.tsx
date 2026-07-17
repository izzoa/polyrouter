import { For, onMount, Show } from 'solid-js';
import { Toggle } from '../components/Toggle';
import type { ChannelDto } from '../data/api';
import { BASE_URL } from '../data/catalog';
import { useApp } from '../state/context';

interface TestLine {
  text: string;
  ok: boolean | null;
}

export function Settings() {
  const app = useApp();
  const { state } = app;
  const session = () => state.session;

  onMount(() => void app.loadChannels());

  // Inline test-send result takes precedence; otherwise fall back to the stored
  // `lastTestStatus` (`success` | `failed:<code>`). Only `{ ok, error? }` is known.
  const testLine = (c: ChannelDto): TestLine => {
    const inline = state.channelTests[c.id];
    if (inline !== undefined) {
      return inline.ok
        ? { text: 'test ok', ok: true }
        : { text: `test failed — ${inline.error ?? 'error'}`, ok: false };
    }
    if (c.lastTestStatus === null) return { text: 'never tested', ok: null };
    if (c.lastTestStatus === 'success') return { text: 'test ok', ok: true };
    return { text: c.lastTestStatus.replace(/^failed:/, 'test failed — '), ok: false };
  };

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
          <div class="mono" style="font-size:11.5px">v{__APP_VERSION__}</div>
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
              Prompt & response bodies
            </div>
            <div style="font:400 11.5px 'Geist',sans-serif;color:var(--text3);line-height:1.5">
              polyrouter stores metadata only (tokens, cost, latency, routing decision) — prompt
              and response bodies are never persisted. This is a property of the build, not a
              runtime setting.
            </div>
          </div>
          <span
            class="chip"
            style="white-space:nowrap;color:var(--green);align-self:center"
            title="Request/response bodies are never stored"
          >
            Metadata-only
          </span>
        </div>
      </div>

      <div class="panel card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <div class="section-title">Notifications</div>
          <div
            class="link-accent"
            style="font:500 12px 'Geist',sans-serif"
            onClick={() => app.openChannel()}
          >
            + Add channel
          </div>
        </div>
        <div style="font:400 11.5px 'Geist',sans-serif;color:var(--text3);margin-bottom:12px">
          Budget alerts, provider-down and failure spikes fan out to every enabled channel —
          delivered async, never blocking a request.
        </div>

        <Show when={state.channelsError}>
          <div style="font:400 11.5px 'Geist',sans-serif;color:var(--red);margin-bottom:8px">
            Couldn’t load channels: {state.channelsError}
          </div>
        </Show>

        <div style="display:flex;flex-direction:column;gap:8px">
          <For
            each={state.channels}
            fallback={
              <div style="font:400 11.5px 'Geist',sans-serif;color:var(--faint)">
                {state.channelsLoading ? 'Loading channels…' : 'No channels yet.'}
              </div>
            }
          >
            {(c) => (
              <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--bg);border:1px solid var(--border2);border-radius:8px">
                <Toggle
                  on={c.enabled}
                  locked={state.channelToggling[c.id] ?? false}
                  onToggle={() => void app.toggleChannelEnabled(c)}
                />
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
                  <div style="font:400 11px 'Geist',sans-serif;color:var(--text3)">
                    {c.hasConfig ? 'config set (encrypted)' : 'no config'} ·{' '}
                    {c.eventsSubscribed.length} event
                    {c.eventsSubscribed.length === 1 ? '' : 's'}
                  </div>
                </div>
                <div style="margin-left:auto;display:flex;align-items:center;gap:10px">
                  {(() => {
                    const line = testLine(c);
                    return (
                      <span
                        style={{
                          font: "400 11px 'Geist',sans-serif",
                          color:
                            line.ok === true
                              ? 'var(--green)'
                              : line.ok === false
                                ? 'var(--red)'
                                : 'var(--text3)',
                        }}
                      >
                        {line.text}
                      </span>
                    );
                  })()}
                  <div
                    class="btn-ghost"
                    style={{
                      background: 'var(--panel)',
                      'pointer-events': state.channelTesting[c.id] ? 'none' : 'auto',
                      opacity: state.channelTesting[c.id] ? '0.6' : '1',
                    }}
                    onClick={() => void app.testChannelById(c.id)}
                  >
                    {state.channelTesting[c.id] ? 'Sending…' : 'Send test'}
                  </div>
                  <div class="btn-ghost" onClick={() => app.openChannel(c)}>
                    Edit
                  </div>
                  <div
                    class="btn-ghost btn-ghost--amber"
                    onClick={() => void app.deleteChannel(c.id)}
                  >
                    Delete
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
