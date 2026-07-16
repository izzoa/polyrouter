import { createSignal, For, Show } from 'solid-js';
import type { ModelPricingInput } from '../data/api';
import { isPriceEditableKind, providerKindLabel } from '../state/appState';
import { useApp } from '../state/context';
import type { Model, Provider, ProviderStatus } from '../types';

function statusColor(s: ProviderStatus): string {
  return s === 'ok' ? 'var(--green)' : s === 'error' ? 'var(--red)' : 'var(--faint)';
}

function statusLabel(s: ProviderStatus): string {
  return s === 'ok' ? 'Healthy' : s === 'error' ? 'Last action failed' : 'Not tested yet';
}

function priceText(m: Model): string {
  if (m.isFree) return 'free';
  if (m.inputPricePer1m === null || m.outputPricePer1m === null) return 'catalog price';
  return `$${String(m.inputPricePer1m)} / $${String(m.outputPricePer1m)} per 1M`;
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
            value={inP()}
            onInput={(e) => setInP(e.currentTarget.value)}
          />
          <input
            class="input mono"
            style="font:400 11px 'Geist Mono',monospace;padding:5px 8px"
            placeholder="out $/1M"
            value={outP()}
            onInput={(e) => setOutP(e.currentTarget.value)}
          />
        </div>
      </Show>
      <Show when={err()}>
        <div style="font:400 10.5px 'Geist',sans-serif;color:var(--red)">{err()}</div>
      </Show>
      <div class="btn-ghost" style="align-self:flex-start" onClick={save}>
        Save price
      </div>
    </div>
  );
}

function ProviderCard(props: { p: Provider }) {
  const app = useApp();
  const { state } = app;
  const [open, setOpen] = createSignal(false);
  const editable = () => isPriceEditableKind(props.p.kind);
  const models = (): Model[] => state.models[props.p.id] ?? [];

  const toggleModels = (): void => {
    const next = !open();
    setOpen(next);
    if (next) void app.loadModels(props.p.id);
  };

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
            style={{
              width: '8px',
              height: '8px',
              'border-radius': '50%',
              background: statusColor(props.p.status),
              flex: 'none',
            }}
          />
          <span style="font:500 13.5px 'Geist',sans-serif;color:var(--text)">{props.p.name}</span>
        </div>
        <span class="chip" style="font:500 10.5px 'Geist',sans-serif;color:var(--text3)">
          {providerKindLabel(props.p.kind)}
        </span>
      </div>
      <div style={{ font: "400 11.5px 'Geist',sans-serif", color: statusColor(props.p.status) }}>
        {statusLabel(props.p.status)}
      </div>
      <div
        class="mono"
        style="font:400 11px 'Geist Mono',monospace;color:var(--text3);word-break:break-all"
      >
        {props.p.baseUrl ?? '—'}
      </div>
      <div style="font:400 11px 'Geist',sans-serif;color:var(--text3)">
        {props.p.hasCredential ? 'credential set (encrypted)' : 'no credential'}
      </div>

      <Show when={props.p.kind === 'subscription'}>
        <div style="font:400 11px 'Geist',sans-serif;color:var(--amber);background:var(--amber-bg);border-radius:7px;padding:8px 10px;line-height:1.5">
          Reusing a flat-rate subscription may violate the provider’s ToS.{' '}
          <span
            class="link-accent"
            style="color:var(--amber)"
            onClick={() => app.openModal('newProvider')}
          >
            Add a pay-per-token fallback
          </span>
          .
        </div>
      </Show>

      <div style="display:flex;gap:6px;margin-top:2px;flex-wrap:wrap">
        <div class="btn-ghost" onClick={() => void app.testProviderById(props.p.id)}>
          Test
        </div>
        <div class="btn-ghost" onClick={() => void app.syncProvider(props.p.id)}>
          Sync models
        </div>
        <div class="btn-ghost" onClick={toggleModels}>
          {open() ? 'Hide models' : 'Models'}
        </div>
        <div class="btn-ghost btn-ghost--amber" onClick={remove}>
          Delete
        </div>
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
            <For each={models()}>
              {(m) => (
                <div style="display:flex;flex-direction:column;gap:2px">
                  <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px">
                    <span
                      class="mono"
                      style="font:500 11.5px 'Geist Mono',monospace;color:var(--text)"
                    >
                      {m.displayName ?? m.externalModelId}
                    </span>
                    <span
                      class="mono"
                      style={{
                        font: "400 10.5px 'Geist Mono',monospace",
                        color: m.isFree ? 'var(--green)' : 'var(--text3)',
                      }}
                    >
                      {priceText(m)}
                    </span>
                  </div>
                  <Show
                    when={editable()}
                    fallback={
                      <div style="font:400 10px 'Geist',sans-serif;color:var(--faint)">
                        Prices come from the bundled catalog for known providers.
                      </div>
                    }
                  >
                    <ModelPriceEditor
                      model={m}
                      onSave={(body) => void app.setModelPrice(props.p.id, m.id, body)}
                    />
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
  return (
    <div style="padding:22px 26px;display:flex;flex-direction:column;gap:14px;max-width:1200px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="font:400 12.5px 'Geist',sans-serif;color:var(--text3)">
          Your keys, your accounts — requests go straight from this box to the provider.
        </div>
        <div class="btn-primary" onClick={() => app.openModal('newProvider')}>
          Add provider
        </div>
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
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
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
