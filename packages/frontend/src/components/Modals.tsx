import { HARNESS_LABELS, HARNESS_TYPES } from '@polyrouter/shared';
import { createEffect, For, on, Show } from 'solid-js';
import { useModalSurface } from '../a11y';
import {
  EVENT_TYPES,
  type BudgetScope,
  type BudgetWindow,
  type ChannelKind,
  type EventType,
  type SmtpSecure,
} from '../data/api';
import { PROVIDER_KINDS } from '../state/appState';
import { onSubscriptionConnect } from '../state/fieldChecks';
import { useApp } from '../state/context';
import type { Harness } from '../types';
import { Icon } from './Icon';
import { FieldNote, useFields } from './Field';
import { StackedLabel } from './StackedLabel';
import { createBusyMap } from './busy';

/** Friendly labels for the event-subscription checkboxes (#20 channel modal). */
const EVENT_LABELS: Record<EventType, string> = {
  budget_alert: 'Budget alert',
  budget_block: 'Budget block',
  provider_down: 'Provider down',
  request_failures_spike: 'Request failure spike',
  weekly_spend_summary: 'Weekly spend summary',
  batch_stalled: 'Batch job stalled',
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

/** The two sign-in steps of the OAuth connect wizard — open the link, paste what
 * you land on — shared by a new connect and a reconnect (add-provider-health-
 * signals). Rendered only while a connect session is active. */
function OauthSteps(props: { backLabel: string; onBack: () => void }) {
  const app = useApp();
  const { state, setState } = app;
  const f = useFields();
  return (
    <div style="display:flex;flex-direction:column;gap:8px">
      <div class="t-dense" style="color:var(--text)">
        1. Open the sign-in link and approve access.
      </div>
      <a
        class="btn-ghost"
        style="align-self:flex-start;text-decoration:none"
        href={state.ow.active?.authorizeUrl ?? '#'}
        target="_blank"
        rel="noreferrer"
      >
        Open sign-in link <Icon name="externalLink" size={12} />
        <span class="sr-only"> (opens in a new tab)</span>
      </a>
      <div class="t-dense" style="color:var(--text)">
        2. Paste what you land on — the full redirect URL or the code#state string.
      </div>
      <label class="field-label" for="f-ow-paste" style="display:block">
        Redirect URL or code
      </label>
      <input
        class="input input--mono"
        id="f-ow-paste"
        value={state.ow.pasted}
        placeholder="https://…/callback?code=…&state=… or code#state"
        aria-invalid={f.invalid('f-ow-paste')}
        aria-describedby={f.describedBy('f-ow-paste')}
        onBlur={() => f.check('f-ow-paste')}
        onInput={(e) => {
          setState('ow', 'pasted', e.currentTarget.value);
          f.edit('f-ow-paste');
        }}
      />
      <FieldNote for="f-ow-paste" error={f.error('f-ow-paste')} alert />
      <Show when={state.ow.error}>
        <div role="alert" class="t-caption" style="color:var(--red-text)">
          {state.ow.error}
        </div>
      </Show>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="button" class="btn-cancel" disabled={state.ow.busy} onClick={props.onBack}>
          {props.backLabel}
        </button>
        <button
          type="button"
          class="btn-primary"
          disabled={state.ow.busy}
          aria-busy={state.ow.busy ? true : undefined}
          onClick={() => void app.completeOauthConnect()}
        >
          <StackedLabel alt={state.ow.busy} rest="Connect" altLabel="Connecting…" />
        </button>
      </div>
    </div>
  );
}

export function Modals() {
  const app = useApp();
  const { state, setState } = app;
  // Each of the dashboard's own checks reports on the field it concerns (task 8.2, D20).
  const f = useFields();
  /** Any SMTP config edit can settle the other SMTP fields' checks: an edit keeps its stored
   * config only while every config field is blank. */
  const editSmtp = (): void => {
    for (const id of ['f-cf-smtphost', 'f-cf-smtpport', 'f-cf-smtpfrom', 'f-cf-smtpto'] as const)
      f.edit(id);
  };
  // A subscription preset card starts the sign-in request and stays on screen until it
  // answers (D14): only the pressed card says so, though all of them wait on `ow.busy`.
  const connecting = createBusyMap();
  const npKind = () => PROVIDER_KINDS.find((k) => k.id === state.np.kind);
  /** The OAuth connect path replaces the classic fields for a NEW subscription
   * provider whenever the server lists an enabled preset (add-subscription-oauth). */
  const subConnect = () => onSubscriptionConnect(state);
  // The name is optional on the connect path (its check does not apply there), so a "Name is
  // required" shown on the classic path clears when the form moves onto it.
  createEffect(
    on(subConnect, (connect) => {
      if (connect) f.edit('f-np-name');
    }),
  );

  // Editing an OAuth-connected row (add-chatgpt-responses): endpoint/kind/protocol
  // are preset-pinned — rendered read-only; the submit is name-only.
  const oauthLocked = () => state.np.editingId !== null && state.np.oauthPreset !== null;
  const PROTOCOL_LABELS: Record<string, string> = {
    openai_compatible: 'OpenAI-compatible',
    anthropic_compatible: 'Anthropic-compatible',
    openai_responses: 'ChatGPT Responses',
  };

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
        // Registers as a `dialog`: it claims aria-modal, so it owes the trapping contract.
        // Ordering, suspension and dispatch all come from the arbiter now.
        const surface = useModalSurface(app, {
          when: () => true, // this branch only renders while a modal is open
          labelledBy: 'modal-title',
          onDismiss: () => app.closeModal(),
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
            style={{ 'z-index': String(surface.z().backdrop) }}
            onClick={(e) => {
              if (e.target === e.currentTarget) app.closeModal();
            }}
          >
            <div
              class="modal-card"
              {...surface.props}
              ref={(el: HTMLDivElement) => {
                cardEl = el;
                (surface.props['ref'] as (n: HTMLElement) => void)(el);
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
                    aria-invalid={f.invalid('f-na-name')}
                    aria-describedby={f.describedBy('f-na-name')}
                    onBlur={() => f.check('f-na-name')}
                    onInput={(e) => {
                      setState('na', 'name', e.currentTarget.value);
                      f.edit('f-na-name');
                    }}
                  />
                  <FieldNote for="f-na-name" error={f.error('f-na-name')} />
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
                  <div class="t-caption" style="color:var(--red-text)">
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
                    aria-busy={state.na.busy ? true : undefined}
                    onClick={() => void app.createAgent()}
                  >
                    <StackedLabel
                      alt={state.na.busy}
                      rest="Create & mint key"
                      altLabel="Minting…"
                    />
                  </button>
                </div>
              </Show>

              <Show when={state.modal === 'keyReveal'}>
                <div class="modal-title" id="modal-title">
                  {state.kr.title}
                </div>
                <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--amber-bg);border-radius:6px">
                  <span class="mono t-label" style="color:var(--text);word-break:break-all">
                    {state.kr.key}
                  </span>
                  <button
                    type="button"
                    class="link-accent t-label"
                    style="margin-left:auto;flex:none"
                    onClick={() => app.copy(state.kr.key, 'Key copied')}
                  >
                    Copy
                  </button>
                </div>
                <div class="t-caption" style="color:var(--amber-text)">
                  Shown once — only an HMAC hash is stored. The old key stops working immediately.
                </div>
                <div class="snippet-box">{state.kr.snippet}</div>
                <div style="display:flex;justify-content:flex-end">
                  <button type="button" class="btn-primary" onClick={() => app.closeModal()}>
                    Done
                  </button>
                </div>
              </Show>

              <Show when={state.modal === 'newProvider' || state.modal === 'editProvider'}>
                <div class="modal-title" id="modal-title">
                  {state.ow.reconnect !== null
                    ? `Reconnect ${state.ow.reconnect.name}`
                    : state.np.editingId
                      ? 'Edit provider'
                      : 'Add provider'}
                </div>
                {/* Reconnect mode (add-provider-health-signals): ONLY the sign-in steps
                    for the provider being renewed — never the add-provider form. */}
                <Show when={state.ow.reconnect}>
                  <div data-reconnect-view style="display:flex;flex-direction:column;gap:12px">
                    <div class="t-dense" style="color:var(--text3)">
                      Sign in again to renew this provider. Its models and routing stay exactly as
                      they are.
                    </div>
                    <Show
                      when={state.ow.active}
                      fallback={
                        <Show
                          when={state.ow.error}
                          fallback={
                            <div role="status" class="t-dense" style="color:var(--text3)">
                              Starting sign-in…
                            </div>
                          }
                        >
                          <div role="alert" class="t-caption" style="color:var(--red-text)">
                            Couldn’t start the sign-in: {state.ow.error}
                          </div>
                          <div style="display:flex;gap:8px;justify-content:flex-end">
                            <button
                              type="button"
                              class="btn-cancel"
                              onClick={() => app.closeModal()}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              class="btn-primary"
                              disabled={state.ow.busy}
                              onClick={() => {
                                const target = state.providers.find(
                                  (x) => x.id === state.ow.reconnect?.providerId,
                                );
                                if (target) void app.startOauthReauthorize(target);
                              }}
                            >
                              Try again
                            </button>
                          </div>
                        </Show>
                      }
                    >
                      <OauthSteps backLabel="Cancel" onBack={() => app.closeModal()} />
                    </Show>
                  </div>
                </Show>
                <Show when={state.ow.reconnect === null}>
                  <div>
                    <label class="field-label" for="f-np-name" style="display:block">
                      Name
                    </label>
                    <input
                      class="input"
                      id="f-np-name"
                      value={state.np.name}
                      placeholder="e.g. OpenAI, mylab-endpoint"
                      aria-invalid={f.invalid('f-np-name')}
                      aria-describedby={f.describedBy('f-np-name')}
                      onBlur={() => f.check('f-np-name')}
                      onInput={(e) => {
                        setState('np', 'name', e.currentTarget.value);
                        f.edit('f-np-name');
                      }}
                    />
                    <FieldNote for="f-np-name" error={f.error('f-np-name')} />
                  </div>
                  <Show
                    when={!oauthLocked()}
                    fallback={
                      <div>
                        <div class="field-label">Connection</div>
                        <div style="padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--bg2)">
                          <span class="t-label" style="display:block;color:var(--text)">
                            Subscription — connected via {state.np.oauthPreset}
                          </span>
                          <span
                            class="t-caption"
                            style="display:block;color:var(--text3);margin-top:4px"
                          >
                            Endpoint, kind, and protocol are pinned by the connection. Reconnect to
                            sign in again — it renews this provider in place, keeping its models and
                            routing
                            {state.np.protocol === 'openai_responses'
                              ? '. This provider only works with its OAuth sign-in.'
                              : ' — or paste a credential below to convert it to an ordinary provider.'}
                          </span>
                          {/* add-provider-health-signals: the action the copy names is always
                            right here — never a reference to a control that isn't shown. */}
                          <button
                            type="button"
                            class="btn-ghost"
                            style="margin-top:8px"
                            onClick={() => {
                              const editing = state.providers.find(
                                (p) => p.id === state.np.editingId,
                              );
                              if (editing) void app.startOauthReauthorize(editing);
                            }}
                          >
                            Reconnect
                          </button>
                        </div>
                      </div>
                    }
                  >
                    <div>
                      <div class="field-label">Kind</div>
                      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                        <For each={PROVIDER_KINDS}>
                          {(k) => (
                            <button
                              type="button"
                              class="kind-card"
                              aria-pressed={state.np.kind === k.id}
                              onClick={() => setState('np', 'kind', k.id)}
                            >
                              <span class="t-label kind-card-name">{k.name}</span>
                              <span
                                class="t-caption"
                                style="display:block;color:var(--text3);margin-top:4px"
                              >
                                {k.desc}
                              </span>
                            </button>
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>
                  <Show when={subConnect()}>
                    <Show
                      when={state.ow.active}
                      fallback={
                        <div style="display:flex;flex-direction:column;gap:8px">
                          <div class="field-label">Connect a subscription</div>
                          <For each={state.ow.presets}>
                            {(pr) => (
                              <button
                                type="button"
                                class="kind-card"
                                disabled={state.ow.busy}
                                aria-busy={connecting.busy(pr.id) ? true : undefined}
                                onClick={() =>
                                  void connecting.run(pr.id, () => app.startOauthConnect(pr.id))
                                }
                              >
                                <span class="t-label" style="display:block;color:var(--text)">
                                  <StackedLabel
                                    alt={connecting.busy(pr.id)}
                                    rest={pr.displayName}
                                    altLabel="Connecting…"
                                  />
                                </span>
                                <span
                                  class="t-caption"
                                  style="display:block;color:var(--text3);margin-top:4px"
                                >
                                  Sign in with your account — tokens are stored encrypted and
                                  auto-refresh.
                                </span>
                              </button>
                            )}
                          </For>
                          <button
                            type="button"
                            class="btn-ghost"
                            style="align-self:flex-start"
                            onClick={() => setState('ow', 'advanced', true)}
                          >
                            Other subscription (paste a credential)
                          </button>
                        </div>
                      }
                    >
                      <OauthSteps backLabel="Back" onBack={() => app.cancelOauthConnect()} />
                    </Show>
                    <Show when={!state.ow.active && state.ow.error}>
                      <div class="t-caption" style="color:var(--red-text)">
                        {state.ow.error}
                      </div>
                    </Show>
                    <div class="t-caption" style="color:var(--amber-text)">
                      Reusing a flat-rate subscription programmatically may violate the provider’s
                      ToS — pair it with a pay-per-token fallback.
                    </div>
                  </Show>
                  <Show when={!subConnect()}>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                      <div>
                        <label class="field-label" for="f-np-protocol" style="display:block">
                          Protocol
                        </label>
                        <Show
                          when={!oauthLocked()}
                          fallback={
                            // Pinned by the connection, not temporarily unavailable: a
                            // read-only field, focusable and copyable (task 8.1; DESIGN.md
                            // Inputs / Fields — disabled is for a passing unavailability).
                            <input
                              class="input"
                              id="f-np-protocol"
                              value={PROTOCOL_LABELS[state.np.protocol] ?? state.np.protocol}
                              readOnly
                              aria-label="Protocol (pinned by the connection)"
                            />
                          }
                        >
                          <select
                            class="select"
                            id="f-np-protocol"
                            value={state.np.protocol}
                            onChange={(e) =>
                              setState(
                                'np',
                                'protocol',
                                e.currentTarget.value as
                                  'openai_compatible' | 'anthropic_compatible',
                              )
                            }
                          >
                            <option value="openai_compatible">OpenAI-compatible</option>
                            <option value="anthropic_compatible">Anthropic-compatible</option>
                          </select>
                        </Show>
                      </div>
                      <div>
                        <label class="field-label" for="f-np-baseurl" style="display:block">
                          Base URL
                        </label>
                        <input
                          class="input input--mono"
                          id="f-np-baseurl"
                          value={state.np.baseUrl}
                          readOnly={oauthLocked()}
                          placeholder={
                            npKind()?.id === 'local'
                              ? 'http://127.0.0.1:11434/v1'
                              : 'https://api.provider.com/v1'
                          }
                          aria-invalid={f.invalid('f-np-baseurl')}
                          aria-describedby={f.describedBy('f-np-baseurl')}
                          onBlur={() => f.check('f-np-baseurl')}
                          onInput={(e) => {
                            setState('np', 'baseUrl', e.currentTarget.value);
                            f.edit('f-np-baseurl');
                          }}
                        />
                        <FieldNote for="f-np-baseurl" error={f.error('f-np-baseurl')} />
                      </div>
                    </div>
                    {/* A Responses row runs ONLY on its OAuth sign-in — a pasted credential
                    can never work, so the rotate/clear controls are not offered. */}
                    <Show when={!(oauthLocked() && state.np.protocol === 'openai_responses')}>
                      <div>
                        <label class="field-label" for="f-np-credential" style="display:block">
                          {npKind()?.field ?? 'Credential'}
                          {state.np.kind === 'local' ? ' (optional)' : ''}
                        </label>
                        <input
                          class="input input--mono"
                          id="f-np-credential"
                          type="password"
                          value={state.np.credential}
                          disabled={state.np.clearCredential}
                          placeholder={
                            oauthLocked()
                              ? 'leave blank to keep the connected sign-in'
                              : state.np.editingId && state.np.hadCredential
                                ? 'leave blank to keep the stored key'
                                : (npKind()?.ph ?? '')
                          }
                          onInput={(e) => setState('np', 'credential', e.currentTarget.value)}
                        />
                        <Show when={state.np.editingId !== null && state.np.hadCredential}>
                          <label
                            class="t-caption"
                            style="display:flex;align-items:center;gap:8px;margin-top:8px;color:var(--text3)"
                          >
                            <input
                              type="checkbox"
                              checked={state.np.clearCredential}
                              onChange={(e) =>
                                setState('np', 'clearCredential', e.currentTarget.checked)
                              }
                            />
                            Remove the stored credential
                          </label>
                        </Show>
                      </div>
                    </Show>
                    <Show when={state.np.kind === 'sub'}>
                      <div class="t-caption" style="color:var(--amber-text)">
                        Reusing a flat-rate subscription programmatically may violate the provider’s
                        ToS — pair it with a pay-per-token fallback.
                      </div>
                    </Show>
                    <Show
                      when={
                        state.np.editingId !== null &&
                        (state.np.kind === 'api' || state.np.kind === 'sub') &&
                        (state.np.origKind === 'custom' || state.np.origKind === 'local')
                      }
                    >
                      <div class="t-caption" style="color:var(--amber-text)">
                        An API-key/subscription provider is priced from the catalog — any per-model
                        prices you set are cleared on save.
                      </div>
                    </Show>
                    {/* Advanced patience (fix-long-call-timeouts): blank = inherit the
                    instance defaults — shown honestly as placeholders from the
                    server's timeout-defaults read, never hard-coded. */}
                    {/* The patience note describes BOTH fields, so it is the group's
                        description, not one field's help (task 8.2; notes/flags.md F5):
                        each field keeps its own slot for its own message. */}
                    <div
                      role="group"
                      aria-labelledby="f-np-patience-title"
                      aria-describedby="f-np-patience-note"
                    >
                      <div class="upper-label" id="f-np-patience-title" style="margin-bottom:8px">
                        Advanced — patience for slow models
                      </div>
                      <div style="display:flex;gap:8px">
                        <div style="flex:1">
                          <label class="field-label" for="f-np-firstbyte" style="display:block">
                            First response (s)
                          </label>
                          <input
                            class="input input--figure"
                            id="f-np-firstbyte"
                            inputmode="numeric"
                            value={state.np.firstByteTimeoutS}
                            placeholder={
                              state.tdefaults !== null
                                ? `${String(state.tdefaults.firstByteTimeoutMs / 1000)} · instance default`
                                : 'instance default'
                            }
                            aria-invalid={f.invalid('f-np-firstbyte')}
                            aria-describedby={f.describedBy('f-np-firstbyte')}
                            onBlur={() => f.check('f-np-firstbyte')}
                            onInput={(e) => {
                              setState('np', 'firstByteTimeoutS', e.currentTarget.value);
                              f.edit('f-np-firstbyte');
                            }}
                          />
                          <FieldNote for="f-np-firstbyte" error={f.error('f-np-firstbyte')} />
                        </div>
                        <div style="flex:1">
                          <label class="field-label" for="f-np-idle" style="display:block">
                            Between chunks (s)
                          </label>
                          <input
                            class="input input--figure"
                            id="f-np-idle"
                            inputmode="numeric"
                            value={state.np.idleTimeoutS}
                            placeholder={
                              state.tdefaults !== null
                                ? `${String(state.tdefaults.idleTimeoutMs / 1000)} · instance default`
                                : 'instance default'
                            }
                            aria-invalid={f.invalid('f-np-idle')}
                            aria-describedby={f.describedBy('f-np-idle')}
                            onBlur={() => f.check('f-np-idle')}
                            onInput={(e) => {
                              setState('np', 'idleTimeoutS', e.currentTarget.value);
                              f.edit('f-np-idle');
                            }}
                          />
                          <FieldNote for="f-np-idle" error={f.error('f-np-idle')} />
                        </div>
                      </div>
                      <div
                        class="t-caption"
                        id="f-np-patience-note"
                        style="color:var(--text3);margin-top:4px"
                      >
                        For research/long-thinking models: raise patience here (up to 3600s), prefer
                        streaming, and size your client SDK’s own timeout — the one bound the router
                        can’t lift. Blank inherits the instance default. Timeouts count against this
                        provider’s circuit breaker; a repeatedly slow provider is skipped until its
                        recovery probe (which runs with doubled patience) succeeds — raising this is
                        the durable fix for heavy chains.
                      </div>
                    </div>
                    {/* add-auto-prune-unlisted-models: edit only — a provider that does not
                    exist yet has nothing to prune. */}
                    <Show when={state.np.editingId !== null}>
                      <div>
                        <label
                          for="f-np-autoprune"
                          class="t-label"
                          style="display:flex;align-items:center;gap:8px;min-height:24px;color:var(--text2)"
                        >
                          <input
                            type="checkbox"
                            id="f-np-autoprune"
                            checked={state.np.autoPruneUnlisted}
                            onChange={(e) =>
                              setState('np', 'autoPruneUnlisted', e.currentTarget.checked)
                            }
                          />
                          Remove retired models automatically
                        </label>
                        <div class="t-caption" style="color:var(--text3);margin-top:4px">
                          Models this provider has not listed for 7 days are removed on the next
                          sync, unless a tier or rule uses them.
                        </div>
                      </div>
                    </Show>
                    <div class="t-caption" style="color:var(--text3)">
                      Custom base URLs are SSRF-checked — private and metadata ranges are rejected.
                      Credentials are encrypted at rest.
                    </div>
                    <Show when={state.np.error}>
                      <div class="t-caption" style="color:var(--red-text)">
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
                        aria-busy={state.np.busy ? true : undefined}
                        onClick={() => void app.addProvider()}
                      >
                        <StackedLabel
                          alt={state.np.busy}
                          rest={state.np.editingId ? 'Save changes' : 'Add provider'}
                          altLabel={state.np.editingId ? 'Saving…' : 'Adding…'}
                        />
                      </button>
                    </div>
                  </Show>
                </Show>
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
                    aria-invalid={f.invalid('f-bf-name')}
                    aria-describedby={f.describedBy('f-bf-name')}
                    onBlur={() => f.check('f-bf-name')}
                    onInput={(e) => {
                      setState('bf', 'name', e.currentTarget.value);
                      f.edit('f-bf-name');
                    }}
                  />
                  <FieldNote for="f-bf-name" error={f.error('f-bf-name')} />
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
                      onChange={(e) =>
                        setState('bf', 'scope', e.currentTarget.value as BudgetScope)
                      }
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
                      class="input input--figure"
                      id="f-bf-amount"
                      value={state.bf.amount}
                      placeholder="10.00"
                      aria-invalid={f.invalid('f-bf-amount')}
                      aria-describedby={f.describedBy('f-bf-amount')}
                      onBlur={() => f.check('f-bf-amount')}
                      onInput={(e) => {
                        setState('bf', 'amount', e.currentTarget.value);
                        f.edit('f-bf-amount');
                      }}
                    />
                    <FieldNote for="f-bf-amount" error={f.error('f-bf-amount')} />
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
                      class="seg-track"
                      style="background:var(--bg)"
                    >
                      <button
                        type="button"
                        class="rs-seg rs-seg--fill"
                        data-label="Alert"
                        aria-pressed={state.bf.action === 'alert'}
                        onClick={() => setState('bf', 'action', 'alert')}
                      >
                        Alert
                      </button>
                      <button
                        type="button"
                        class="rs-seg rs-seg--fill"
                        data-label="Block"
                        aria-pressed={state.bf.action === 'block'}
                        onClick={() => setState('bf', 'action', 'block')}
                      >
                        Block
                      </button>
                    </div>
                  </div>
                </div>
                {/* The basis is only meaningful if it is visible — a budget silently
                    metering prepaid subscription usage would look like it was metering
                    money (split-subscription-spend). */}
                <div>
                  <div class="field-label">Counts</div>
                  <div
                    role="group"
                    aria-label="What this budget counts"
                    class="seg-track"
                    style="background:var(--bg)"
                  >
                    <button
                      type="button"
                      class="rs-seg rs-seg--fill"
                      data-label="Money spent"
                      aria-pressed={state.bf.meteringBasis === 'cash'}
                      onClick={() => setState('bf', 'meteringBasis', 'cash')}
                    >
                      Money spent
                    </button>
                    <button
                      type="button"
                      class="rs-seg rs-seg--fill"
                      data-label="+ subscription usage"
                      aria-pressed={state.bf.meteringBasis === 'notional'}
                      onClick={() => setState('bf', 'meteringBasis', 'notional')}
                    >
                      + subscription usage
                    </button>
                  </div>
                  <div class="t-caption" style="color:var(--text3);margin-top:4px">
                    {state.bf.meteringBasis === 'cash'
                      ? 'Counts only what you are billed for. Subscription requests are prepaid, so they never use up this budget.'
                      : 'Also counts subscription requests priced at the provider’s API rate — a rough way to cap usage of a flat-rate plan, not money spent.'}
                  </div>
                </div>
                <div>
                  <div class="field-label">Notify channels</div>
                  <Show
                    when={state.channels.length > 0}
                    fallback={
                      <div class="t-caption" style="color:var(--text3)">
                        No channels yet — add one under Settings, Notifications.
                      </div>
                    }
                  >
                    <div style="display:flex;flex-wrap:wrap;gap:8px">
                      <For each={state.channels}>
                        {(c) => (
                          <label
                            class="t-dense"
                            style="display:flex;align-items:center;gap:8px;color:var(--text2)"
                          >
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
                <label
                  class="t-dense"
                  style="display:flex;align-items:center;gap:8px;color:var(--text2)"
                >
                  <input
                    type="checkbox"
                    checked={state.bf.enabled}
                    onChange={(e) => setState('bf', 'enabled', e.currentTarget.checked)}
                  />
                  Enabled
                </label>
                <div class="t-caption" style="color:var(--text3)">
                  Alert notifies your channels and keeps serving. Block rejects new requests for
                  this scope until the window resets.
                </div>
                <Show when={state.bf.error}>
                  <div class="t-caption" style="color:var(--red-text)">
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
                    aria-busy={state.bf.busy ? true : undefined}
                    onClick={() => void app.saveBudget()}
                  >
                    <StackedLabel
                      alt={state.bf.busy}
                      rest={state.bf.id ? 'Save budget' : 'Create budget'}
                      altLabel="Saving…"
                    />
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
                      aria-invalid={f.invalid('f-cf-name')}
                      aria-describedby={f.describedBy('f-cf-name')}
                      onBlur={() => f.check('f-cf-name')}
                      onInput={(e) => {
                        setState('cf', 'name', e.currentTarget.value);
                        f.edit('f-cf-name');
                      }}
                    />
                    <FieldNote for="f-cf-name" error={f.error('f-cf-name')} />
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
                        <label
                          class="t-dense"
                          style="display:flex;align-items:center;gap:8px;color:var(--text2)"
                        >
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
                  <div class="t-caption" style="color:var(--text3)">
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
                        class="input input--mono"
                        id="f-cf-smtphost"
                        value={state.cf.smtpHost}
                        placeholder="smtp.fastmail.com"
                        aria-invalid={f.invalid('f-cf-smtphost')}
                        aria-describedby={f.describedBy('f-cf-smtphost')}
                        onBlur={() => f.check('f-cf-smtphost')}
                        onInput={(e) => {
                          setState('cf', 'smtpHost', e.currentTarget.value);
                          editSmtp();
                        }}
                      />
                      <FieldNote for="f-cf-smtphost" error={f.error('f-cf-smtphost')} />
                    </div>
                    <div>
                      <label class="field-label" for="f-cf-smtpport" style="display:block">
                        Port
                      </label>
                      <input
                        class="input input--mono"
                        id="f-cf-smtpport"
                        value={state.cf.smtpPort}
                        placeholder="587"
                        aria-invalid={f.invalid('f-cf-smtpport')}
                        aria-describedby={f.describedBy('f-cf-smtpport')}
                        onBlur={() => f.check('f-cf-smtpport')}
                        onInput={(e) => {
                          setState('cf', 'smtpPort', e.currentTarget.value);
                          editSmtp();
                        }}
                      />
                      <FieldNote for="f-cf-smtpport" error={f.error('f-cf-smtpport')} />
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
                        class="input input--mono"
                        id="f-cf-smtpfrom"
                        value={state.cf.smtpFrom}
                        placeholder="alerts@my.box"
                        aria-invalid={f.invalid('f-cf-smtpfrom')}
                        aria-describedby={f.describedBy('f-cf-smtpfrom')}
                        onBlur={() => f.check('f-cf-smtpfrom')}
                        onInput={(e) => {
                          setState('cf', 'smtpFrom', e.currentTarget.value);
                          editSmtp();
                        }}
                      />
                      <FieldNote for="f-cf-smtpfrom" error={f.error('f-cf-smtpfrom')} />
                    </div>
                  </div>
                  <div>
                    <label class="field-label" for="f-cf-smtpto" style="display:block">
                      Recipients (comma or space separated)
                    </label>
                    <input
                      class="input input--mono"
                      id="f-cf-smtpto"
                      value={state.cf.smtpTo}
                      placeholder="admin@my.box"
                      aria-invalid={f.invalid('f-cf-smtpto')}
                      aria-describedby={f.describedBy('f-cf-smtpto')}
                      onBlur={() => f.check('f-cf-smtpto')}
                      onInput={(e) => {
                        setState('cf', 'smtpTo', e.currentTarget.value);
                        editSmtp();
                      }}
                    />
                    <FieldNote for="f-cf-smtpto" error={f.error('f-cf-smtpto')} />
                  </div>
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                    <div>
                      <label class="field-label" for="f-cf-smtpuser" style="display:block">
                        User (optional)
                      </label>
                      <input
                        class="input input--mono"
                        id="f-cf-smtpuser"
                        value={state.cf.smtpUser}
                        onInput={(e) => {
                          setState('cf', 'smtpUser', e.currentTarget.value);
                          editSmtp();
                        }}
                      />
                    </div>
                    <div>
                      <label class="field-label" for="f-cf-smtppass" style="display:block">
                        Password (optional)
                      </label>
                      <input
                        class="input input--mono"
                        id="f-cf-smtppass"
                        type="password"
                        value={state.cf.smtpPass}
                        onInput={(e) => {
                          setState('cf', 'smtpPass', e.currentTarget.value);
                          editSmtp();
                        }}
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
                      class="input input--mono"
                      id="f-cf-apprise"
                      style="min-height:70px;resize:vertical"
                      value={state.cf.appriseUrls}
                      placeholder="ntfy://homelab/polyrouter"
                      aria-invalid={f.invalid('f-cf-apprise')}
                      aria-describedby={f.describedBy('f-cf-apprise')}
                      onBlur={() => f.check('f-cf-apprise')}
                      onInput={(e) => {
                        setState('cf', 'appriseUrls', e.currentTarget.value);
                        f.edit('f-cf-apprise');
                      }}
                    />
                    <FieldNote for="f-cf-apprise" error={f.error('f-cf-apprise')} />
                  </div>
                </Show>

                <div class="t-caption" style="color:var(--text3)">
                  Targets are SSRF-checked and the config is encrypted at rest — it’s never shown
                  back.
                </div>
                <Show when={state.cf.error}>
                  <div class="t-caption" style="color:var(--red-text)">
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
                    aria-busy={state.cf.busy ? true : undefined}
                    onClick={() => void app.saveChannel()}
                  >
                    <StackedLabel
                      alt={state.cf.busy}
                      rest={state.cf.id ? 'Save channel' : 'Add channel'}
                      altLabel="Saving…"
                    />
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
