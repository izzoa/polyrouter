/**
 * The subscription picker (redesign-subscription-picker; dashboard-core "Subscription plans are
 * chosen from one list with a detail pane", dashboard-config "The connect wizard offers the
 * identity opt-in for a declaring preset").
 *
 * A mode of the provider modal's card (design D4): while a NEW subscription provider is on the
 * connect path, the card widens and shows every listed plan on the left — the OAuth presets
 * under "Sign in with your account", the key presets under "Coding-plan API key" — and the
 * chosen plan's detail on the right. There is no verification status anywhere: every listed
 * plan is connectable (user decision 2026-11-09).
 *
 * The store owns the choice (`state.sp`, design D6) and both connect slices (`ow`, `kp`); this
 * component only presents them. Below the container fit (`PICKER_FIT`, design D7) the list and
 * the detail are two steps with explicit focus moves.
 */
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import type { KeyPresetDto, OauthPresetDto } from '../data/api';
import { PICKER_FIT } from '../state/appState';
import { useApp } from '../state/context';
import type { BusyMap } from './busy';
import { FieldNote, useFields } from './Field';
import { Icon } from './Icon';
import { IdentitySwitch } from './IdentitySwitch';
import { Notice } from './Notice';
import { OauthSteps } from './OauthSteps';
import { Segmented } from './Segmented';
import { StackedLabel } from './StackedLabel';

/** The terms-risk level as words: the level is always stated in text, never by colour alone. */
const RISK_WORDS: Record<KeyPresetDto['termsRisk'], string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

/** The generic flat-plan caution: an OAuth plan's detail and the classic paste form carry it. */
export const FLAT_PLAN_TOS =
  'Reusing a flat-rate subscription programmatically may violate the provider’s ToS — pair it with a pay-per-token fallback.';

/** The regions of a preset that need identity imitation (the provider currently refuses
 * polyrouter's own identity), by label. */
function imitationRegions(preset: KeyPresetDto): string[] {
  return preset.regions.filter((r) => r.imitationRequired).map((r) => r.label);
}

