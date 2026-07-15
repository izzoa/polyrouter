import { HARNESS_LABELS, HARNESS_TYPES } from '@polyrouter/shared';
import { For, Show } from 'solid-js';
import { app, PROVIDER_KINDS, snippetFor } from '../state/appState';
import type { Harness } from '../types';

export function HarnessSelect(props: { value: Harness; onChange: (h: Harness) => void }) {
  return (
    <select
      class="select"
      value={props.value}
      onChange={(e) => props.onChange(e.currentTarget.value as Harness)}
    >
      <For each={HARNESS_TYPES}>{(v) => <option value={v}>{HARNESS_LABELS[v]}</option>}</For>
    </select>
  );
}

export function Modals() {
  const { state, setState } = app;
  const npKind = () => PROVIDER_KINDS.find((k) => k.id === state.np.kind);

  return (
    <Show when={state.modal}>
      <div class="modal-backdrop" onClick={() => app.closeModal()}>
        <div class="modal-card" onClick={(e) => e.stopPropagation()}>
          <Show when={state.modal === 'newAgent'}>
            <div class="modal-title">New agent</div>
            <div>
              <div class="field-label">Name</div>
              <input
                class="input"
                value={state.na.name}
                placeholder="e.g. openclaw"
                onInput={(e) => setState('na', 'name', e.currentTarget.value)}
              />
            </div>
            <div>
              <div class="field-label">Platform</div>
              <HarnessSelect
                value={state.na.harness}
                onChange={(h) => setState('na', 'harness', h)}
              />
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end">
              <div class="btn-cancel" onClick={() => app.closeModal()}>
                Cancel
              </div>
              <div class="btn-primary" onClick={() => app.createAgent()}>
                Create & mint key
              </div>
            </div>
          </Show>

          <Show when={state.modal === 'keyReveal'}>
            <div class="modal-title">{state.kr.title}</div>
            <div style="display:flex;align-items:center;gap:10px;padding:10px 13px;background:var(--amber-bg);border-radius:8px">
              <span
                class="mono"
                style="font:500 12px 'Geist Mono',monospace;color:var(--text);word-break:break-all"
              >
                {state.kr.key}
              </span>
              <span
                class="link-accent"
                style="margin-left:auto;flex:none;font:500 11.5px 'Geist',sans-serif"
                onClick={() => app.copy(state.kr.key, 'Key copied')}
              >
                Copy
              </span>
            </div>
            <div style="font:400 11px 'Geist',sans-serif;color:var(--amber)">
              Shown once — only an HMAC hash is stored. The old key stops working immediately.
            </div>
            <div class="snippet-box">{snippetFor(state.kr.harness, state.kr.key)}</div>
            <div style="display:flex;justify-content:flex-end">
              <div class="btn-primary" onClick={() => app.closeModal()}>
                Done
              </div>
            </div>
          </Show>

          <Show when={state.modal === 'newProvider'}>
            <div class="modal-title">Add provider</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <For each={PROVIDER_KINDS}>
                {(k) => (
                  <div
                    class="kind-card"
                    style={{
                      padding: '12px 14px',
                      border: `1px solid ${state.np.kind === k.id ? 'var(--accent)' : 'var(--border)'}`,
                      background: state.np.kind === k.id ? 'var(--accent-bg)' : 'var(--bg)',
                      'border-radius': '10px',
                      cursor: 'pointer',
                    }}
                    onClick={() => app.pickProviderKind(k.id)}
                  >
                    <div style="font:500 12.5px 'Geist',sans-serif;color:var(--text)">{k.name}</div>
                    <div style="font:400 11px 'Geist',sans-serif;color:var(--text3);line-height:1.45;margin-top:3px">
                      {k.desc}
                    </div>
                  </div>
                )}
              </For>
            </div>
            <Show when={npKind()}>
              {(kind) => (
                <div style="display:flex;flex-direction:column;gap:10px">
                  <div>
                    <div class="field-label">{kind().field}</div>
                    <input
                      class="input mono"
                      style="font:400 12px 'Geist Mono',monospace"
                      value={state.np.value}
                      placeholder={kind().ph}
                      onInput={(e) => app.setNpValue(e.currentTarget.value)}
                    />
                  </div>
                  <div style="display:flex;align-items:center;gap:10px">
                    <div
                      class="btn-ghost"
                      style="padding:6px 13px;font:500 12px 'Geist',sans-serif;border-radius:7px"
                      onClick={() => app.testProvider()}
                    >
                      Test connection
                    </div>
                    <span
                      style={{
                        font: "400 11.5px 'Geist',sans-serif",
                        color: state.np.test === 'ok' ? 'var(--green)' : 'var(--text3)',
                      }}
                    >
                      {state.np.test === 'testing'
                        ? 'Testing…'
                        : state.np.test === 'ok'
                          ? '✓ Reachable — 12 models found'
                          : ''}
                    </span>
                  </div>
                  <div style="font:400 10.5px 'Geist',sans-serif;color:var(--faint);line-height:1.5">
                    Custom base URLs are SSRF-checked — private and metadata ranges are rejected.
                    Credentials are encrypted at rest.
                  </div>
                </div>
              )}
            </Show>
            <div style="display:flex;gap:8px;justify-content:flex-end">
              <div class="btn-cancel" onClick={() => app.closeModal()}>
                Cancel
              </div>
              <div
                style={{
                  padding: '7px 14px',
                  background: state.np.test === 'ok' ? 'var(--accent)' : 'var(--faint)',
                  color: '#fff',
                  'border-radius': '7px',
                  font: "500 12.5px 'Geist',sans-serif",
                  cursor: state.np.test === 'ok' ? 'pointer' : 'not-allowed',
                }}
                onClick={() => app.addProvider()}
              >
                Add provider
              </div>
            </div>
          </Show>

          <Show when={state.modal === 'newLimit'}>
            <div class="modal-title">New budget</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <div>
                <div class="field-label">Scope</div>
                <select
                  class="select"
                  value={state.nl.scope}
                  onChange={(e) => setState('nl', 'scope', e.currentTarget.value)}
                >
                  <option value="Global">Global</option>
                  <For each={state.agents}>
                    {(a) => <option value={`Agent · ${a.name}`}>{`Agent · ${a.name}`}</option>}
                  </For>
                </select>
              </div>
              <div>
                <div class="field-label">Amount (USD)</div>
                <input
                  class="input mono"
                  style="font:400 12.5px 'Geist Mono',monospace"
                  value={state.nl.amount}
                  placeholder="10.00"
                  onInput={(e) => setState('nl', 'amount', e.currentTarget.value)}
                />
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <div>
                <div class="field-label">Window</div>
                <select
                  class="select"
                  value={state.nl.window}
                  onChange={(e) =>
                    setState('nl', 'window', e.currentTarget.value as 'day' | 'week' | 'month')
                  }
                >
                  <option value="day">Per day</option>
                  <option value="week">Per week</option>
                  <option value="month">Per month</option>
                </select>
              </div>
              <div>
                <div class="field-label">At the threshold</div>
                <div style="display:flex;background:var(--bg);border:1px solid var(--border);border-radius:7px;padding:2px">
                  <div
                    style={{
                      flex: '1',
                      'text-align': 'center',
                      padding: '5px 0',
                      'border-radius': '5px',
                      font: "500 12px 'Geist',sans-serif",
                      cursor: 'pointer',
                      background: state.nl.action === 'alert' ? 'var(--chip)' : 'transparent',
                      color: state.nl.action === 'alert' ? 'var(--text)' : 'var(--text3)',
                    }}
                    onClick={() => setState('nl', 'action', 'alert')}
                  >
                    Alert
                  </div>
                  <div
                    style={{
                      flex: '1',
                      'text-align': 'center',
                      padding: '5px 0',
                      'border-radius': '5px',
                      font: "500 12px 'Geist',sans-serif",
                      cursor: 'pointer',
                      background: state.nl.action === 'block' ? 'var(--red-bg)' : 'transparent',
                      color: state.nl.action === 'block' ? 'var(--red)' : 'var(--text3)',
                    }}
                    onClick={() => setState('nl', 'action', 'block')}
                  >
                    Block
                  </div>
                </div>
              </div>
            </div>
            <div style="font:400 11px 'Geist',sans-serif;color:var(--text3);line-height:1.5">
              Alert notifies your channels and keeps serving. Block rejects new requests for this
              scope until the window resets.
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end">
              <div class="btn-cancel" onClick={() => app.closeModal()}>
                Cancel
              </div>
              <div class="btn-primary" onClick={() => app.createLimit()}>
                Create budget
              </div>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
