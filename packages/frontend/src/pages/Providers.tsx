import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { ModelPricingInput } from '../data/api';
import { fmtUsd } from '../data/format';
import { unlistedText } from '../data/unlisted';
import { isPriceEditableKind, providerKindLabel } from '../state/appState';
import { isNonRoutableVariant } from '@polyrouter/shared';
import { useApp } from '../state/context';
import type { Model, Provider } from '../types';
import { providerHealthView, type HealthTone } from '../data/providerHealth';

/** The status DOT's fill, by the health line's tone (add-provider-health-signals). */
function toneDotColor(tone: HealthTone): string {
  return tone === 'green' ? 'var(--green)' : tone === 'red' ? 'var(--red)' : 'var(--text3)';
}

/** The status LABEL's text colour. Split from the dot because the fill green is only
 * 2.7:1 on white — fine for a 6px dot, a WCAG failure for an 11.5px label. */
function toneTextColor(tone: HealthTone): string {
  return tone === 'green' ? 'var(--green-text)' : tone === 'red' ? 'var(--red)' : 'var(--text3)';
}

/** The effective display price — resolved server-side (billing resolver, then the
 * provider-listed estimate). `null` means genuinely unpriced. */
function priceText(m: Model): string {
  const ep = m.effectivePrice;
  if (ep === null) return 'unpriced';
  if (ep.isFree) return 'free';
  return `${fmtUsd(ep.inputPricePer1m)} / ${fmtUsd(ep.outputPricePer1m)} per 1M`;
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

/** The batch-tier rate a twin carries, as a line for its base model's row
 * (add-model-variant-detection). The twin is the record of the aggregator's batch
 * price; it is shown, but never as something selectable. */
function batchRateText(twin: Model): string {
  const ep = twin.effectivePrice;
  if (ep === null) return 'batch rate — unpriced';
  if (ep.isFree) return 'batch rate — free';
  return `batch ${fmtUsd(ep.inputPricePer1m)} / ${fmtUsd(ep.outputPricePer1m)} per 1M · estimate`;
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
function ModelPriceEditor(props: { model: Model; onSave: (body: ModelPricingInput) => void }) {
  const [free, setFree] = createSignal(props.model.isFree);
  const [inP, setInP] = createSignal(
    props.model.inputPricePer1m === null ? '' : String(props.model.inputPricePer1m),
  );
  const [outP, setOutP] = createSignal(
    props.model.outputPricePer1m === null ? '' : String(props.model.outputPricePer1m),
  );
  const [err, setErr] = createSignal<string | null>(null);

  const save = (): void => {
    if (free()) {
      props.onSave({ isFree: true });
      return;
    }
    const i = Number(inP());
    const o = Number(outP());
    if (
      inP().trim() === '' ||
      outP().trim() === '' ||
      !Number.isFinite(i) ||
      !Number.isFinite(o) ||
      i < 0 ||
      o < 0
    ) {
      setErr('Enter both prices as non-negative numbers, or mark free.');
      return;
    }
    setErr(null);
    props.onSave({ inputPricePer1m: i, outputPricePer1m: o });
  };

  return (
    <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px">
      <label style="display:flex;align-items:center;gap:6px;font:400 11px 'Geist',sans-serif;color:var(--text3)">
        <input
          type="checkbox"
          checked={free()}
          onChange={(e) => setFree(e.currentTarget.checked)}
        />
        Free (no per-token cost)
      </label>
      <Show when={!free()}>
        <div style="display:flex;gap:6px;align-items:center">
          <input
            class="input mono"
            style="font:400 11px 'Geist Mono',monospace;padding:5px 8px"
            placeholder="in $/1M"
            aria-label="Input price per 1M tokens (USD)"
            value={inP()}
            onInput={(e) => setInP(e.currentTarget.value)}
          />
          <input
            class="input mono"
            style="font:400 11px 'Geist Mono',monospace;padding:5px 8px"
            placeholder="out $/1M"
            aria-label="Output price per 1M tokens (USD)"
            value={outP()}
            onInput={(e) => setOutP(e.currentTarget.value)}
          />
        </div>
      </Show>
      <Show when={err()}>
        <div style="font:400 10.5px 'Geist',sans-serif;color:var(--red)">{err()}</div>
      </Show>
      <button type="button" class="btn-ghost" style="align-self:flex-start" onClick={save}>
        Save price
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

  const toggleModels = (): void => {
    const next = !open();
    setOpen(next);
    if (next) void app.loadModels(props.p.id);
  };

  // add-provider-health-signals: ONE status line, rendered from the server's
  // displayed health (never re-derived here), stated in text — never colour alone.
  const view = () =>
    providerHealthView(props.p, Date.now(), state.reconnectChecking.includes(props.p.id));
  const reconnect = (): void => void app.startOauthReauthorize(props.p);

  const remove = (): void => {
    if (
      globalThis.confirm(
        `Delete provider "${props.p.name}"? Its models and routing entries go too.`,
      )
    ) {
      void app.deleteProvider(props.p.id);
    }
  };

  return (
    <div class="panel card" style="display:flex;flex-direction:column;gap:10px">
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
          <span style="font:500 13.5px 'Geist',sans-serif;color:var(--text)">{props.p.name}</span>
        </div>
        <span class="chip" style="font:500 10.5px 'Geist',sans-serif;color:var(--text3)">
          {providerKindLabel(props.p.kind)}
        </span>
      </div>
      {/* ONE status slot: the reconnect-required banner, or the health line. */}
      <Show
        when={view().banner}
        fallback={
          <div
            data-health-line
            style={{ font: "400 11.5px 'Geist',sans-serif", color: toneTextColor(view().tone) }}
          >
            {view().text}
          </div>
        }
      >
        <div
          data-health-line
          style="display:flex;align-items:center;gap:10px;font:400 11px 'Geist',sans-serif;color:var(--amber);background:var(--amber-bg);border-radius:7px;padding:8px 10px"
        >
          <span>{view().text}</span>
          <button
            type="button"
            class="btn-ghost"
            style="margin-left:auto;flex:none"
            onClick={reconnect}
          >
            Reconnect
          </button>
        </div>
      </Show>
      <div
        class="mono"
        style="font:400 11px 'Geist Mono',monospace;color:var(--text3);word-break:break-all"
      >
        {props.p.baseUrl ?? '—'}
      </div>
      <div style="font:400 11px 'Geist',sans-serif;color:var(--text3)">
        {props.p.hasCredential ? 'credential set (encrypted)' : 'no credential'}
      </div>

      <Show when={props.p.oauthPreset !== null && !view().banner}>
        <div data-token-line style="font:400 11px 'Geist',sans-serif;color:var(--text3)">
          Signed in · renews automatically{expiresLabel(props.p.credentialExpiresAt)}
        </div>
      </Show>

      <Show when={props.p.kind === 'subscription'}>
        <div style="font:400 11px 'Geist',sans-serif;color:var(--amber);background:var(--amber-bg);border-radius:7px;padding:8px 10px;line-height:1.5">
          Reusing a flat-rate subscription may violate the provider’s ToS.{' '}
          <button
            type="button"
            class="link-accent"
            style="color:var(--amber)"
            onClick={() => app.openModal('newProvider')}
          >
            Add a pay-per-token fallback
          </button>
          .
        </div>
      </Show>

      <div style="display:flex;gap:6px;margin-top:2px;flex-wrap:wrap">
        <button
          type="button"
          class="btn-ghost"
          onClick={() => void app.testProviderById(props.p.id)}
        >
          Test
        </button>
        <button type="button" class="btn-ghost" onClick={() => void app.syncProvider(props.p.id)}>
          Sync models
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
        <button type="button" class="btn-ghost btn-ghost--amber" onClick={remove}>
          Delete
        </button>
      </div>

      <Show when={open()}>
        <div style="display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--border2);padding-top:10px">
          <Show
            when={models().length > 0}
            fallback={
              <div style="font:400 11px 'Geist',sans-serif;color:var(--text3)">
                No models synced yet — run “Sync models”.
              </div>
            }
          >
            <For each={split().rows}>
              {(m) => (
                <div
                  style="display:flex;flex-direction:column;gap:2px"
                  data-unlisted={m.unlistedSince !== null ? m.externalModelId : undefined}
                >
                  <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px">
                    <span
                      class="mono"
                      style={{
                        font: "500 11.5px 'Geist Mono',monospace",
                        color: m.unlistedSince !== null ? 'var(--text3)' : 'var(--text)',
                      }}
                    >
                      {m.displayName ?? m.externalModelId}
                    </span>
                    <span
                      class="mono"
                      style={{
                        font: "400 10.5px 'Geist Mono',monospace",
                        color: m.effectivePrice?.isFree ? 'var(--green-text)' : 'var(--text3)',
                      }}
                    >
                      {priceText(m)}
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
                          style="font:400 10.5px 'Geist',sans-serif;color:var(--text3)"
                        >
                          {unlistedText(since()).line}
                        </span>
                        <button
                          type="button"
                          class="btn-ghost btn-ghost--amber"
                          style="flex:none"
                          aria-label={`Remove ${m.displayName ?? m.externalModelId}`}
                          onClick={() => void app.removeUnlistedModel(props.p.id, m)}
                        >
                          Remove
                        </button>
                      </div>
                    )}
                  </Show>
                  <Show
                    when={editable()}
                    fallback={
                      <div style="font:400 10px 'Geist',sans-serif;color:var(--text3)">
                        {priceProvenance(m)}
                      </div>
                    }
                  >
                    <ModelPriceEditor
                      model={m}
                      onSave={(body) => void app.setModelPrice(props.p.id, m.id, body)}
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
                        style="font:400 10px 'Geist',sans-serif;color:var(--text3)"
                      >
                        {batchRateText(twin())} · not routable
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
                  <span
                    class="mono"
                    style="font:500 11.5px 'Geist Mono',monospace;color:var(--text3)"
                  >
                    {m.displayName ?? m.externalModelId}
                  </span>
                  <span style="font:400 10px 'Geist',sans-serif;color:var(--text3)">
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
                      class="btn-ghost btn-ghost--amber"
                      style="flex:none"
                      aria-label={`Remove ${m.displayName ?? m.externalModelId}`}
                      onClick={() => void app.removeUnlistedModel(props.p.id, m)}
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
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void app.loadProviders();
    };
    document.addEventListener('visibilitychange', onVisible);
    onCleanup(() => document.removeEventListener('visibilitychange', onVisible));
  });
  return (
    <div class="rs-page" style="display:flex;flex-direction:column;gap:14px;max-width:1200px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="font:400 12.5px 'Geist',sans-serif;color:var(--text3)">
          Your keys, your accounts — requests go straight from this box to the provider.
        </div>
        <button type="button" class="btn-primary" onClick={() => app.openModal('newProvider')}>
          Add provider
        </button>
      </div>
      <Show when={state.providersError}>
        <div style="font:400 11.5px 'Geist',sans-serif;color:var(--red)">
          Couldn’t load providers: {state.providersError}
        </div>
      </Show>
      <Show
        when={state.providers.length > 0}
        fallback={
          <div class="panel card" style="font:400 12.5px 'Geist',sans-serif;color:var(--text3)">
            No providers yet. Add one to sync its models and start routing.
          </div>
        }
      >
        <div class="rs-grid-3" style="display:grid;gap:12px">
          <For each={state.providers}>{(p) => <ProviderCard p={p} />}</For>
        </div>
      </Show>
      <div style="font:400 11.5px 'Geist',sans-serif;color:var(--text3);padding:0 2px">
        Custom base URLs are SSRF-checked — private and metadata ranges are rejected. Credentials
        are encrypted at rest and never shown back.
      </div>
    </div>
  );
}
