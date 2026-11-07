import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  onMount,
  Show,
} from 'solid-js';
import type { EffectivePrice, ModelPricingInput } from '../data/api';
import { fmtUntil, fmtUsd } from '../data/format';
import { MAX_USAGE_TICK_MS, nextTickAt, planUsageView } from '../data/planUsage';
import { unlistedText } from '../data/unlisted';
import { FROM_DIALOG, isPriceEditableKind, providerKindLabel } from '../state/appState';
import { isNonRoutableVariant } from '@polyrouter/shared';
import { useApp } from '../state/context';
import type { Model, Provider } from '../types';
import { activePause, providerHealthView, type HealthTone } from '../data/providerHealth';
import { ConsentConfirm } from '../components/ConsentConfirm';
import { StackedLabel } from '../components/StackedLabel';
import { Notice } from '../components/Notice';
import { pageTitle } from '../components/Topbar';
import { createBusy } from '../components/busy';
import { FigureText } from '../components/FigureText';
import { priceLabelParts, type FigurePart, type PriceLabel } from '../data/figures';
import { createLocalFields, FieldNote } from '../components/Field';

/** setTimeout's delay limit: a longer one overflows and fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The status DOT's fill, by the health line's tone (add-provider-health-signals). */
function toneDotColor(tone: HealthTone): string {
  return tone === 'green'
    ? 'var(--green)'
    : tone === 'red'
      ? 'var(--red)'
      : tone === 'amber'
        ? 'var(--amber)'
        : 'var(--text3)';
}

/** The status LABEL's text colour. Split from the dot because the fill green is only
 * 2.7:1 on white — fine for a 6px dot, a WCAG failure for an 11.5px label. */
function toneTextColor(tone: HealthTone): string {
  return tone === 'green'
    ? 'var(--green-text)'
    : tone === 'red'
      ? 'var(--red-text)'
      : tone === 'amber'
        ? 'var(--amber-text)'
        : 'var(--text3)';
}

/** The effective display price — resolved server-side (billing resolver, then the
 * provider-listed estimate) — as figure parts (adopt-figure-states D1, D4): `unpriced` in
 * Ink 3, `$0 free` with only `free` green and `$0` in the price line's own Ink 3, or the unit
 * prices, each followed by an Ink 3 `· est.` when the price was estimated. `null` means
 * genuinely unpriced. */
function priceText(m: Model): readonly FigurePart[] {
  return priceLabelParts(priceLabelOf(m.effectivePrice));
}

/** "· expires in Nh" from the non-secret credential expiry (blank when unknown/past —
 * the reauthorize state carries its own messaging). A token lifetime says nothing
 * about upstream health, so it renders on its own neutral line. */
function expiresLabel(iso: string | null): string {
  if (iso === null) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const hours = ms / 3_600_000;
  return hours >= 1 ? ` · expires in ${String(Math.round(hours))}h` : ' · expires soon';
}

/** Short provenance line under the price — where the shown number comes from. */
function priceProvenance(m: Model): string {
  const ep = m.effectivePrice;
  if (ep === null) return 'unpriced — cost not tracked';
  switch (ep.source) {
    case 'listed':
      return 'provider-listed · estimate';
    case 'native_family': {
      // The recorded-cost estimate (an adjacent channel's catalog rate); the
      // channel's own listed figure rides ALONGSIDE when captured.
      const listed = m.listedPrice;
      return listed !== null
        ? `native family · estimate — provider lists ${fmtUsd(listed.inputPricePer1m)} / ${fmtUsd(listed.outputPricePer1m)}`
        : 'native family · estimate';
    }
    case 'model':
      return 'you set this';
    case 'local':
      return 'local model — free';
    default:
      return 'from the price catalog';
  }
}

/** The batch-rate line on a base model's row (add-model-variant-detection): shown when the
 * model has a batch twin on this provider, which is the signal that a batch tier exists. The
 * twin is never selectable. The rate itself is the base model's `batchEffectivePrice`, the
 * price resolved in batch mode (catalog batch pair, then native family, then the twin's
 * captured rate as the last resort; provider-management), so a known catalog batch rate is
 * never shown as `unpriced` because the twin row carries no synchronous price, and this line
 * agrees with the batch help on the Routing page.
 *
 * Every state is a price label (adopt-figure-states D4): `batch rate · unpriced`,
 * `batch rate · $0 free` (only `free` green), or `batch rate · $x / $y per 1M`, each followed
 * by an Ink 3 `· est.` exactly when the batch price was estimated. */
