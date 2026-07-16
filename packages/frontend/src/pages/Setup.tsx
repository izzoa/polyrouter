import { For, Show } from 'solid-js';
import { HarnessSelect } from '../components/Modals';
import { PROVIDER_KINDS } from '../state/appState';
import { useApp } from '../state/context';

export function Setup() {
  const app = useApp();
  const { state, setState } = app;
  const ob = () => state.ob;
  const steps = () =>
    (
      [
        ['Agent', 1],
        ['Provider', 2],
        ['Routing', 3],
      ] as const
    ).map(([label, n]) => {
      const done = (n === 1 && ob().done1) || (n === 2 && ob().done2);
      const active = ob().step === n;
      return { n, label, i: n - 1, done, active };
    });

  return (
    <div style="padding:34px 26px 60px;display:flex;justify-content:center">
      <div style="width:680px;max-width:100%;display:flex;flex-direction:column;gap:18px">
        <div style="display:flex;align-items:center;gap:0">
          <For each={steps()}>
            {(s) => (
              <div
                style={{ display: 'flex', 'align-items': 'center', flex: s.i < 2 ? '1' : 'none' }}
              >
                <div
                  style="display:flex;align-items:center;gap:8px;cursor:pointer"
                  onClick={() => app.obGo(s.n)}
                >
                  <div
                    style={{
                      width: '22px',
                      height: '22px',
                      'border-radius': '50%',
                      display: 'grid',
                      'place-items': 'center',
                      font: "600 11px 'Geist',sans-serif",
                      background: s.done
                        ? 'var(--green)'
                        : s.active
                          ? 'var(--accent)'
                          : 'var(--panel)',
                      color: s.done || s.active ? '#fff' : 'var(--text3)',
                      border: `1px solid ${s.done ? 'var(--green)' : s.active ? 'var(--accent)' : 'var(--border)'}`,
                    }}
                  >
                    {s.done ? '✓' : String(s.n)}
                  </div>
                  <span
                    style={{
                      font: "500 12px 'Geist',sans-serif",
                      color: s.active ? 'var(--text)' : 'var(--text3)',
                    }}
                  >
                    {s.label}
                  </span>
                </div>
                <Show when={s.i < 2}>
                  <div style="flex:1;height:1px;background:var(--border);margin:0 12px" />
                </Show>
              </div>
            )}
          </For>
        </div>

        {/* Step 1 — mint an agent key */}
        <Show when={ob().step === 1}>
          <div
            class="panel"
            style="border-radius:12px;padding:22px 24px;display:flex;flex-direction:column;gap:14px"
          >
            <div>
              <div style="font:600 15px 'Geist',sans-serif;letter-spacing:-.01em">
                Connect an agent
              </div>
              <div style="font:400 12.5px 'Geist',sans-serif;color:var(--text3);margin-top:3px;line-height:1.5">
                An agent is anything that calls the router — a coding harness, a script, an app. It
                gets its own key so you can track and limit it.
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <div>
                <div class="field-label">Agent name</div>
                <input
                  class="input"
                  value={ob().name}
                  placeholder="my-agent"
                  onInput={(e) => setState('ob', 'name', e.currentTarget.value)}
                />
              </div>
              <div>
                <div class="field-label">Platform</div>
                <HarnessSelect
                  value={ob().harness}
                  onChange={(h) => setState('ob', 'harness', h)}
                />
              </div>
            </div>
            <Show when={ob().error1}>
              <div style="font:400 11px 'Geist',sans-serif;color:var(--red)">{ob().error1}</div>
            </Show>
            <Show when={!ob().key}>
              <div
                class="btn-primary"
                style="align-self:flex-start;padding:8px 16px"
                onClick={() => void app.obCreateAgent()}
              >
                {ob().busy1 ? 'Minting…' : 'Create agent & mint key'}
              </div>
            </Show>
            <Show when={ob().key}>
              <div style="display:flex;flex-direction:column;gap:10px">
                <div style="display:flex;align-items:center;gap:10px;padding:10px 13px;background:var(--amber-bg);border-radius:8px">
                  <span
                    class="mono"
                    style="font:500 12px 'Geist Mono',monospace;color:var(--text);word-break:break-all"
                  >
                    {ob().key}
                  </span>
                  <span
                    class="link-accent"
                    style="margin-left:auto;flex:none;font:500 11.5px 'Geist',sans-serif"
                    onClick={() => app.copy(ob().key, 'Key copied')}
                  >
                    Copy
                  </span>
                </div>
                <div style="font:400 11px 'Geist',sans-serif;color:var(--amber)">
                  Shown once — we store only a hash.
                </div>
                <div class="snippet-box">{ob().snippet}</div>
                <div
                  class="btn-primary"
                  style="align-self:flex-start;padding:8px 16px"
                  onClick={() => app.obGo(2)}
                >
                  Next: connect a provider →
                </div>
              </div>
            </Show>
          </div>
        </Show>

        {/* Step 2 — connect a provider, sync, assign the first model to `default` */}
        <Show when={ob().step === 2}>
          <div
            class="panel"
            style="border-radius:12px;padding:22px 24px;display:flex;flex-direction:column;gap:14px"
          >
            <div>
              <div style="font:600 15px 'Geist',sans-serif;letter-spacing:-.01em">
                Connect a provider
              </div>
              <div style="font:400 12.5px 'Geist',sans-serif;color:var(--text3);margin-top:3px;line-height:1.5">
                Bring what you already pay for. polyrouter never marks up tokens — you pay providers
                directly. We’ll sync its models and assign the first to your{' '}
                <span class="mono" style="font-size:11.5px">
                  default
                </span>{' '}
                tier.
              </div>
            </div>
            <div>
              <div class="field-label">Name</div>
              <input
                class="input"
                value={ob().prov.name}
                placeholder="e.g. OpenAI, mylab-endpoint"
                onInput={(e) => setState('ob', 'prov', 'name', e.currentTarget.value)}
              />
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <For each={PROVIDER_KINDS}>
                {(k) => (
                  <div
                    class="kind-card"
                    style={{
                      padding: '14px 15px',
                      border: `1px solid ${ob().prov.kind === k.id ? 'var(--accent)' : 'var(--border)'}`,
                      background: ob().prov.kind === k.id ? 'var(--accent-bg)' : 'var(--bg)',
                      'border-radius': '10px',
                      cursor: 'pointer',
                      display: 'flex',
                      'flex-direction': 'column',
                      gap: '4px',
                    }}
                    onClick={() => setState('ob', 'prov', 'kind', k.id)}
                  >
                    <div style="font:500 13px 'Geist',sans-serif;color:var(--text)">{k.name}</div>
                    <div style="font:400 11.5px 'Geist',sans-serif;color:var(--text3);line-height:1.45">
                      {k.desc}
                    </div>
                  </div>
                )}
              </For>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <div class="field-label">Protocol</div>
                <select
                  class="select"
                  value={ob().prov.protocol}
                  onChange={(e) =>
                    setState(
                      'ob',
                      'prov',
                      'protocol',
                      e.currentTarget.value as 'openai_compatible' | 'anthropic_compatible',
                    )
                  }
                >
                  <option value="openai_compatible">OpenAI-compatible</option>
                  <option value="anthropic_compatible">Anthropic-compatible</option>
                </select>
              </div>
              <div>
                <div class="field-label">Base URL</div>
                <input
                  class="input mono"
                  style="font:400 12px 'Geist Mono',monospace"
                  value={ob().prov.baseUrl}
                  placeholder={
                    ob().prov.kind === 'local'
                      ? 'http://127.0.0.1:11434/v1'
                      : 'https://api.provider.com/v1'
                  }
                  onInput={(e) => setState('ob', 'prov', 'baseUrl', e.currentTarget.value)}
                />
              </div>
            </div>
            <div>
              <div class="field-label">
                Credential{ob().prov.kind === 'local' ? ' (optional)' : ''}
              </div>
              <input
                class="input mono"
                style="font:400 12px 'Geist Mono',monospace"
                type="password"
                value={ob().prov.credential}
                placeholder="sk-…"
                onInput={(e) => setState('ob', 'prov', 'credential', e.currentTarget.value)}
              />
            </div>
            <Show when={ob().error2}>
              <div style="font:400 11px 'Geist',sans-serif;color:var(--red)">{ob().error2}</div>
            </Show>
            <Show when={!ob().done2}>
              <div
                class="btn-primary"
                style="align-self:flex-start;padding:8px 16px"
                onClick={() => void app.obConnectProvider()}
              >
                {ob().busy2 ? 'Connecting & syncing…' : 'Connect provider & sync models'}
              </div>
            </Show>
            <Show when={ob().done2}>
              <div style="display:flex;align-items:center;gap:10px;padding:11px 13px;background:var(--green-bg);border-radius:8px;font:400 12px 'Geist',sans-serif;color:var(--text2)">
                <span style="width:7px;height:7px;border-radius:50%;background:var(--green)" />
                Synced —{' '}
                <span class="mono" style="font-size:11.5px">
                  {ob().assignedModel}
                </span>{' '}
                assigned to the default tier.
              </div>
              <div
                class="btn-primary"
                style="align-self:flex-start;padding:8px 16px"
                onClick={() => app.obGo(3)}
              >
                Next: verify →
              </div>
            </Show>
          </div>
        </Show>

        {/* Step 3 — verify a real `auto` completion through the proxy */}
        <Show when={ob().step === 3}>
          <div
            class="panel"
            style="border-radius:12px;padding:22px 24px;display:flex;flex-direction:column;gap:14px"
          >
            <div>
              <div style="font:600 15px 'Geist',sans-serif;letter-spacing:-.01em">
                Verify routing
              </div>
              <div style="font:400 12.5px 'Geist',sans-serif;color:var(--text3);margin-top:3px;line-height:1.5">
                We’ll send a real{' '}
                <span class="mono" style="font-size:11.5px">
                  model: "auto"
                </span>{' '}
                request through your new key and show the response — the end-to-end proof.
              </div>
            </div>
            <Show when={ob().error3}>
              <div style="font:400 12px 'Geist',sans-serif;color:var(--red);background:var(--red-bg);border-radius:8px;padding:10px 12px;line-height:1.5">
                {ob().error3}
              </div>
            </Show>
            <Show when={ob().verifyReply}>
              <div style="display:flex;flex-direction:column;gap:6px;background:var(--green-bg);border-radius:8px;padding:12px 14px">
                <div style="font:500 11px 'Geist',sans-serif;color:var(--green)">
                  Routed{ob().verifyModel ? ` → ${ob().verifyModel ?? ''}` : ''}
                </div>
                <div style="font:400 12.5px 'Geist',sans-serif;color:var(--text);line-height:1.5;white-space:pre-wrap">
                  {ob().verifyReply}
                </div>
              </div>
            </Show>
            <div style="display:flex;gap:8px">
              <div class="btn-ghost" style="padding:8px 16px" onClick={() => void app.obVerify()}>
                {ob().busy3
                  ? 'Sending…'
                  : ob().verifyReply || ob().error3
                    ? 'Send again'
                    : 'Send test request'}
              </div>
              <div class="btn-primary" style="padding:8px 16px" onClick={() => app.obFinish()}>
                Open dashboard
              </div>
            </div>
            <div style="font:400 11.5px 'Geist',sans-serif;color:var(--text3)">
              Tune tiers, fallback order and auto-layers any time under{' '}
              <span class="link-accent" onClick={() => app.go('routing')}>
                Routing
              </span>
              .
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
