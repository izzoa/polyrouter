import { HARNESS_LABELS, HARNESS_TYPES } from '@polyrouter/shared';
import { For, Show } from 'solid-js';
import {
  EVENT_TYPES,
  type BudgetScope,
  type BudgetWindow,
  type ChannelKind,
  type EventType,
  type SmtpSecure,
} from '../data/api';
import { PROVIDER_KINDS } from '../state/appState';
import { useApp } from '../state/context';
import type { Harness } from '../types';

/** Friendly labels for the event-subscription checkboxes (#20 channel modal). */
const EVENT_LABELS: Record<EventType, string> = {
  budget_alert: 'Budget alert',
  budget_block: 'Budget block',
  provider_down: 'Provider down',
  request_failures_spike: 'Request failure spike',
  weekly_spend_summary: 'Weekly spend summary',
  test: 'Test',
};

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
  const app = useApp();
  const { state, setState } = app;
  const npKind = () => PROVIDER_KINDS.find((k) => k.id === state.np.kind);

  const toggleNotifyChannel = (id: string): void =>
    setState('bf', 'notifyChannelIds', (ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
    );
  const toggleEvent = (ev: EventType): void =>
    setState('cf', 'events', (evs) =>
      evs.includes(ev) ? evs.filter((x) => x !== ev) : [...evs, ev],
    );

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
            <Show when={state.na.error}>
              <div style="font:400 11px 'Geist',sans-serif;color:var(--red)">{state.na.error}</div>
            </Show>
            <div style="display:flex;gap:8px;justify-content:flex-end">
              <div class="btn-cancel" onClick={() => app.closeModal()}>
                Cancel
              </div>
              <div class="btn-primary" onClick={() => void app.createAgent()}>
                {state.na.busy ? 'Minting…' : 'Create & mint key'}
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
            <div class="snippet-box">{state.kr.snippet}</div>
            <div style="display:flex;justify-content:flex-end">
              <div class="btn-primary" onClick={() => app.closeModal()}>
                Done
              </div>
            </div>
          </Show>

          <Show when={state.modal === 'newProvider'}>
            <div class="modal-title">Add provider</div>
            <div>
              <div class="field-label">Name</div>
              <input
                class="input"
                value={state.np.name}
                placeholder="e.g. OpenAI, mylab-endpoint"
                onInput={(e) => setState('np', 'name', e.currentTarget.value)}
              />
            </div>
            <div>
              <div class="field-label">Kind</div>
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
                      onClick={() => setState('np', 'kind', k.id)}
                    >
                      <div style="font:500 12.5px 'Geist',sans-serif;color:var(--text)">
                        {k.name}
                      </div>
                      <div style="font:400 11px 'Geist',sans-serif;color:var(--text3);line-height:1.45;margin-top:3px">
                        {k.desc}
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <div class="field-label">Protocol</div>
                <select
                  class="select"
                  value={state.np.protocol}
                  onChange={(e) =>
                    setState(
                      'np',
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
                  value={state.np.baseUrl}
                  placeholder={
                    npKind()?.id === 'local'
                      ? 'http://127.0.0.1:11434/v1'
                      : 'https://api.provider.com/v1'
                  }
                  onInput={(e) => setState('np', 'baseUrl', e.currentTarget.value)}
                />
              </div>
            </div>
            <div>
              <div class="field-label">
                {npKind()?.field ?? 'Credential'}
                {state.np.kind === 'local' ? ' (optional)' : ''}
              </div>
              <input
                class="input mono"
                style="font:400 12px 'Geist Mono',monospace"
                type="password"
                value={state.np.credential}
                placeholder={npKind()?.ph ?? ''}
                onInput={(e) => setState('np', 'credential', e.currentTarget.value)}
              />
            </div>
            <Show when={state.np.kind === 'sub'}>
              <div style="font:400 10.5px 'Geist',sans-serif;color:var(--amber);line-height:1.5">
                Reusing a flat-rate subscription programmatically may violate the provider’s ToS —
                pair it with a pay-per-token fallback.
              </div>
            </Show>
            <div style="font:400 10.5px 'Geist',sans-serif;color:var(--faint);line-height:1.5">
              Custom base URLs are SSRF-checked — private and metadata ranges are rejected.
              Credentials are encrypted at rest.
            </div>
            <Show when={state.np.error}>
              <div style="font:400 11px 'Geist',sans-serif;color:var(--red)">{state.np.error}</div>
            </Show>
            <div style="display:flex;gap:8px;justify-content:flex-end">
              <div class="btn-cancel" onClick={() => app.closeModal()}>
                Cancel
              </div>
              <div class="btn-primary" onClick={() => void app.addProvider()}>
                {state.np.busy ? 'Adding…' : 'Add provider'}
              </div>
            </div>
          </Show>

          <Show when={state.modal === 'newLimit'}>
            <div class="modal-title">{state.bf.id ? 'Edit budget' : 'New budget'}</div>
            <div>
              <div class="field-label">Name</div>
              <input
                class="input"
                value={state.bf.name}
                placeholder="e.g. monthly cap"
                onInput={(e) => setState('bf', 'name', e.currentTarget.value)}
              />
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <div>
                <div class="field-label">Scope</div>
                <select
                  class="select"
                  value={state.bf.scope}
                  onChange={(e) => setState('bf', 'scope', e.currentTarget.value as BudgetScope)}
                >
                  <option value="global">Global</option>
                  <option value="agent">Agent</option>
                </select>
              </div>
              <div>
                <div class="field-label">Amount (USD)</div>
                <input
                  class="input mono"
                  style="font:400 12.5px 'Geist Mono',monospace"
                  value={state.bf.amount}
                  placeholder="10.00"
                  onInput={(e) => setState('bf', 'amount', e.currentTarget.value)}
                />
              </div>
            </div>
            <Show when={state.bf.scope === 'agent'}>
              <div>
                <div class="field-label">Agent</div>
                <select
                  class="select"
                  value={state.bf.agentId}
                  onChange={(e) => setState('bf', 'agentId', e.currentTarget.value)}
                >
                  <option value="" disabled selected={state.bf.agentId === ''}>
                    Pick an agent…
                  </option>
                  <For each={state.agents}>{(a) => <option value={a.id}>{a.name}</option>}</For>
                </select>
              </div>
            </Show>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <div>
                <div class="field-label">Window</div>
                <select
                  class="select"
                  value={state.bf.window}
                  onChange={(e) => setState('bf', 'window', e.currentTarget.value as BudgetWindow)}
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
                      background: state.bf.action === 'alert' ? 'var(--chip)' : 'transparent',
                      color: state.bf.action === 'alert' ? 'var(--text)' : 'var(--text3)',
                    }}
                    onClick={() => setState('bf', 'action', 'alert')}
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
                      background: state.bf.action === 'block' ? 'var(--red-bg)' : 'transparent',
                      color: state.bf.action === 'block' ? 'var(--red)' : 'var(--text3)',
                    }}
                    onClick={() => setState('bf', 'action', 'block')}
                  >
                    Block
                  </div>
                </div>
              </div>
            </div>
            <div>
              <div class="field-label">Notify channels</div>
              <Show
                when={state.channels.length > 0}
                fallback={
                  <div style="font:400 11px 'Geist',sans-serif;color:var(--faint)">
                    No channels yet — add one under Settings → Notifications.
                  </div>
                }
              >
                <div style="display:flex;flex-wrap:wrap;gap:8px">
                  <For each={state.channels}>
                    {(c) => (
                      <label style="display:flex;align-items:center;gap:6px;font:400 11.5px 'Geist',sans-serif;color:var(--text2)">
                        <input
                          type="checkbox"
                          checked={state.bf.notifyChannelIds.includes(c.id)}
                          onChange={() => toggleNotifyChannel(c.id)}
                        />
                        {c.name}
                      </label>
                    )}
                  </For>
                </div>
              </Show>
            </div>
            <label style="display:flex;align-items:center;gap:8px;font:400 12px 'Geist',sans-serif;color:var(--text2)">
              <input
                type="checkbox"
                checked={state.bf.enabled}
                onChange={(e) => setState('bf', 'enabled', e.currentTarget.checked)}
              />
              Enabled
            </label>
            <div style="font:400 11px 'Geist',sans-serif;color:var(--text3);line-height:1.5">
              Alert notifies your channels and keeps serving. Block rejects new requests for this
              scope until the window resets.
            </div>
            <Show when={state.bf.error}>
              <div style="font:400 11px 'Geist',sans-serif;color:var(--red)">{state.bf.error}</div>
            </Show>
            <div style="display:flex;gap:8px;justify-content:flex-end">
              <div
                class="btn-cancel"
                style={{
                  'pointer-events': state.bf.busy ? 'none' : 'auto',
                  opacity: state.bf.busy ? '0.6' : '1',
                }}
                onClick={() => app.closeModal()}
              >
                Cancel
              </div>
              <div
                class="btn-primary"
                style={{
                  'pointer-events': state.bf.busy ? 'none' : 'auto',
                  opacity: state.bf.busy ? '0.6' : '1',
                }}
                onClick={() => void app.saveBudget()}
              >
                {state.bf.busy ? 'Saving…' : state.bf.id ? 'Save budget' : 'Create budget'}
              </div>
            </div>
          </Show>

          <Show when={state.modal === 'channel'}>
            <div class="modal-title">{state.cf.id ? 'Edit channel' : 'Add channel'}</div>
            <div style="display:grid;grid-template-columns:2fr 1fr;gap:12px">
              <div>
                <div class="field-label">Name</div>
                <input
                  class="input"
                  value={state.cf.name}
                  placeholder="e.g. homelab email"
                  onInput={(e) => setState('cf', 'name', e.currentTarget.value)}
                />
              </div>
              <div>
                <div class="field-label">Kind</div>
                <select
                  class="select"
                  value={state.cf.kind}
                  onChange={(e) => setState('cf', 'kind', e.currentTarget.value as ChannelKind)}
                >
                  <option value="smtp">SMTP</option>
                  <option value="apprise">Apprise</option>
                </select>
              </div>
            </div>

            <div>
              <div class="field-label">Subscribed events</div>
              <div style="display:flex;flex-wrap:wrap;gap:8px">
                <For each={EVENT_TYPES}>
                  {(ev) => (
                    <label style="display:flex;align-items:center;gap:6px;font:400 11.5px 'Geist',sans-serif;color:var(--text2)">
                      <input
                        type="checkbox"
                        checked={state.cf.events.includes(ev)}
                        onChange={() => toggleEvent(ev)}
                      />
                      {EVENT_LABELS[ev]}
                    </label>
                  )}
                </For>
              </div>
            </div>

            <Show when={state.cf.id !== null}>
              <div style="font:400 10.5px 'Geist',sans-serif;color:var(--faint);line-height:1.5">
                Config is write-only — leave the fields below blank to keep the stored secret
                unchanged.
              </div>
            </Show>

            <Show when={state.cf.kind === 'smtp'}>
              <div style="display:grid;grid-template-columns:2fr 1fr;gap:12px">
                <div>
                  <div class="field-label">Host</div>
                  <input
                    class="input mono"
                    style="font:400 12px 'Geist Mono',monospace"
                    value={state.cf.smtpHost}
                    placeholder="smtp.fastmail.com"
                    onInput={(e) => setState('cf', 'smtpHost', e.currentTarget.value)}
                  />
                </div>
                <div>
                  <div class="field-label">Port</div>
                  <input
                    class="input mono"
                    style="font:400 12px 'Geist Mono',monospace"
                    value={state.cf.smtpPort}
                    placeholder="587"
                    onInput={(e) => setState('cf', 'smtpPort', e.currentTarget.value)}
                  />
                </div>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                <div>
                  <div class="field-label">Security</div>
                  <select
                    class="select"
                    value={state.cf.smtpSecure}
                    onChange={(e) =>
                      setState('cf', 'smtpSecure', e.currentTarget.value as SmtpSecure)
                    }
                  >
                    <option value="none">None</option>
                    <option value="starttls">STARTTLS</option>
                    <option value="tls">TLS</option>
                  </select>
                </div>
                <div>
                  <div class="field-label">From</div>
                  <input
                    class="input mono"
                    style="font:400 12px 'Geist Mono',monospace"
                    value={state.cf.smtpFrom}
                    placeholder="alerts@my.box"
                    onInput={(e) => setState('cf', 'smtpFrom', e.currentTarget.value)}
                  />
                </div>
              </div>
              <div>
                <div class="field-label">Recipients (comma or space separated)</div>
                <input
                  class="input mono"
                  style="font:400 12px 'Geist Mono',monospace"
                  value={state.cf.smtpTo}
                  placeholder="admin@my.box"
                  onInput={(e) => setState('cf', 'smtpTo', e.currentTarget.value)}
                />
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                <div>
                  <div class="field-label">User (optional)</div>
                  <input
                    class="input mono"
                    style="font:400 12px 'Geist Mono',monospace"
                    value={state.cf.smtpUser}
                    onInput={(e) => setState('cf', 'smtpUser', e.currentTarget.value)}
                  />
                </div>
                <div>
                  <div class="field-label">Password (optional)</div>
                  <input
                    class="input mono"
                    style="font:400 12px 'Geist Mono',monospace"
                    type="password"
                    value={state.cf.smtpPass}
                    onInput={(e) => setState('cf', 'smtpPass', e.currentTarget.value)}
                  />
                </div>
              </div>
            </Show>

            <Show when={state.cf.kind === 'apprise'}>
              <div>
                <div class="field-label">Apprise URLs (one per line)</div>
                <textarea
                  class="input mono"
                  style="font:400 12px 'Geist Mono',monospace;min-height:70px;resize:vertical"
                  value={state.cf.appriseUrls}
                  placeholder="ntfy://homelab/polyrouter"
                  onInput={(e) => setState('cf', 'appriseUrls', e.currentTarget.value)}
                />
              </div>
            </Show>

            <div style="font:400 10.5px 'Geist',sans-serif;color:var(--faint);line-height:1.5">
              Targets are SSRF-checked and the config is encrypted at rest — it’s never shown back.
            </div>
            <Show when={state.cf.error}>
              <div style="font:400 11px 'Geist',sans-serif;color:var(--red)">{state.cf.error}</div>
            </Show>
            <div style="display:flex;gap:8px;justify-content:flex-end">
              <div
                class="btn-cancel"
                style={{
                  'pointer-events': state.cf.busy ? 'none' : 'auto',
                  opacity: state.cf.busy ? '0.6' : '1',
                }}
                onClick={() => app.closeModal()}
              >
                Cancel
              </div>
              <div
                class="btn-primary"
                style={{
                  'pointer-events': state.cf.busy ? 'none' : 'auto',
                  opacity: state.cf.busy ? '0.6' : '1',
                }}
                onClick={() => void app.saveChannel()}
              >
                {state.cf.busy ? 'Saving…' : state.cf.id ? 'Save channel' : 'Add channel'}
              </div>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