function batchRateText(bp: EffectivePrice | null): readonly FigurePart[] {
  const lead: FigurePart = { text: 'batch rate ·', tone: 'slot' };
  return [lead, ...priceLabelParts(priceLabelOf(bp))];
}

/** A resolved price as a price label: null is `unpriced`, never `$0.00`. */
function priceLabelOf(ep: EffectivePrice | null): PriceLabel {
  if (ep === null) return { kind: 'unpriced' };
  if (ep.isFree) return { kind: 'free', estimated: ep.estimated };
  return {
    kind: 'priced',
    text: `${fmtUsd(ep.inputPricePer1m)} / ${fmtUsd(ep.outputPricePer1m)} per 1M`,
    estimated: ep.estimated,
  };
}

/** Split a provider's models into the ROUTABLE rows to render and the batch twins
 * keyed by the base id they price. A twin whose base is absent from this provider
 * (`baseExternalModelId === null`) is an ORPHAN: it stays visible as its own
 * non-selectable row rather than being hidden — a model the provider lists must
 * not silently disappear. */
function splitVariants(models: Model[]): {
  rows: Model[];
  batchByBase: Map<string, Model>;
  orphans: Model[];
} {
  const batchByBase = new Map<string, Model>();
  const orphans: Model[] = [];
  const rows: Model[] = [];
  for (const m of models) {
    if (!isNonRoutableVariant(m.variant)) {
      rows.push(m);
      continue;
    }
    if (m.baseExternalModelId !== null) batchByBase.set(m.baseExternalModelId, m);
    else orphans.push(m);
  }
  return { rows, batchByBase, orphans };
}

/** add-live-subscription-models: offered models first, then the ones the provider no
 * longer lists — each group in the server's order (a stable partition, not a re-sort). */
function offeredFirst(models: Model[]): Model[] {
  return [
    ...models.filter((m) => m.unlistedSince === null),
    ...models.filter((m) => m.unlistedSince !== null),
  ];
}

/** Inline price editor for custom/local models only (#18 §7.7). Writes exactly one
 * of { isFree } or { inputPricePer1m, outputPricePer1m } — matching the server's
 * request-shape rule. */
