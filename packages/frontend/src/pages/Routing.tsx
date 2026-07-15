import { createSignal, For, Show } from 'solid-js';
import { CATALOG, catalogEntry, priceOf } from '../data/catalog';
import { app } from '../state/appState';

interface DragPos {
  ti: number;
  mi: number;
}

const LAYERS = [
  {
    id: 'structural' as const,
    name: 'L1 · Structural',
    tag: '<1ms, local',
    desc: 'Language-neutral features; system prompts fingerprinted & subtracted.',
    locked: false,
  },
  {
    id: 'cascade' as const,
    name: 'L3 · Cascade',
    tag: 'cheap-first',
    desc: 'Ambiguous requests try the cheap model, escalate on a failed quality check.',
    locked: false,
  },
  {
    id: 'semantic' as const,
    name: 'L2 · Semantic',
    tag: 'cloud tier',
    desc: 'Local embedding classifier — not part of the self-host baseline.',
    locked: true,
  },
];

export function posStyle(i: number): [string, string, string] {
  return i === 0
    ? ['Primary', 'var(--accent-bg)', 'var(--accent-deep)']
    : [`Fallback ${String(i)}`, 'var(--chip)', 'var(--text3)'];
}

export function Routing() {
  const { state } = app;
  const [drag, setDrag] = createSignal<DragPos | null>(null);

  return (
    <div style="padding:22px 26px;display:flex;flex-direction:column;gap:14px;max-width:1200px">
      <div style="display:grid;grid-template-columns:2fr 1fr;gap:12px;align-items:start">
        <div style="display:flex;flex-direction:column;gap:12px">
          <For each={state.tiers}>
            {(t, ti) => (
              <div class="panel" style="overflow:hidden;border-radius:10px">
                <div style="display:flex;align-items:baseline;justify-content:space-between;padding:13px 18px;border-bottom:1px solid var(--border2)">
                  <div style="display:flex;align-items:baseline;gap:10px">
                    <span
                      class="mono"
                      style="font:500 13.5px 'Geist Mono',monospace;color:var(--text)"
                    >
                      {t.key}
                    </span>
                    <span style="font:400 12px 'Geist',sans-serif;color:var(--text3)">
                      {t.desc}
                    </span>
                  </div>
                  <span style="font:400 11px 'Geist',sans-serif;color:var(--faint)">
                    drag to reorder · max 5
                  </span>
                </div>
                <For each={t.chain}>
                  {(model, mi) => {
                    const c = catalogEntry(model);
                    const dragging = () => {
                      const d = drag();
                      return d !== null && d.ti === ti() && d.mi === mi();
                    };
                    return (
                      <div
                        class="chain-row"
                        draggable={true}
                        style={{ opacity: dragging() ? '0.4' : '1' }}
                        onDragStart={(e) => {
                          setDrag({ ti: ti(), mi: mi() });
                          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          const d = drag();
                          if (d !== null && d.ti === ti() && d.mi !== mi()) {
                            app.reorderChain(ti(), d.mi, mi());
                            setDrag({ ti: ti(), mi: mi() });
                          }
                        }}
                        onDragEnd={() => setDrag(null)}
                      >
                        <span style="color:var(--faint);font-size:13px;letter-spacing:1px;flex:none">
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
                        <span
                          class="icon-x"
                          style="font-size:14px;padding:0 2px"
                          onClick={() => app.removeFromChain(ti(), model)}
                        >
                          ×
                        </span>
                      </div>
                    );
                  }}
                </For>
                <div style="padding:8px 18px">
                  <select
                    style="background:var(--panel);border:1px dashed var(--border);border-radius:6px;padding:5px 8px;font:400 12px 'Geist',sans-serif;color:var(--text3);cursor:pointer"
                    onChange={(e) => {
                      const id = e.currentTarget.value;
                      e.currentTarget.value = '';
                      if (id) app.addToChain(ti(), id);
                    }}
                  >
                    {/* `selected` (not a value prop) keeps the placeholder shown — Solid sets the
                        value property before the options render, so a value prop never matches. */}
                    <option value="" disabled selected>
                      + Add model…
                    </option>
                    <For each={Object.keys(CATALOG).filter((id) => !t.chain.includes(id))}>
                      {(id) => <option value={id}>{`${id} — ${catalogEntry(id).p}`}</option>}
                    </For>
                  </select>
                </div>
              </div>
            )}
          </For>
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
              <For each={LAYERS}>
                {(l) => {
                  const on = () => (l.locked ? false : app.state.autoLayers[l.id]);
                  return (
                    <div
                      style={{
                        display: 'flex',
                        'align-items': 'flex-start',
                        gap: '10px',
                        opacity: l.locked ? '0.45' : '1',
                      }}
                    >
                      <div style="margin-top:1px">
                        <div
                          class="toggle"
                          style={{
                            width: '30px',
                            height: '17px',
                            background: on() ? 'var(--accent)' : 'var(--faint)',
                            cursor: l.locked ? 'not-allowed' : 'pointer',
                          }}
                          onClick={() => app.toggleLayer(l.id)}
                        >
                          <div
                            class="toggle-knob"
                            style={{ width: '13px', height: '13px', left: on() ? '15px' : '2px' }}
                          />
                        </div>
                      </div>
                      <div>
                        <div style="font:500 12px 'Geist',sans-serif;color:var(--text)">
                          {l.name}{' '}
                          <span
                            class="mono"
                            style="font:400 10.5px 'Geist Mono',monospace;color:var(--faint)"
                          >
                            {l.tag}
                          </span>
                        </div>
                        <div style="font:400 11px 'Geist',sans-serif;color:var(--text3);line-height:1.45">
                          {l.desc}
                        </div>
                      </div>
                    </div>
                  );
                }}
              </For>
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
              <For each={state.rules}>
                {(ru) => (
                  <div
                    class="mono"
                    style="display:flex;align-items:center;gap:8px;font:400 11.5px 'Geist Mono',monospace;color:var(--text2);padding:6px 9px;background:var(--bg);border:1px solid var(--border2);border-radius:6px"
                  >
                    <span style="color:var(--text3)">x-polyrouter-tier: {ru.value}</span>
                    <span style="color:var(--faint)">→</span>
                    <span style="color:var(--text)">{ru.target}</span>
                    <span
                      class="icon-x"
                      style="margin-left:auto"
                      onClick={() => app.removeRule(ru.id)}
                    >
                      ×
                    </span>
                  </div>
                )}
              </For>
              <Show when={state.rules.length === 0}>
                <div style="font:400 11.5px 'Geist',sans-serif;color:var(--faint);padding:4px 0">
                  No header rules yet.
                </div>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
