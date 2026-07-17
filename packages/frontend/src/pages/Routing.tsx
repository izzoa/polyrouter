import { createSignal, For, onMount, Show } from 'solid-js';
import { Toggle } from '../components/Toggle';
import type { AutoLayers, TierEntryDto } from '../data/api';
import { useApp } from '../state/context';
import type { Model } from '../types';

interface DragPos {
  tierId: string;
  index: number;
}

interface LayerRow {
  id: 'structural' | 'cascade';
  name: string;
  tag: string;
  desc: string;
  on: boolean;
  available: boolean;
}

export function posStyle(i: number): [string, string, string] {
  return i === 0
    ? ['Primary', 'var(--accent-bg)', 'var(--accent-deep)']
    : [`Fallback ${String(i)}`, 'var(--chip)', 'var(--text3)'];
}

function modelPriceLabel(m: Model | undefined): string {
  if (!m) return 'catalog price';
  if (m.isFree) return 'free';
  if (m.inputPricePer1m === null || m.outputPricePer1m === null) return 'catalog price';
  return `$${String(m.inputPricePer1m)} / $${String(m.outputPricePer1m)} per 1M`;
}

function structuralLayers(al: AutoLayers | null): LayerRow[] {
  return [
    {
      id: 'structural',
      name: 'L1 · Structural',
      tag: '<1ms, local',
      desc: 'Language-neutral features; system prompts fingerprinted & subtracted.',
      on: al?.structural ?? false,
      available: al?.structuralAvailable ?? false,
    },
    {
      id: 'cascade',
      name: 'L3 · Cascade',
      tag: 'cheap-first',
      desc: 'Ambiguous requests try the cheap model, escalate on a failed quality check.',
      on: al?.cascade ?? false,
      available: al?.cascadeAvailable ?? false,
    },
  ];
}