function ModelPriceEditor(props: {
  model: Model;
  onSave: (body: ModelPricingInput) => Promise<void>;
}) {
  // Save price starts a request and stays on screen while it is in flight (D14).
  const saving = createBusy();
  const [free, setFree] = createSignal(props.model.isFree);
  const [inP, setInP] = createSignal(
    props.model.inputPricePer1m === null ? '' : String(props.model.inputPricePer1m),
  );
  const [outP, setOutP] = createSignal(
    props.model.outputPricePer1m === null ? '' : String(props.model.outputPricePer1m),
  );
  // Each price reports on its own field (task 8.2, design.md D20). One message, "Enter both
  // prices as non-negative numbers, or mark free.", used to cover the pair; it is split per
  // field, and a field holding a valid price stays quiet.
  const uid = createUniqueId();
  const inId = `${uid}-price-in`;
  const outId = `${uid}-price-out`;
  const priceProblem = (raw: string, which: 'input' | 'output'): string | null => {
    const n = Number(raw);
    return raw.trim() === '' || !Number.isFinite(n) || n < 0
      ? `Enter the ${which} price as a non-negative number, or mark free.`
      : null;
  };
  const f = createLocalFields({
    [inId]: () => priceProblem(inP(), 'input'),
    [outId]: () => priceProblem(outP(), 'output'),
  });

  const save = (): void => {
    if (free()) {
      void saving.run(() => props.onSave({ isFree: true }));
      return;
    }
    if (!f.submit([inId, outId])) return;
    void saving.run(() =>
      props.onSave({ inputPricePer1m: Number(inP()), outputPricePer1m: Number(outP()) }),
    );
  };

  return (
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
      <label class="t-caption" style="display:flex;align-items:center;gap:8px;color:var(--text3)">
        <input
          type="checkbox"
          checked={free()}
          onChange={(e) => setFree(e.currentTarget.checked)}
        />
        Free (no per-token cost)
      </label>
      <Show when={!free()}>
        <div style="display:flex;gap:8px;align-items:flex-start">
          <div style="flex:1;min-width:0">
            <input
              class="input input--figure"
              id={inId}
              style="padding:7px 8px"
              placeholder="in $/1M"
              aria-label="Input price per 1M tokens (USD)"
              value={inP()}
              aria-invalid={f.invalid(inId)}
              aria-describedby={f.describedBy(inId)}
              onBlur={() => f.check(inId)}
              onInput={(e) => {
                setInP(e.currentTarget.value);
                f.edit(inId);
              }}
            />
            <FieldNote for={inId} error={f.error(inId)} />
          </div>
          <div style="flex:1;min-width:0">
            <input
              class="input input--figure"
              id={outId}
              style="padding:7px 8px"
              placeholder="out $/1M"
              aria-label="Output price per 1M tokens (USD)"
              value={outP()}
              aria-invalid={f.invalid(outId)}
              aria-describedby={f.describedBy(outId)}
              onBlur={() => f.check(outId)}
              onInput={(e) => {
                setOutP(e.currentTarget.value);
                f.edit(outId);
              }}
            />
            <FieldNote for={outId} error={f.error(outId)} />
          </div>
        </div>
      </Show>
      <button
        type="button"
        class="btn-ghost"
        style="align-self:flex-start"
        disabled={saving.busy()}
        aria-busy={saving.busy() ? true : undefined}
        onClick={save}
      >
        <StackedLabel alt={saving.busy()} rest="Save price" altLabel="Saving…" />
      </button>
    </div>
  );
}

