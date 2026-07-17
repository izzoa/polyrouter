import { HARNESS_LABELS, HARNESS_TYPES } from '@polyrouter/shared';
import { createEffect, For, on, onCleanup, onMount, Show } from 'solid-js';
import { dialogKeyboard } from '../a11y';
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

export function HarnessSelect(props: {
  value: Harness;
  onChange: (h: Harness) => void;
  id?: string;
}) {
  return (
    <select
      class="select"
      id={props.id}
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
      {(_kind) => {
        let cardEl: HTMLDivElement | undefined;
        onMount(() => {
          const dispose = dialogKeyboard({
            root: () => cardEl,
            onClose: () => app.closeModal(),
          });
          onCleanup(dispose);
        });
        // A kind switch (e.g. newAgent → keyReveal) keeps this branch mounted but unmounts
        // the focused control; refocus the card so keyboard/SR users aren't dropped on body.
        createEffect(
          on(
            () => state.modal,
            () => cardEl?.focus(),
            { defer: true },
          ),
        );
        return (
          // eslint-disable-next-line a11y-guard/no-noninteractive-click -- pointer-only backdrop redundancy; Escape is the keyboard path
          <div
            class="modal-backdrop"
            onClick={(e) => {
              if (e.target === e.currentTarget) app.closeModal();
            }}
          >
            <div
              class="modal-card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="modal-title"
              tabindex="-1"
              ref={(el) => {
                cardEl = el;
              }}
            >
              <Show when={state.modal === 'newAgent'}>
                <div class="modal-title" id="modal-title">
                  New agent
                </div>
                <div>
                  <label class="field-label" for="f-na-name" style="display:block">
                    Name
                  </label>
                  <input
                    class="input"
                    id="f-na-name"
                    value={state.na.name}
                    placeholder="e.g. openclaw"
                    onInput={(e) => setState('na', 'name', e.currentTarget.value)}
                  />
                </div>
                <div>
                  <label class="field-label" for="f-na-harness" style="display:block">
                    Platform
                  </label>
                  <HarnessSelect
                    id="f-na-harness"
                    value={state.na.harness}
                    onChange={(h) => setState('na', 'harness', h)}
                  />
                </div>
                <Show when={state.na.error}>
                  <div style="font:400 11px 'Geist',sans-serif;color:var(--red)">
                    {state.na.error}
                  </div>
                </Show>
                <div style="display:flex;gap:8px;justify-content:flex-end">
                  <button type="button" class="btn-cancel" onClick={() => app.closeModal()}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    class="btn-primary"
                    disabled={state.na.busy}
                    onClick={() => void app.createAgent()}
                  >
                    {state.na.busy ? 'Minting…' : 'Create & mint key'}
                  </button>
                </div>
              </Show>

              <Show when={state.modal === 'keyReveal'}>
                <div class="modal-title" id="modal-title">
                  {state.kr.title}
                </div>
                <div style="display:flex;align-items:center;gap:10px;padding:10px 13px;background:var(--amber-bg);border-radius:8px">
                  <span
                    class="mono"
                    style="font:500 12px 'Geist Mono',monospace;color:var(--text);word-break:break-all"
                  >
                    {state.kr.key}
                  </span>
                  <button
                    type="button"
                    class="link-accent"
                    style="margin-left:auto;flex:none;font:500 11.5px 'Geist',sans-serif"
                    onClick={() => app.copy(state.kr.key, 'Key copied')}
                  >
                    Copy
                  </button>
                </div>
                <div style="font:400 11px 'Geist',sans-serif;color:var(--amber)">
                  Shown once — only an HMAC hash is stored. The old key stops working immediately.
                </div>
                <div class="snippet-box">{state.kr.snippet}</div>
                <div style="display:flex;justify-content:flex-end">
                  <button type="button" class="btn-primary" onClick={() => app.closeModal()}>
                    Done
                  </button>
                </div>
              </Show>

              <Show when={state.modal === 'newProvider'}>
                <div class="modal-title" id="modal-title">
                  Add provider
                </div>
                <div>
                  <label class="field-label" for="f-np-name" style="display:block">
                    Name
                  </label>
                  <input
                    class="input"
                    id="f-np-name"
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
                        <button
                          type="button"
                          class="kind-card"
                          aria-pressed={state.np.kind === k.id}
                          style={{
                            padding: '12px 14px',
                            border: `1px solid ${state.np.kind === k.id ? 'var(--accent)' : 'var(--border)'}`,
                            background: state.np.kind === k.id ? 'var(--accent-bg)' : 'var(--bg)',
                            'border-radius': '10px',
                            cursor: 'pointer',
                          }}
                          onClick={() => setState('np', 'kind', k.id)}
                        >
                          <span style="display:block;font:500 12.5px 'Geist',sans-serif;color:var(--text)">
                            {k.name}
                          </span>
                          <span style="display:block;font:400 11px 'Geist',sans-serif;color:var(--text3);line-height:1.45;margin-top:3px">
                            {k.desc}
                          </span>
                        </button>
                      )}
                    </For>
                  </div>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                  <div>
                    <label class="field-label" for="f-np-protocol" style="display:block">
                      Protocol
                    </label>
                    <select
                      class="select"
                      id="f-np-protocol"
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
                    <label class="field-label" for="f-np-baseurl" style="display:block">
                      Base URL
                    </label>
                    <input
                      class="input mono"
                      id="f-np-baseurl"
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
                  <label class="field-label" for="f-np-credential" style="display:block">
                    {npKind()?.field ?? 'Credential'}
                    {state.np.kind === 'local' ? ' (optional)' : ''}
                  </label>
                  <input
                    class="input mono"
                    id="f-np-credential"
                    style="font:400 12px 'Geist Mono',monospace"
                    type="password"
                    value={state.np.credential}
                    placeholder={npKind()?.ph ?? ''}
                    onInput={(e) => setState('np', 'credential', e.currentTarget.value)}
                  />
                </div>
                <Show when={state.np.kind === 'sub'}>
                  <div style="font:400 10.5px 'Geist',sans-serif;color:var(--amber);line-height:1.5">
                    Reusing a flat-rate subscription programmatically may violate the provider’s
                    ToS — pair it with a pay-per-token fallback.
                  </div>
                </Show>
                <div style="font:400 10.5px 'Geist',sans-serif;color:var(--text3);line-height:1.5">
                  Custom base URLs are SSRF-checked — private and metadata ranges are rejected.
                  Credentials are encrypted at rest.
                </div>
                <Show when={state.np.error}>
                  <div style="font:400 11px 'Geist',sans-serif;color:var(--red)">
                    {state.np.error}
                  </div>
                </Show>
                <div style="display:flex;gap:8px;justify-content:flex-end">
                  <button type="button" class="btn-cancel" onClick={() => app.closeModal()}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    class="btn-primary"
                    disabled={state.np.busy}
                    onClick={() => void app.addProvider()}
                  >
                    {state.np.busy ? 'Adding…' : 'Add provider'}
                  </button>
                </div>
              </Show>

              <Show when={state.modal === 'newLimit'}>
                <div class="modal-title" id="modal-title">
                  {state.bf.id ? 'Edit budget' : 'New budget'}
                </div>
                <div>
                  <label class="field-label" for="f-bf-name" style="display:block">
                    Name
                  </label>
                  <input
                    class="input"
                    id="f-bf-name"
                    value={state.bf.name}
                    placeholder="e.g. monthly cap"
                    onInput={(e) => setState('bf', 'name', e.currentTarget.value)}
                  />
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                  <div>
                    <label class="field-label" for="f-bf-scope" style="display:block">
                      Scope
                    </label>
                    <select
                      class="select"
                      id="f-bf-scope"
                      value={state.bf.scope}
                      onChange={(e) => setState('bf', 'scope', e.currentTarget.value as BudgetScope)}
                    >
                      <option value="global">Global</option>
                      <option value="agent">Agent</option>
                    </select>
                  </div>
                  <div>
                    <label class="field-label" for="f-bf-amount" style="display:block">
                      Amount (USD)
                    </label>
                    <input
                      class="input mono"
                      id="f-bf-amount"
                      style="font:400 12.5px 'Geist Mono',monospace"
                      value={state.bf.amount}
                      placeholder="10.00"
                      onInput={(e) => setState('bf', 'amount', e.currentTarget.value)}
                    />
                  </div>
                </div>
                <Show when={state.bf.scope === 'agent'}>
                  <div>
                    <label class="field-label" for="f-bf-agent" style="display:block">
                      Agent
                    </label>
                    <select
                      class="select"
                      id="f-bf-agent"
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
                    <label class="field-label" for="f-bf-window" style="display:block">
                      Window
                    </label>
                    <select
                      class="select"
                      id="f-bf-window"
                      value={state.bf.window}
                      onChange={(e) =>
                        setState('bf', 'window', e.currentTarget.value as BudgetWindow)
                      }
                    >
                      <option value="day">Per day</option>
                      <option value="week">Per week</option>
                      <option value="month">Per month</option>
                    </select>
                  </div>
                  <div>
                    <div class="field-label">At the threshold</div>
                    <div
                      role="group"
                      aria-label="At the threshold"
                      style="display:flex;background:var(--bg);border:1px solid var(--border);border-radius:7px;padding:2px"
                    >
                      <button
                        type="button"
                        aria-pressed={state.bf.action === 'alert'}
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
                      </button>
                      <button
                        type="button"
                        aria-pressed={state.bf.action === 'block'}
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
                      </button>
                    </div>
                  </div>
                </div>
                <div>
                  <div class="field-label">Notify channels</div>
                  <Show
                    when={state.channels.length > 0}
                    fallback={
                      <div style="font:400 11px 'Geist',sans-serif;color:var(--text3)">
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
                  Alert notifies your channels and keeps serving. Block rejects new requests for
                  this scope until the window resets.
                </div>
                <Show when={state.bf.error}>
                  <div style="font:400 11px 'Geist',sans-serif;color:var(--red)">
                    {state.bf.error}
                  </div>
                </Show>
                <div style="display:flex;gap:8px;justify-content:flex-end">
                  <button
                    type="button"
                    class="btn-cancel"
                    disabled={state.bf.busy}
                    onClick={() => app.closeModal()}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    class="btn-primary"
                    disabled={state.bf.busy}
                    onClick={() => void app.saveBudget()}
                  >
                    {state.bf.busy ? 'Saving…' : state.bf.id ? 'Save budget' : 'Create budget'}
                  </button>
                </div>
              </Show>

              <Show when={state.modal === 'channel'}>
                <div class="modal-title" id="modal-title">
                  {state.cf.id ? 'Edit channel' : 'Add channel'}
                </div>
                <div style="display:grid;grid-template-columns:2fr 1fr;gap:12px">
                  <div>
                    <label class="field-label" for="f-cf-name" style="display:block">
                      Name
                    </label>
                    <input
                      class="input"
                      id="f-cf-name"
                      value={state.cf.name}
                      placeholder="e.g. homelab email"
                      onInput={(e) => setState('cf', 'name', e.currentTarget.value)}
                    />
                  </div>
                  <div>
                    <label class="field-label" for="f-cf-kind" style="display:block">
                      Kind
                    </label>
                    <select
                      class="select"
                      id="f-cf-kind"
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
                  <div style="font:400 10.5px 'Geist',sans-serif;color:var(--text3);line-height:1.5">
                    Config is write-only — leave the fields below blank to keep the stored secret
                    unchanged.
                  </div>
                </Show>

                <Show when={state.cf.kind === 'smtp'}>
                  <div style="display:grid;grid-template-columns:2fr 1fr;gap:12px">
                    <div>
                      <label class="field-label" for="f-cf-smtphost" style="display:block">
                        Host
                      </label>
                      <input
                        class="input mono"
                        id="f-cf-smtphost"
                        style="font:400 12px 'Geist Mono',monospace"
                        value={state.cf.smtpHost}
                        placeholder="smtp.fastmail.com"
                        onInput={(e) => setState('cf', 'smtpHost', e.currentTarget.value)}
                      />
                    </div>
                    <div>
                      <label class="field-label" for="f-cf-smtpport" style="display:block">
                        Port
                      </label>
                      <input
                        class="input mono"
                        id="f-cf-smtpport"
                        style="font:400 12px 'Geist Mono',monospace"
                        value={state.cf.smtpPort}
                        placeholder="587"
                        onInput={(e) => setState('cf', 'smtpPort', e.currentTarget.value)}
                      />
                    </div>
                  </div>
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                    <div>
                      <label class="field-label" for="f-cf-smtpsecure" style="display:block">
                        Security
                      </label>
                      <select
                        class="select"
                        id="f-cf-smtpsecure"
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
                      <label class="field-label" for="f-cf-smtpfrom" style="display:block">
                        From
                      </label>
                      <input
                        class="input mono"
                        id="f-cf-smtpfrom"
                        style="font:400 12px 'Geist Mono',monospace"
                        value={state.cf.smtpFrom}
                        placeholder="alerts@my.box"
                        onInput={(e) => setState('cf', 'smtpFrom', e.currentTarget.value)}
                      />
                    </div>
                  </div>
                  <div>
                    <label class="field-label" for="f-cf-smtpto" style="display:block">
                      Recipients (comma or space separated)
                    </label>
                    <input
                      class="input mono"
                      id="f-cf-smtpto"
                      style="font:400 12px 'Geist Mono',monospace"
                      value={state.cf.smtpTo}
                      placeholder="admin@my.box"
                      onInput={(e) => setState('cf', 'smtpTo', e.currentTarget.value)}
                    />
                  </div>
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                    <div>
                      <label class="field-label" for="f-cf-smtpuser" style="display:block">
                        User (optional)
                      </label>
                      <input
                        class="input mono"
                        id="f-cf-smtpuser"
                        style="font:400 12px 'Geist Mono',monospace"
                        value={state.cf.smtpUser}
                        onInput={(e) => setState('cf', 'smtpUser', e.currentTarget.value)}
                      />
                    </div>
                    <div>
                      <label class="field-label" for="f-cf-smtppass" style="display:block">
                        Password (optional)
                      </label>
                      <input
                        class="input mono"
                        id="f-cf-smtppass"
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
                    <label class="field-label" for="f-cf-apprise" style="display:block">
                      Apprise URLs (one per line)
                    </label>
                    <textarea
                      class="input mono"
                      id="f-cf-apprise"
                      style="font:400 12px 'Geist Mono',monospace;min-height:70px;resize:vertical"
                      value={state.cf.appriseUrls}
                      placeholder="ntfy://homelab/polyrouter"
                      onInput={(e) => setState('cf', 'appriseUrls', e.currentTarget.value)}
                    />
                  </div>
                </Show>

                <div style="font:400 10.5px 'Geist',sans-serif;color:var(--text3);line-height:1.5">
                  Targets are SSRF-checked and the config is encrypted at rest — it’s never shown
                  back.
                </div>
                <Show when={state.cf.error}>
                  <div style="font:400 11px 'Geist',sans-serif;color:var(--red)">
                    {state.cf.error}
                  </div>
                </Show>
                <div style="display:flex;gap:8px;justify-content:flex-end">
                  <button
                    type="button"
                    class="btn-cancel"
                    disabled={state.cf.busy}
                    onClick={() => app.closeModal()}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    class="btn-primary"
                    disabled={state.cf.busy}
                    onClick={() => void app.saveChannel()}
                  >
                    {state.cf.busy ? 'Saving…' : state.cf.id ? 'Save channel' : 'Add channel'}
                  </button>
                </div>
              </Show>
            </div>
          </div>
        );
      }}
    </Show>
  );
}
