import { For, Show } from 'solid-js';
import { HarnessSelect } from '../components/Modals';
import { catalogEntry, priceOf } from '../data/catalog';
import { app, PROVIDER_KINDS, snippetFor } from '../state/appState';
import { posStyle } from './Routing';

export function Setup() {
  const { state, setState } = app;
  const ob = () => state.ob;
  const steps = () =>
    (
      [
        ['Agent', 1],
        ['Provider', 2],
        ['Routing', 3],
      ] as const
    ).map(([label, n], i) => {
      const done = (n === 1 && ob().done1) || (n === 2 && ob().done2);
      const active = ob().step === n;
      return { n, label, i, done, active };
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
            <Show when={!ob().key}>
              <div
                class="btn-primary"
                style="align-self:flex-start;padding:8px 16px"
                onClick={() => app.obCreateAgent()}
              >
                Create agent & mint key
              </div>
            </Show>
            <Show when={ob().key}>
              <div style="display:flex;flex-direction:column;gap:10px">
                <div style="display:flex;align-items:center;gap:10px;padding:10px 13px;background:var(--amber-bg);border-radius:8px">
                  <span class="mono" style="font:500 12px 'Geist Mono',monospace;color:var(--text)">
                    {ob().key}
                  </span>
                  <span
                    class="link-accent"
                    style="margin-left:auto;font:500 11.5px 'Geist',sans-serif"
                    onClick={() => app.copy(ob().key, 'Key copied')}
                  >
                    Copy
                  </span>
                </div>
                <div style="font:400 11px 'Geist',sans-serif;color:var(--amber)">
                  Shown once — we store only a hash.
                </div>
                <div class="snippet-box">{snippetFor(ob().harness, ob().key || 'poly_…')}</div>
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
                directly.
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <For each={PROVIDER_KINDS}>
                {(k) => (
                  <div
                    class="kind-card"
                    style={{
                      padding: '14px 15px',
                      border: `1px solid ${ob().provPicked === k.id ? 'var(--accent)' : 'var(--border)'}`,
                      background: ob().provPicked === k.id ? 'var(--accent-bg)' : 'var(--bg)',
                      'border-radius': '10px',
                      cursor: 'pointer',
                      display: 'flex',
                      'flex-direction': 'column',
                      gap: '4px',
                    }}
                    onClick={() => app.obPickProvider(k.id)}
                  >
                    <div style="font:500 13px 'Geist',sans-serif;color:var(--text)">{k.name}</div>
                    <div style="font:400 11.5px 'Geist',sans-serif;color:var(--text3);line-height:1.45">
                      {k.desc}
                    </div>
                  </div>
                )}
              </For>
            </div>
            <Show when={ob().provPicked !== null}>
              <div style="display:flex;align-items:center;gap:10px;padding:11px 13px;background:var(--green-bg);border-radius:8px;font:400 12px 'Geist',sans-serif;color:var(--text2)">
                <span style="width:7px;height:7px;border-radius:50%;background:var(--green)" />
                {ob().provPicked === 'local'
                  ? 'Ollama found at 127.0.0.1:11434 — 5 models, all free'
                  : 'Connected — models & bundled prices synced'}
              </div>
              <div
                class="btn-primary"
                style="align-self:flex-start;padding:8px 16px"
                onClick={() => app.obGo(3)}
              >
                Next: routing →
              </div>
            </Show>
          </div>
        </Show>

        <Show when={ob().step === 3}>
          <div
            class="panel"
            style="border-radius:12px;padding:22px 24px;display:flex;flex-direction:column;gap:14px"
          >
            <div>
              <div style="font:600 15px 'Geist',sans-serif;letter-spacing:-.01em">
                Routing is ready
              </div>
              <div style="font:400 12.5px 'Geist',sans-serif;color:var(--text3);margin-top:3px;line-height:1.5">
                Name a model and it's honored. Send{' '}
                <span
                  class="mono"
                  style="font-size:11.5px;background:var(--chip);padding:1px 5px;border-radius:4px"
                >
                  auto
                </span>{' '}
                and the default tier below serves it — cheapest first, with fallbacks.
              </div>
            </div>
            <div style="border:1px solid var(--border2);border-radius:9px;overflow:hidden">
              <For each={state.tiers[0]?.chain ?? []}>
                {(model, i) => {
                  const c = catalogEntry(model);
                  return (
                    <div style="display:flex;align-items:center;gap:12px;padding:9px 14px;border-bottom:1px solid var(--border2);background:var(--bg)">
                      <span
                        class="pos-badge"
                        style={{ background: posStyle(i())[1], color: posStyle(i())[2] }}
                      >
                        {posStyle(i())[0]}
                      </span>
                      <span
                        class="mono"
                        style="font:500 12px 'Geist Mono',monospace;color:var(--text)"
                      >
                        {model}
                      </span>
                      <span style="font:400 11.5px 'Geist',sans-serif;color:var(--text3)">
                        {c.p}
                        {c.tag !== null ? ` · ${c.tag}` : ''}
                      </span>
                      <span
                        class="mono"
                        style={{
                          'margin-left': 'auto',
                          font: "400 11px 'Geist Mono',monospace",
                          color: c.tag === 'local' ? 'var(--green)' : 'var(--text3)',
                        }}
                      >
                        {priceOf(model)}
                      </span>
                    </div>
                  );
                }}
              </For>
            </div>
            <div style="font:400 11.5px 'Geist',sans-serif;color:var(--text3)">
              Tune tiers, fallback order and auto-layers any time under{' '}
              <span class="link-accent" onClick={() => app.go('routing')}>
                Routing
              </span>
              .
            </div>
            <div
              class="btn-primary"
              style="align-self:flex-start;padding:8px 16px"
              onClick={() => app.obFinish()}
            >
              Open dashboard
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