function ProviderCard(props: { p: Provider }) {
  const app = useApp();
  const { state } = app;
  const [open, setOpen] = createSignal(false);
  const editable = () => isPriceEditableKind(props.p.kind);
  const models = (): Model[] => state.models[props.p.id] ?? [];
  // Batch twins are folded into the models they price (add-model-variant-detection).
  // Models the provider no longer lists sort after the offered ones.
  const split = () => splitVariants(offeredFirst(models()));

  // Test and Sync models start requests and stay on screen while they run (D14): each
  // button is busy on its own, so one can be tested while another syncs.
  const testing = createBusy();
  const syncing = createBusy();

  const toggleModels = (): void => {
    const next = !open();
    setOpen(next);
    if (next) void app.loadModels(props.p.id);
  };

  // add-provider-health-signals: ONE status line, rendered from the server's
  // displayed health (never re-derived here), stated in text — never colour alone.
  //
  // classify-plan-quota-errors (design D11): while the card shows an unexpired plan pause, ONE
  // timer fires at its end and bumps `now`, which the view reads, so the line returns to the
  // displayed health at that instant with no list reload. `until` is read inside the effect, so
  // a reload that moves the end re-arms it; cleanup clears it. The end is clamped to 7 days by
  // the store, far below the timer's 2^31-1 ms limit.
  const [now, setNow] = createSignal(Date.now());
  const clock = (): number => Math.max(Date.now(), now());
  createEffect(() => {
    const until = Date.parse(props.p.planCooldown?.until ?? '');
    if (Number.isNaN(until)) return;
    const wait = until - Date.now();
    // A delay past the timer's 2^31-1 ms limit would fire at once. The store clamps an end to
    // 7 days, so this never holds in practice; if it did, the line would simply stay until the
    // next list load.
    if (wait <= 0 || wait > MAX_TIMER_MS) return;
    // `max`: a timer may fire a tick early, and the pause must be over when the line says so.
    const timer = setTimeout(() => setNow(Math.max(Date.now(), until)), wait);
    onCleanup(() => clearTimeout(timer));
  });
  const view = () =>
    providerHealthView(props.p, clock(), state.reconnectChecking.includes(props.p.id));
  const pause = () => activePause(props.p, clock());

  // add-subscription-quota-display (design D10): the plan-usage line, and the Refresh usage button's
  // cooldown, change by themselves at one instant: the earliest future window reset, or the end
  // of the refresh cooldown. ONE timer is armed for it, for at most 24 hours: a reset can be a
  // month away, beyond setTimeout's 2^31-1 ms limit, where the browser fires at once. When it
  // fires, `now` moves, this effect re-runs and arms the next one, so a far reset costs a bounded
  // number of timers and still flips at its own instant. The reset and the end are read inside the
  // effect, so a reload that moves one re-arms it; cleanup clears it.
  createEffect(() => {
    const next = nextTickAt(props.p, clock());
    if (next === null) return;
    const wait = Math.min(next - Date.now(), MAX_USAGE_TICK_MS);
    if (wait <= 0) return;
    const target = Math.min(next, Date.now() + wait);
    // `max`: a timer may fire a tick early, and a reset must have passed when the line says so.
    const timer = setTimeout(() => setNow(Math.max(Date.now(), target)), wait);
    onCleanup(() => clearTimeout(timer));
  });
  // The usage line states no health, so it never contradicts the status line: it is hidden while
  // that line says a plan pause or the reconnect banner (dashboard-core).
  const usage = createMemo(() =>
    view().banner || pause() !== null ? null : planUsageView(props.p, clock()),
  );
  // The `as of` a success states: the line's own, even while the line is hidden.
  const asOfText = (): string | null => planUsageView(props.p, clock())?.asOf ?? null;
  const refreshEnd = (): string | null => {
    const at = props.p.planUsageRefresh?.availableAt ?? null;
    return at === null ? null : fmtUntil(at, clock());
  };
  const refreshing = createBusy();
  // The last press's outcome, in words next to the button: done, or why not.
  const [refreshed, setRefreshed] = createSignal(false);
  const [refreshFailure, setRefreshFailure] = createSignal<string | null>(null);
  const uid = createUniqueId();
  const cooldownId = `${uid}-refresh-cooldown`;
  const readsId = `${uid}-refresh-reads`;
  let refreshStatus: HTMLElement | undefined;
  let refreshAlert: HTMLElement | undefined;
  const startRefresh = (): void => {
    setRefreshed(false);
    setRefreshFailure(null);
    void refreshing.run(() =>
      app.refreshPlanUsage(props.p.id).then((outcome) => {
        setRefreshed(outcome.ok);
        setRefreshFailure(outcome.ok ? null : outcome.reason);
        // The button stays disabled for the cooldown, so focus would fall to the page: it goes to
        // the outcome text instead, which is focusable for this (tabindex -1).
        (outcome.ok ? refreshStatus : refreshAlert)?.focus({ preventScroll: true });
      }),
    );
  };
  // Resume now (the pause's one action) and its in-place failure. A risk-control pause asks first,
  // in the consent confirmation; the others lift at once.
  const resuming = createBusy();
  const [resumeFailure, setResumeFailure] = createSignal<string | null>(null);
  const [confirmResume, setConfirmResume] = createSignal(false);
  const startResume = (): void => {
    setResumeFailure(null);
    void resuming.run(() =>
      app.resumeProviderPlan(props.p.id).then((reason) => {
        setResumeFailure(reason);
        if (reason !== null) return;
        // Success reloaded the list, which clears the pause: the dialog and the button go with
        // it. Focus goes to the page title once they have, never the body (a removed row's
        // does, D8).
        setConfirmResume(false);
        queueMicrotask(() => {
          const active = document.activeElement;
          if (active === null || active === document.body) pageTitle()?.focus();
        });
      }),
    );
  };
  const reconnect = (): void => void app.startOauthReauthorize(props.p);
  // add-key-subscription-presets: the key preset this row came from, from the loaded offered
  // list. Absent (a since-disabled preset, or a failed load) falls back to the generic wording.
  const keyPresetOf = () => state.kp.presets.find((x) => x.id === props.p.keyPreset);

  /** Delete asks first, in the shared destructive confirmation (adopt-red-destructive-actions
   * D6 / D7). The card, and with it this trigger, goes on success (and the card list with
   * the last one), so focus lands on the page title (D8). */
  const remove = (): void => {
    app.confirmDestructive({
      title: `Delete provider "${props.p.name}"?`,
      body: 'Its models and routing entries go too.',
      commitLabel: 'Delete provider',
      busyLabel: 'Deleting…',
      run: () => app.deleteProvider(props.p.id, FROM_DIALOG),
      fallbackFocus: pageTitle,
    });
  };

  /** The open model list: where focus lands when a model's Remove took its own row (D8).
   * It stays while the card does, whichever model went. A model's Remove (both sites below)
   * counts what it affects, then asks in the shared confirmation, which the store opens. */
  let modelList: HTMLDivElement | undefined;
  const removed = { fallbackFocus: (): HTMLElement | null => modelList ?? null };

  return (
    <div class="panel card" style="display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:8px">
          <span
            aria-hidden="true"
            style={{
              width: '8px',
              height: '8px',
              'border-radius': '50%',
              background: toneDotColor(view().tone),
              flex: 'none',
            }}
          />
          <span style="font:500 0.8125rem/1.25rem 'Geist',sans-serif;color:var(--text)">
            {props.p.name}
          </span>
        </div>
        <span class="chip" style="font:500 0.6875rem/1rem 'Geist',sans-serif;color:var(--text3)">
          {providerKindLabel(props.p.kind)}
        </span>
      </div>
      {/* ONE status slot: the reconnect-required banner, or the health line. */}
      <Show
        when={view().banner}
        fallback={
          <div
            data-health-line
            style={{
              font: "400 0.75rem/1rem 'Geist',sans-serif",
              color: toneTextColor(view().tone),
            }}
          >
            {view().text}
          </div>
        }
      >
        {/* Caution (D15): the reconnect-required condition still holds, so the notice stays
            until a reconnect clears it, with the one Reconnect the card offers in this state. */}
        <Notice
          data-health-line
          tone="caution"
          title="Reconnect needed"
          action={{ label: 'Reconnect', onClick: reconnect }}
        >
          {view().text}
        </Notice>
      </Show>
      <Show when={pause()}>
        {(active) => (
          <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px">
            <button
              type="button"
              class="btn-cancel"
              disabled={resuming.busy()}
              aria-busy={resuming.busy() ? true : undefined}
              onClick={() => {
                if (active().kind === 'risk_control') setConfirmResume(true);
                else startResume();
              }}
            >
              <StackedLabel alt={resuming.busy()} rest="Resume now" altLabel="Resuming…" />
            </button>
            <Show when={!confirmResume() && resumeFailure()}>
              {(reason) => (
                <span role="alert" class="t-caption" style="color:var(--red-text)">
                  {reason()}
                </span>
              )}
            </Show>
          </div>
        )}
      </Show>
      <Show when={confirmResume() && pause()}>
        {/* The risk-control pause asks first. A consent confirmation, never the destructive
            dialog: its commit is the Primary, and Red Fill is reserved for a destructive
            commit. It stays open on a failure, and closes when the list reload clears the
            pause. */}
        <ConsentConfirm
          title={`Resume ${props.p.name}?`}
          body="The provider throttled this account under its own risk-control policy. Sending requests again early may make the provider restrict the account further."
          commitLabel="Resume provider"
          busyLabel="Resuming…"
          busy={resuming.busy()}
          failure={resumeFailure()}
          onCancel={() => {
            setResumeFailure(null);
            setConfirmResume(false);
          }}
          onConfirm={startResume}
        />
      </Show>
      <div class="mono t-caption" style="color:var(--text3);word-break:break-all">
        {props.p.baseUrl ?? '—'}
      </div>
      <div class="t-caption" style="color:var(--text3)">
        {props.p.hasCredential ? 'credential set (encrypted)' : 'no credential'}
      </div>

      <Show when={props.p.oauthPreset !== null && !view().banner}>
        <div data-token-line class="t-caption" style="color:var(--text3)">
          Signed in · renews automatically{expiresLabel(props.p.credentialExpiresAt)}
        </div>
      </Show>

      <Show when={usage() !== null || props.p.planUsageRefresh !== null}>
        {/* add-subscription-quota-display: ONE neutral usage line, in the token line's caption
            tone, never green, red or amber; the billing phrase alone is Ink 2. The model buckets
            sit in a native disclosure. Refresh usage is a ghost button on the same row, wrapping
            under the line at narrow widths. */}
        <div
          data-usage
          class="rs-wrap"
          style="display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px"
        >
          <Show when={usage()}>
            {(u) => (
              <div style="flex:1 1 auto;min-width:0">
                <div
                  data-usage-line
                  class="t-caption"
                  style="color:var(--text3);overflow-wrap:anywhere"
                >
                  <Show when={u().billingPhrase}>
                    {(phrase) => (
                      <>
                        <span data-usage-billing style="color:var(--text2)">
                          {phrase()}
                        </span>
                        {' · '}
                      </>
                    )}
                  </Show>
                  {u().body}
                </div>
                <Show when={u().buckets.length > 0}>
                  <details data-usage-buckets class="t-caption" style="color:var(--text3)">
                    <summary>{`model limits (${String(u().buckets.length)})`}</summary>
                    <ul style="margin:4px 0 0;padding-left:16px">
                      <For each={u().buckets}>{(b) => <li>{b.text}</li>}</For>
                    </ul>
                  </details>
                </Show>
              </div>
            )}
          </Show>
          <Show when={props.p.planUsageRefresh !== null}>
            <div style="display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;min-width:0;max-width:100%">
              {/* `max-width:100%`: a provider card can be narrower than the label at a phone's
                  width (two columns of 108px at 320), so the label wraps rather than overflowing. */}
              <button
                type="button"
                class="btn-ghost"
                style="max-width:100%"
                disabled={refreshing.busy() || refreshEnd() !== null}
                aria-busy={refreshing.busy() ? true : undefined}
                aria-describedby={refreshEnd() !== null ? `${readsId} ${cooldownId}` : readsId}
                onClick={startRefresh}
              >
                <StackedLabel alt={refreshing.busy()} rest="Refresh usage" altLabel="Refreshing…" />
              </button>
              <span id={readsId} class="sr-only">
                Reads usage from the provider’s usage endpoint. Makes no model call.
              </span>
              <span class="t-caption" style="color:var(--text3)">
                <Show when={refreshEnd()}>
                  {(end) => <span id={cooldownId}>{`next refresh ${end()}`}</span>}
                </Show>
                {/* A polite status region that stays in the document, so a screen reader
                    announces its text when it changes. Focusable from script only. */}
                <span
                  ref={(el) => {
                    refreshStatus = el;
                  }}
                  role="status"
                  tabindex="-1"
                  data-usage-refresh-status
                >
                  <Show when={refreshed()}>
                    {`Usage refreshed${asOfText() === null ? '' : ` · as of ${asOfText() ?? ''}`}`}
                  </Show>
                </span>
                <Show when={refreshFailure()}>
                  {(reason) => (
                    <span
                      ref={(el) => {
                        refreshAlert = el;
                      }}
                      role="alert"
                      tabindex="-1"
                      data-usage-refresh-failure
                    >
                      {`Couldn’t refresh usage. ${reason()}`}
                    </span>
                  )}
                </Show>
              </span>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={props.p.kind === 'subscription'}>
        {/* Caution (D15; CLAUDE.md compliance note): the terms risk holds for as long as the
            provider is a subscription, so the notice has no dismiss. */}
        <Notice
          tone="caution"
          title="Terms risk"
          action={{
            label: 'Add a pay-per-token fallback',
            onClick: () => app.openModal('newProvider'),
          }}
        >
          <Show
            when={keyPresetOf()}
            fallback={
              <>
                Reusing a flat-rate subscription may violate the provider’s ToS.
                {props.p.keyPreset !== null ? ` (Preset: ${props.p.keyPreset}.)` : ''}
              </>
            }
          >
            {(preset) => (
              <>
                {preset().displayName}: {preset().termsRisk} terms risk. {preset().riskCopy}
              </>
            )}
          </Show>
        </Notice>
      </Show>

      <div style="display:flex;gap:8px;margin-top:4px;flex-wrap:wrap">
        <button
          type="button"
          class="btn-ghost"
          disabled={testing.busy()}
          aria-busy={testing.busy() ? true : undefined}
          onClick={() => void testing.run(() => app.testProviderById(props.p.id))}
        >
          <StackedLabel alt={testing.busy()} rest="Test" altLabel="Testing…" />
        </button>
        <button
          type="button"
          class="btn-ghost"
          disabled={syncing.busy()}
          aria-busy={syncing.busy() ? true : undefined}
          onClick={() => void syncing.run(() => app.syncProvider(props.p.id))}
        >
          <StackedLabel alt={syncing.busy()} rest="Sync models" altLabel="Syncing…" />
        </button>
        <button type="button" class="btn-ghost" onClick={toggleModels} aria-expanded={open()}>
          {open() ? 'Hide models' : 'Models'}
        </button>
        {/* The banner carries Reconnect in the reconnect-required state — one per card. */}
        <Show when={props.p.oauthPreset !== null && !view().banner}>
          <button type="button" class="btn-ghost" onClick={reconnect}>
            Reconnect
          </button>
        </Show>
        <button type="button" class="btn-ghost" onClick={() => app.openEditProvider(props.p)}>
          Edit
        </button>
        <button type="button" class="btn-ghost btn-ghost--destructive" onClick={remove}>
          Delete
        </button>
      </div>

      <Show when={open()}>
        {/* A named group, focusable from script only: a removed model's landing spot (D8). */}
        <div
          ref={(el) => {
            modelList = el;
          }}
          role="group"
          aria-label={`${props.p.name} models`}
          tabindex="-1"
          style="display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--border2);padding-top:8px"
        >
          <Show
            when={models().length > 0}
            fallback={
              <div class="t-caption" style="color:var(--text3)">
                No models synced yet — run “Sync models”.
              </div>
            }
          >
            <For each={split().rows}>
              {(m) => (
                <div
                  style="display:flex;flex-direction:column;gap:4px"
                  data-unlisted={m.unlistedSince !== null ? m.externalModelId : undefined}
                >
                  <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px">
                    <span
                      class="mono"
                      style={{
                        font: "500 0.75rem/1rem 'Geist Mono',monospace",
                        color: m.unlistedSince !== null ? 'var(--text3)' : 'var(--text)',
                      }}
                    >
                      {m.displayName ?? m.externalModelId}
                    </span>
                    <span
                      class="figure"
                      style={{
                        font: "400 0.6875rem/1rem 'Geist',sans-serif",
                        'font-variant-numeric': 'tabular-nums',
                        // The line's ink is Ink 3; only a free price's `free` is green.
                        color: 'var(--text3)',
                      }}
                      data-price-line={m.externalModelId}
                    >
                      <FigureText parts={priceText(m)} />
                    </span>
                  </div>
                  {/* add-live-subscription-models: the provider's latest listing no longer
                      offers this model. Stated in words, grey — routing still sends to it,
                      so this is information and a way to clean up, not an alarm. */}
                  <Show when={m.unlistedSince}>
                    {(since) => (
                      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
                        <span
                          data-unlisted-line
                          title={unlistedText(since()).label}
                          aria-label={unlistedText(since()).label}
                          class="t-caption"
                          style="color:var(--text3)"
                        >
                          {unlistedText(since()).line}
                        </span>
                        <button
                          type="button"
                          class="btn-ghost btn-ghost--destructive"
                          style="flex:none"
                          aria-label={`Remove ${m.displayName ?? m.externalModelId}`}
                          onClick={() => void app.removeUnlistedModel(props.p.id, m, removed)}
                        >
                          Remove
                        </button>
                      </div>
                    )}
                  </Show>
                  <Show
                    when={editable()}
                    fallback={
                      <div class="t-caption" style="color:var(--text3)">
                        {priceProvenance(m)}
                      </div>
                    }
                  >
                    <ModelPriceEditor
                      model={m}
                      onSave={(body) => app.setModelPrice(props.p.id, m.id, body)}
                    />
                  </Show>
                  {/* The batch twin's rate rides ON this row (add-model-variant-
                      detection): the discount is real information, but the twin can
                      only be reached through the provider's batch API, so it is
                      never offered as a target. */}
                  <Show when={split().batchByBase.get(m.externalModelId)}>
                    {(twin) => (
                      <div
                        data-batch-rate={m.externalModelId}
                        class="t-caption"
                        style="color:var(--text3)"
                      >
                        <FigureText parts={batchRateText(m.batchEffectivePrice)} /> · not routable
                        {/* add-live-subscription-models: a batch twin the provider stopped
                            listing says so on the rate line it is shown as. */}
                        <Show when={twin().unlistedSince}>
                          {(since) => (
                            <span
                              data-unlisted-twin={twin().externalModelId}
                              title={unlistedText(since()).label}
                            >
                              {' '}
                              · no longer offered
                              <span class="sr-only"> since {unlistedText(since()).day}</span>
                            </span>
                          )}
                        </Show>
                      </div>
                    )}
                  </Show>
                </div>
              )}
            </For>
            {/* An orphan twin (its base model is not on this provider) stays VISIBLE
                as a non-selectable row: hiding a model the provider lists would be
                the same dishonesty from the other direction. */}
            <For each={split().orphans}>
              {(m) => (
                <div
                  data-orphan-batch={m.externalModelId}
                  style="display:flex;align-items:baseline;justify-content:space-between;gap:8px"
                >
                  <span class="mono t-label" style="color:var(--text3)">
                    {m.displayName ?? m.externalModelId}
                  </span>
                  <span class="t-caption" style="color:var(--text3)">
                    batch-only · not routable
                    <Show when={m.unlistedSince}>
                      {(since) => (
                        <span title={unlistedText(since()).label}>
                          {' '}
                          · no longer offered
                          <span class="sr-only"> since {unlistedText(since()).day}</span>
                        </span>
                      )}
                    </Show>
                  </span>
                  {/* An orphan twin has no base row to ride on — its Remove lives here. */}
                  <Show when={m.unlistedSince !== null}>
                    <button
                      type="button"
                      class="btn-ghost btn-ghost--destructive"
                      style="flex:none"
                      aria-label={`Remove ${m.displayName ?? m.externalModelId}`}
                      onClick={() => void app.removeUnlistedModel(props.p.id, m, removed)}
                    >
                      Remove
                    </button>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  );
}

export function Providers() {
  const app = useApp();
  const { state } = app;
  // add-provider-health-signals: health is recorded elsewhere (live traffic, the
  // refresh sweep), so the list is reloaded when the page opens and whenever its tab
  // becomes visible again — never only at login.
  onMount(() => {
    void app.loadProviders();
    // The preset list names each key-preset card's terms risk.
    void app.loadKeyPresets();
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void app.loadProviders();
    };
    document.addEventListener('visibilitychange', onVisible);
    onCleanup(() => document.removeEventListener('visibilitychange', onVisible));
  });
  return (
    <div class="rs-page" style="display:flex;flex-direction:column;gap:24px;max-width:1200px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="t-body" style="color:var(--text3)">
          Your keys, your accounts — requests go straight from this box to the provider.
        </div>
        <button type="button" class="btn-primary" onClick={() => app.openModal('newProvider')}>
          Add provider
        </button>
      </div>
      <Show when={state.providersError}>
        <div class="t-caption" style="color:var(--red-text)">
          Couldn’t load providers: {state.providersError}
        </div>
      </Show>
      <Show
        when={state.providers.length > 0}
        fallback={
          <div class="panel card t-body" style="color:var(--text3)">
            No providers yet. Add one to sync its models and start routing.
          </div>
        }
      >
        <div class="rs-grid-3" style="display:grid;gap:16px">
          <For each={state.providers}>{(p) => <ProviderCard p={p} />}</For>
        </div>
      </Show>
      <div class="t-caption" style="color:var(--text3);padding:0 4px">
        Custom base URLs are SSRF-checked — private and metadata ranges are rejected. Credentials
        are encrypted at rest and never shown back.
      </div>
    </div>
  );
}