/** The link to a provider's terms. It opens a new tab, and says so to a screen reader. */
function TermsLink(props: { url: string; label: string }) {
  return (
    <a
      class="btn-ghost"
      style="align-self:flex-start;text-decoration:none"
      href={props.url}
      target="_blank"
      rel="noreferrer"
    >
      {props.label} <Icon name="externalLink" size={12} />
      <span class="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/** One plan in the list: a real button, `aria-current` on the chosen one (DESIGN.md Selected
 * state). While a sign-in session or a connect is in flight it is `aria-disabled` — focusable and
 * announced — and its click is ignored (design D9). */
function PlanEntry(props: {
  id: string;
  name: string;
  caption: string;
  note?: string | undefined;
  kind: 'oauth' | 'key';
  chosen: boolean;
  locked: boolean;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      class="sp-entry"
      data-plan={props.id}
      data-preset={props.kind === 'oauth' ? props.id : undefined}
      data-key-preset={props.kind === 'key' ? props.id : undefined}
      aria-current={props.chosen ? 'true' : undefined}
      aria-disabled={props.locked ? 'true' : undefined}
      onClick={() => {
        if (!props.locked) props.onChoose();
      }}
    >
      <span class="sp-entry-main">
        <span class="sp-entry-name">{props.name}</span>
        <span class="sp-entry-caption">{props.caption}</span>
      </span>
      <Show when={props.note}>
        <span class="sp-entry-note">{props.note}</span>
      </Show>
    </button>
  );
}

/** A key preset's detail: terms risk first, then the region, name, key, acknowledgement and
 * identity note. The connect action is the picker footer's one primary. The key never leaves
 * `state.kp.key` except to the connect call, and the store clears it after every attempt. */
function KeyPresetDetail(props: { preset: KeyPresetDto }) {
  const app = useApp();
  const { state, setState } = app;
  const f = useFields();
  const multi = () => props.preset.regions.length > 1;
  const region = () => props.preset.regions.find((r) => r.id === state.kp.region);
  const imitation = () => region()?.imitationRequired === true;
  const defaultName = () =>
    multi() && region() !== undefined
      ? `${props.preset.displayName} (${region()?.label ?? ''})`
      : props.preset.displayName;
  // The hint is advisory: a caution when a hinted prefix is not matched, never a rejection.
  const mismatch = () => {
    const prefix = props.preset.keyHint?.prefix ?? null;
    const key = state.kp.key.trim();
    return prefix !== null && key !== '' && !key.startsWith(prefix) ? prefix : null;
  };
  const level = () => RISK_WORDS[props.preset.termsRisk];
  const describedBy = (): string | undefined => {
    const own = f.describedBy('f-kp-key', props.preset.keyHint !== null);
    return mismatch() !== null ? [own, 'f-kp-key-caution'].filter(Boolean).join(' ') : own;
  };
  return (
    <div data-key-preset-form class="sp-detail-body">
      <div class="sp-group-tight">
        <Notice
          tone={props.preset.termsRisk === 'low' ? 'info' : 'caution'}
          title={`${level()} terms risk`}
        >
          {props.preset.riskCopy}
        </Notice>
        <TermsLink url={props.preset.termsUrl} label="Read the plan’s terms" />
      </div>
      <Show when={imitation()}>
        <Notice tone="caution" title="Identity imitation required">
          {props.preset.displayName} currently refuses polyrouter’s own identity. After connecting,
          turn on identity imitation in the provider’s Edit dialog, or it will not work.
        </Notice>
      </Show>
      <Show when={multi()}>
        <div
          class="sp-region"
          role="group"
          id="f-kp-region"
          tabindex="-1"
          aria-labelledby="f-kp-region-label"
          aria-describedby="f-kp-region-host"
        >
          <div id="f-kp-region-label" class="field-label">
            Region
          </div>
          <Segmented
            options={props.preset.regions.map((r) => ({
              id: r.id,
              label: r.imitationRequired ? `${r.label} — needs identity imitation` : r.label,
            }))}
            value={state.kp.region}
            onChange={(id) => {
              setState('kp', 'region', id);
              f.edit('f-kp-region');
            }}
          />
          <div id="f-kp-region-host" class="t-caption" style="color:var(--text3)">
            Endpoint <span class="mono">{region()?.host ?? '—'}</span>
          </div>
          <FieldNote for="f-kp-region" error={f.error('f-kp-region')} />
        </div>
      </Show>
      <div class="sp-group-snug">
        <div class="rs-picker-fields">
          <div>
            <label class="field-label" for="f-kp-name" style="display:block">
              Name (optional)
            </label>
            <input
              class="input"
              id="f-kp-name"
              value={state.kp.name}
              placeholder={defaultName()}
              onInput={(e) => setState('kp', 'name', e.currentTarget.value)}
            />
          </div>
          <div>
            <label class="field-label" for="f-kp-key" style="display:block">
              Plan key
            </label>
            <input
              class="input input--mono"
              id="f-kp-key"
              type="password"
              autocomplete="off"
              spellcheck={false}
              value={state.kp.key}
              aria-invalid={f.invalid('f-kp-key')}
              aria-describedby={describedBy()}
              onBlur={() => f.check('f-kp-key')}
              onInput={(e) => {
                setState('kp', 'key', e.currentTarget.value);
                f.edit('f-kp-key');
              }}
            />
          </div>
        </div>
        <div>
          <FieldNote for="f-kp-key" error={f.error('f-kp-key')} help={props.preset.keyHint?.note} />
          <Show when={mismatch()} keyed>
            {(prefix) => (
              <div id="f-kp-key-caution" class="t-caption" style="color:var(--amber-text)">
                This key does not start with {prefix}. It may be a pay-as-you-go key, which bills
                your account balance instead of the plan. You can still connect.
              </div>
            )}
          </Show>
        </div>
      </div>
      <Show when={props.preset.requiresAcknowledgement}>
        <label for="f-kp-ack" class="t-label sp-ack">
          <input
            type="checkbox"
            id="f-kp-ack"
            checked={state.kp.ack}
            onChange={(e) => setState('kp', 'ack', e.currentTarget.checked)}
          />
          I have read the terms and accept the risk to my {props.preset.displayName} account.
        </label>
      </Show>
      <Show when={props.preset.declaresIdentity}>
        <div class="sp-group-tight">
          <div class="field-label">Identity</div>
          <div class="t-dense" style="color:var(--text2)">
            polyrouter sends its own{' '}
            <span class="mono">User-Agent: polyrouter/&lt;version&gt;</span>. This plan also offers
            identity imitation, a per-provider switch that stays off unless you turn it on after
            connecting.
          </div>
        </div>
      </Show>
      <Show when={state.kp.error}>
        <div role="alert" class="t-caption" style="color:var(--red-text)">
          {state.kp.error}
        </div>
      </Show>
    </div>
  );
}

/** An OAuth preset's detail: what signing in does, the flat-plan caution and an optional name,
 * then — once Sign in is pressed — the identity step (a declaring preset) or the paste-back
 * steps, inside this pane (design D9). */
function OauthDetail(props: {
  preset: OauthPresetDto;
  connecting: BusyMap;
  onAskConsent: () => void;
}) {
  const app = useApp();
  const { state, setState } = app;
  return (
    <div class="sp-detail-body">
      <div class="t-dense" style="color:var(--text2)">
        Sign in with your account — tokens are stored encrypted and auto-refresh.
      </div>
      <div class="t-caption" style="color:var(--amber-text)">
        {FLAT_PLAN_TOS}
      </div>
      <Show
        when={state.ow.active}
        fallback={
          <Show
            when={state.ow.identity}
            keyed
            fallback={
              <div>
                <label class="field-label" for="f-sp-name" style="display:block">
                  Name (optional)
                </label>
                <input
                  class="input"
                  id="f-sp-name"
                  value={state.np.name}
                  placeholder={props.preset.displayName}
                  onInput={(e) => setState('np', 'name', e.currentTarget.value)}
                />
              </div>
            }
          >
            {(step) => (
              <div class="sp-group-tight">
                <IdentitySwitch
                  id="f-ow-imitate"
                  label={step.label}
                  checked={step.optIn}
                  onAsk={props.onAskConsent}
                  onOff={() => setState('ow', 'identity', 'optIn', false)}
                />
                <div class="sp-step-actions">
                  <button
                    type="button"
                    class="btn-cancel"
                    disabled={state.ow.busy}
                    onClick={() => {
                      const back = step.preset;
                      setState('ow', 'identity', null);
                      queueMicrotask(() =>
                        document.querySelector<HTMLElement>(`[data-preset="${back}"]`)?.focus(),
                      );
                    }}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    class="btn-primary"
                    disabled={state.ow.busy}
                    aria-busy={props.connecting.busy(step.preset) ? true : undefined}
                    onClick={() =>
                      void props.connecting.run(step.preset, () =>
                        app.startOauthConnect(step.preset, step.optIn),
                      )
                    }
                  >
                    <StackedLabel
                      alt={props.connecting.busy(step.preset)}
                      rest="Continue to sign-in"
                      altLabel="Connecting…"
                    />
                  </button>
                </div>
              </div>
            )}
          </Show>
        }
      >
        <OauthSteps backLabel="Back" onBack={() => app.cancelOauthConnect()} />
      </Show>
      <Show when={!state.ow.active && state.ow.error}>
        <div role="alert" class="t-caption" style="color:var(--red-text)">
          {state.ow.error}
        </div>
      </Show>
    </div>
  );
}

export function SubscriptionPicker(props: {
  connecting: BusyMap;
  onAskConsent: () => void;
  onChangeKind: () => void;
}) {
  const app = useApp();
  const { state, setState } = app;
  // Assigned by the root's `ref`.
  let rootEl: HTMLDivElement | undefined = undefined;
  const [narrow, setNarrow] = createSignal(false);

  onMount(() => {
    // The lists may already be loaded (a return from Change kind or the classic form).
    app.ensurePlanChoice();
    const card = rootEl?.closest<HTMLElement>('.modal-card') ?? rootEl;
    if (card === undefined || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => {
      // A 0px width is "not laid out yet" (a hidden card, a test DOM), never "narrow".
      const width = card.getBoundingClientRect().width;
      setNarrow(width > 0 && width < PICKER_FIT);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(card);
    measure();
    onCleanup(() => ro.disconnect());
  });

  // A list that changes under the picker (a reload, a preset withdrawn meanwhile) re-settles
  // the choice: a still-listed user choice is kept, an unlisted one falls to the first plan.
  createEffect(
    on(
      () => [state.ow.presets, state.kp.presets] as const,
      () => app.ensurePlanChoice(),
      { defer: true },
    ),
  );

  /** A sign-in session or a connect is in flight: the plan cannot change (design D9). */
  const locked = () => state.ow.active !== null || state.ow.busy || state.kp.busy;
  const chosenKey = () => state.kp.presets.find((p) => p.id === state.sp.chosen);
  const chosenOauth = () => state.ow.presets.find((p) => p.id === state.sp.chosen);
  const chosenName = () => chosenKey()?.displayName ?? chosenOauth()?.displayName ?? '';
  /** The footer's primary is shown only while the detail is not running its own wizard step. */
  const footerPrimary = () =>
    chosenKey() !== undefined ||
    (chosenOauth() !== undefined && state.ow.active === null && state.ow.identity === null);
  const gated = () => (chosenKey()?.requiresAcknowledgement ?? false) && !state.kp.ack;

  const choose = (id: string): void => {
    app.choosePlan(id);
    // Narrow: the list gives way to the detail, so focus moves to the detail's heading. Wide:
    // focus stays on the entry, and the next Tab moves into the detail (design D7).
    if (narrow()) queueMicrotask(() => document.getElementById('sp-detail-title')?.focus());
  };
  const back = (): void => {
    const id = state.sp.chosen;
    app.backToPlans();
    queueMicrotask(() =>
      document.querySelector<HTMLElement>(`.sp-entry[data-plan="${id ?? ''}"]`)?.focus(),
    );
  };
  const signIn = (preset: OauthPresetDto): void => {
    // A preset that declares a client identity opens the identity step first
    // (allow-preset-client-identity); one that declares none starts on this press.
    const identity = preset.clientIdentity ?? null;
    if (identity) {
      setState('ow', 'identity', { preset: preset.id, label: identity.label, optIn: false });
      return;
    }
    void props.connecting.run(preset.id, () => app.startOauthConnect(preset.id));
  };

  return (
    <div
      ref={(el: HTMLDivElement) => {
        rootEl = el;
      }}
      class="sp"
      data-subscription-picker
      data-step={state.sp.step}
      classList={{ 'sp--narrow': narrow() }}
    >
      <div class="sp-head">
        <div class="sp-head-titles">
          <div class="modal-title" id="modal-title">
            Connect a subscription
          </div>
          <div class="t-dense" style="color:var(--text3)">
            Add provider · Subscription
          </div>
        </div>
        <button
          type="button"
          class="btn-ghost"
          aria-disabled={locked() ? 'true' : undefined}
          onClick={() => {
            if (!locked()) props.onChangeKind();
          }}
        >
          Change kind
        </button>
      </div>

      <div class="rs-picker-body">
        <div class="sp-list">
          <Show when={state.ow.presets.length > 0}>
            <div role="group" aria-labelledby="sp-g-oauth" class="sp-group">
              <div id="sp-g-oauth" class="sp-group-label">
                Sign in with your account
              </div>
              <For each={state.ow.presets}>
                {(pr) => (
                  <PlanEntry
                    id={pr.id}
                    name={pr.displayName}
                    caption="Sign in"
                    kind="oauth"
                    chosen={state.sp.chosen === pr.id}
                    locked={locked()}
                    onChoose={() => choose(pr.id)}
                  />
                )}
              </For>
            </div>
          </Show>
          <Show when={state.kp.presets.length > 0}>
            <div role="group" aria-labelledby="sp-g-key" class="sp-group">
              <div id="sp-g-key" class="sp-group-label">
                Coding-plan API key
              </div>
              <For each={state.kp.presets}>
                {(p) => (
                  <PlanEntry
                    id={p.id}
                    name={p.displayName}
                    caption={`${RISK_WORDS[p.termsRisk]} risk`}
                    note={
                      imitationRegions(p).length > 0
                        ? `Currently refuses polyrouter’s own identity${
                            p.regions.length > 1 ? ` (${imitationRegions(p).join(', ')})` : ''
                          } — turn on identity imitation in Edit after connecting`
                        : undefined
                    }
                    kind="key"
                    chosen={state.sp.chosen === p.id}
                    locked={locked()}
                    onChoose={() => choose(p.id)}
                  />
                )}
              </For>
            </div>
          </Show>
          <div class="sp-other">
            <button
              type="button"
              class="btn-ghost"
              aria-disabled={locked() ? 'true' : undefined}
              onClick={() => {
                if (!locked()) app.openOtherSubscription();
              }}
            >
              Other subscription (paste a credential)
            </button>
          </div>
        </div>

        <section class="sp-detail" aria-labelledby="sp-detail-title">
          <Show when={narrow()}>
            <button type="button" class="btn-ghost sp-back" onClick={back}>
              Back to plans
            </button>
          </Show>
          <div class="sp-detail-head">
            <h3 id="sp-detail-title" class="sp-detail-title" tabindex="-1">
              {chosenName()}
            </h3>
            <Show when={chosenName() !== ''}>
              <span class="chip">{chosenKey() !== undefined ? 'API key' : 'Sign in'}</span>
            </Show>
          </div>
          <Show when={chosenKey()} keyed>
            {(p) => <KeyPresetDetail preset={p} />}
          </Show>
          <Show when={chosenOauth()} keyed>
            {(p) => (
              <OauthDetail
                preset={p}
                connecting={props.connecting}
                onAskConsent={props.onAskConsent}
              />
            )}
          </Show>
        </section>
      </div>

      <div class="sp-foot">
        <button
          type="button"
          class="btn-cancel"
          disabled={state.ow.busy || state.kp.busy}
          onClick={() => app.closeModal()}
        >
          Cancel
        </button>
        <Show when={footerPrimary() ? (chosenKey() ?? null) : null} keyed>
          {(p) => (
            <button
              type="button"
              class="btn-primary"
              disabled={state.kp.busy || gated()}
              aria-busy={state.kp.busy ? true : undefined}
              onClick={() => void app.connectKeyPreset()}
            >
              <StackedLabel
                alt={state.kp.busy}
                rest={`Connect ${p.displayName}`}
                altLabel="Connecting…"
              />
            </button>
          )}
        </Show>
        <Show when={footerPrimary() ? (chosenOauth() ?? null) : null} keyed>
          {(p) => (
            <button
              type="button"
              class="btn-primary"
              disabled={state.ow.busy}
              aria-busy={props.connecting.busy(p.id) ? true : undefined}
              onClick={() => signIn(p)}
            >
              <StackedLabel
                alt={props.connecting.busy(p.id)}
                rest="Sign in"
                altLabel="Connecting…"
              />
            </button>
          )}
        </Show>
      </div>
    </div>
  );
}