export function Routing() {
  const app = useApp();
  const { state } = app;
  const [drag, setDrag] = createSignal<DragPos | null>(null);

  onMount(() => void app.loadRouting());

  const modelById = (id: string): Model | undefined => state.allModels.find((m) => m.id === id);
  const entryLabel = (e: TierEntryDto): string =>
    e.model?.externalModelId ?? modelById(e.modelId)?.externalModelId ?? e.modelId;
  const entries = (tierId: string): TierEntryDto[] => state.tierEntries[tierId] ?? [];
  const addableModels = (tierId: string): Model[] => {
    const used = new Set(entries(tierId).map((e) => e.modelId));
    return state.allModels.filter((m) => !used.has(m.id));
  };
  // Only `header` rules are user-editable here; `auto_high`/`auto_low` drive band
  // routing and are read-only (deleting them would silently break structural/cascade).
  const headerRules = () => state.rules.filter((r) => r.matchType === 'header');

  return (
    <div style="padding:22px 26px;display:flex;flex-direction:column;gap:14px;max-width:1200px">
      <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px">
        <div style="font:400 12.5px 'Geist',sans-serif;color:var(--text3)">
          Tier chains route explicit and auto requests; position 0 is the primary, the rest are
          ordered fallbacks (max {String(5)}). Explicit model requests always win.
        </div>
        <div style="display:flex;align-items:flex-end;gap:6px">
          <div>
            <label class="field-label" for="f-tf-key" style="display:block">
              New tier key
            </label>
            <input
              class="input mono"
              id="f-tf-key"
              style="font:400 12px 'Geist Mono',monospace;width:150px"
              placeholder="e.g. heavy"
              value={state.tf.key}
              onInput={(e) => app.setState('tf', 'key', e.currentTarget.value)}
            />
          </div>
          <button
            type="button"
            class="btn-primary"
            disabled={state.tf.busy}
            onClick={() => void app.createTier()}
          >
            {state.tf.busy ? 'Adding…' : 'Add tier'}
          </button>
        </div>
      </div>
      <Show when={state.tf.error}>
        <div style="font:400 11px 'Geist',sans-serif;color:var(--red)">{state.tf.error}</div>
      </Show>
      <Show when={state.routingError}>
        <div style="display:flex;align-items:center;gap:10px;padding:9px 14px;background:var(--red-bg);border:1px solid var(--red);border-radius:8px;font:500 12px 'Geist',sans-serif;color:var(--red)">
          <span style="flex:1">Couldn’t load routing — {state.routingError}</span>
          <button
            type="button"
            class="link-accent"
            style="font-weight:600"
            onClick={() => void app.loadRouting()}
          >
            Retry
          </button>
        </div>
      </Show>

      <div style="display:grid;grid-template-columns:2fr 1fr;gap:12px;align-items:start">
        <div style="display:flex;flex-direction:column;gap:12px">
          <Show
            when={state.routingTiers.length > 0}
            fallback={
              <div class="panel card" style="font:400 12.5px 'Geist',sans-serif;color:var(--text3)">
                {state.routingLoading ? 'Loading tiers…' : 'No tiers yet.'}
              </div>
            }
          >
            <For each={state.routingTiers}>
              {(t) => (
                <div class="panel" style="overflow:hidden;border-radius:10px">
                  <div style="display:flex;align-items:baseline;justify-content:space-between;padding:13px 18px;border-bottom:1px solid var(--border2)">
                    <div style="display:flex;align-items:baseline;gap:10px">
                      <span
                        class="mono"
                        style="font:500 13.5px 'Geist Mono',monospace;color:var(--text)"
                      >
                        {t.key}
                      </span>
                      <Show when={t.displayName ?? t.description}>
                        <span style="font:400 12px 'Geist',sans-serif;color:var(--text3)">
                          {t.displayName ?? t.description}
                        </span>
                      </Show>
                    </div>
                    <div style="display:flex;align-items:center;gap:10px">
                      <span style="font:400 11px 'Geist',sans-serif;color:var(--text3)">
                        drag to reorder · max {String(5)}
                      </span>
                      <Show when={t.key !== 'default'}>
                        <button
                          type="button"
                          class="icon-x"
                          aria-label={`Delete tier ${t.key}`}
                          onClick={() => void app.deleteTier(t.id)}
                        >
                          Delete
                        </button>
                      </Show>
                    </div>
                  </div>
                  <For each={entries(t.id)}>
                    {(entry, mi) => {
                      const dragging = (): boolean => {
                        const d = drag();
                        return d !== null && d.tierId === t.id && d.index === mi();
                      };
                      return (
                        <div
                          class="chain-row"
                          draggable={true}
                          style={{ opacity: dragging() ? '0.4' : '1' }}
                          onDragStart={(e) => {
                            setDrag({ tierId: t.id, index: mi() });
                            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
                          }}
                          onDragOver={(e) => {
                            e.preventDefault();
                            const d = drag();
                            if (d !== null && d.tierId === t.id && d.index !== mi()) {
                              app.moveTierEntry(t.id, d.index, mi());
                              setDrag({ tierId: t.id, index: mi() });
                            }
                          }}
                          onDragEnd={() => {
                            const d = drag();
                            if (d !== null) void app.commitTierOrder(t.id);
                            setDrag(null);
                          }}
                        >
                          <span
                            aria-hidden="true"
                            style="color:var(--faint);font-size:13px;letter-spacing:1px;flex:none"
                          >
                            ⋮⋮
                          </span>
                          <span
                            class="pos-badge"
                            style={{ background: posStyle(mi())[1], color: posStyle(mi())[2] }}
                          >
                            {posStyle(mi())[0]}
                          </span>
                          <span
                            class="mono"
                            style="font:500 12px 'Geist Mono',monospace;color:var(--text);min-width:150px"
                          >
                            {entryLabel(entry)}
                          </span>
                          <span
                            class="mono"
                            style="margin-left:auto;font:400 11px 'Geist Mono',monospace;color:var(--text3)"
                          >
                            {modelPriceLabel(modelById(entry.modelId))}
                          </span>
                          <Show when={mi() > 0}>
                            <button
                              type="button"
                              class="link-accent"
                              style="font:400 11px 'Geist',sans-serif"
                              onClick={() => app.setPrimaryTierModel(t.id, entry.modelId)}
                            >
                              Make primary
                            </button>
                          </Show>
                          <button
                            type="button"
                            class="icon-x"
                            style="font-size:14px;padding:0 2px"
                            aria-label={`Remove ${entryLabel(entry)} from tier ${t.key}`}
                            onClick={() => app.removeTierModel(t.id, entry.modelId)}
                          >
                            ×
                          </button>
                        </div>
                      );
                    }}
                  </For>
                  <Show when={entries(t.id).length === 0}>
                    <div style="padding:9px 18px;font:400 11.5px 'Geist',sans-serif;color:var(--text3)">
                      No models — add one below.
                    </div>
                  </Show>
                  <div style="padding:8px 18px">
                    <select
                      class="select"
                      aria-label={`Add model to tier ${t.key}`}
                      style="border:1px dashed var(--border);width:auto;color:var(--text3);cursor:pointer;padding:5px 8px;font:400 12px 'Geist',sans-serif"
                      onChange={(e) => {
                        const id = e.currentTarget.value;
                        e.currentTarget.value = '';
                        if (id) app.addTierModel(t.id, id);
                      }}
                    >
                      <option value="" disabled selected>
                        + Add model…
                      </option>
                      <For each={addableModels(t.id)}>
                        {(m) => (
                          <option
                            value={m.id}
                          >{`${m.externalModelId} — ${modelPriceLabel(m)}`}</option>
                        )}
                      </For>
                    </select>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </div>

        <div style="display:flex;flex-direction:column;gap:12px">
          <div class="panel card">
            <div class="section-title" style="margin-bottom:4px">
              Automatic routing
            </div>
            <div style="font:400 11.5px 'Geist',sans-serif;color:var(--text3);margin-bottom:12px;line-height:1.5">
              Applies only when an agent asks for model{' '}
              <span
                class="mono"
                style="font-size:11px;background:var(--chip);padding:1px 5px;border-radius:4px"
              >
                auto
              </span>
              . Explicit requests always win.
            </div>
            <div style="display:flex;flex-direction:column;gap:10px">
              <For each={structuralLayers(state.autoLayers)}>
                {(l) => (
                  <div style={{ display: 'flex', 'align-items': 'flex-start', gap: '10px' }}>
                    <div style="margin-top:1px">
                      <Toggle
                        on={l.on}
                        locked={!l.available}
                        label={`Toggle ${l.name}`}
                        onToggle={() => void app.toggleAutoLayer(l.id)}
                      />
                    </div>
                    <div style={{ opacity: l.available ? '1' : '0.55' }}>
                      <div style="font:500 12px 'Geist',sans-serif;color:var(--text)">
                        {l.name}{' '}
                        <span
                          class="mono"
                          style="font:400 10.5px 'Geist Mono',monospace;color:var(--text3)"
                        >
                          {l.tag}
                        </span>
                      </div>
                      <div style="font:400 11px 'Geist',sans-serif;color:var(--text3);line-height:1.45">
                        {l.desc}
                      </div>
                      <Show when={!l.available}>
                        <div
                          class="mono"
                          style="font:400 10px 'Geist Mono',monospace;color:var(--amber);margin-top:2px"
                        >
                          off instance-wide (ROUTING_AUTO_LAYERS)
                        </div>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
              <div
                style={{
                  display: 'flex',
                  'align-items': 'flex-start',
                  gap: '10px',
                  opacity: '0.45',
                }}
              >
                <div style="margin-top:1px">
                  <Toggle
                    on={false}
                    locked={true}
                    label="Toggle L2 · Semantic (cloud tier only)"
                    onToggle={() => undefined}
                  />
                </div>
                <div>
                  <div style="font:500 12px 'Geist',sans-serif;color:var(--text)">
                    L2 · Semantic{' '}
                    <span
                      class="mono"
                      style="font:400 10.5px 'Geist Mono',monospace;color:var(--text3)"
                    >
                      cloud tier
                    </span>
                  </div>
                  <div style="font:400 11px 'Geist',sans-serif;color:var(--text3);line-height:1.45">
                    Local embedding classifier — not part of the self-host baseline.
                  </div>
                </div>
              </div>
            </div>
            <div style="margin-top:12px;padding:9px 11px;background:var(--accent-bg);border-radius:7px;font:400 11px 'Geist',sans-serif;color:var(--text2);line-height:1.5">
              If a smart layer is down,{' '}
              <span class="mono" style="font-size:10.5px">
                auto
              </span>{' '}
              degrades to the default tier. Requests never fail because routing got clever.
            </div>
          </div>

          <div class="panel card">
            <div class="section-title" style="margin-bottom:4px">
              Header rules
            </div>
            <div style="font:400 11.5px 'Geist',sans-serif;color:var(--text3);margin-bottom:12px">
              Force a tier per request with{' '}
              <span class="mono" style="font-size:10.5px">
                x-polyrouter-tier
              </span>
            </div>
            <div style="display:flex;flex-direction:column;gap:6px">
              <For each={headerRules()}>
                {(ru) => (
                  <div
                    class="mono"
                    style="display:flex;align-items:center;gap:8px;font:400 11.5px 'Geist Mono',monospace;color:var(--text2);padding:6px 9px;background:var(--bg);border:1px solid var(--border2);border-radius:6px"
                  >
                    <span style="color:var(--text3)">
                      {ru.headerName}: {ru.headerValue ?? ''}
                    </span>
                    <span style="color:var(--faint)">→</span>
                    <span style="color:var(--text)">{ru.target}</span>
                    <button
                      type="button"
                      class="icon-x"
                      style="margin-left:auto"
                      aria-label={`Delete rule ${ru.headerValue ?? ''} → ${ru.target}`}
                      onClick={() => void app.deleteRule(ru.id)}
                    >
                      ×
                    </button>
                  </div>
                )}
              </For>
              <Show when={headerRules().length === 0}>
                <div style="font:400 11.5px 'Geist',sans-serif;color:var(--text3);padding:4px 0">
                  No header rules yet.
                </div>
              </Show>
            </div>
            <div style="display:flex;align-items:flex-end;gap:6px;margin-top:10px">
              <div style="flex:1">
                <label class="field-label" for="f-rf-value" style="display:block">
                  Header value
                </label>
                <input
                  class="input mono"
                  id="f-rf-value"
                  style="font:400 11.5px 'Geist Mono',monospace"
                  placeholder="e.g. heavy"
                  value={state.rf.value}
                  onInput={(e) => app.setState('rf', 'value', e.currentTarget.value)}
                />
              </div>
              <div style="flex:1">
                <label class="field-label" for="f-rf-target" style="display:block">
                  Target tier
                </label>
                <select
                  class="select"
                  id="f-rf-target"
                  value={state.rf.target}
                  onChange={(e) => app.setState('rf', 'target', e.currentTarget.value)}
                >
                  <option value="" disabled selected={state.rf.target === ''}>
                    Pick a tier…
                  </option>
                  <For each={state.routingTiers}>
                    {(t) => <option value={t.key}>{t.key}</option>}
                  </For>
                </select>
              </div>
              <button
                type="button"
                class="btn-ghost"
                disabled={state.rf.busy}
                onClick={() => void app.createRule()}
              >
                {state.rf.busy ? '…' : 'Add'}
              </button>
            </div>
            <Show when={state.rf.error}>
              <div style="font:400 11px 'Geist',sans-serif;color:var(--red);margin-top:6px">
                {state.rf.error}
              </div>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}
