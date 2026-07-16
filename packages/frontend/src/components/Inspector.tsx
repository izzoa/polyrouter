import { For, Show } from 'solid-js';
import { fmtCost, fmtTime } from '../data/catalog';
import { useApp } from '../state/context';
import type { RoutedRequest, TraceState } from '../types';

/** dot bg / dot border / title color per trace-step state, from the prototype. */
const SD: Record<TraceState, [string, string, string]> = {
  hit: ['var(--accent)', 'var(--accent)', 'var(--text)'],
  ok: ['var(--green)', 'var(--green)', 'var(--text)'],
  pass: ['var(--panel)', 'var(--faint)', 'var(--text2)'],
  skip: ['var(--panel)', 'var(--border)', 'var(--text3)'],
  warn: ['var(--amber)', 'var(--amber)', 'var(--text)'],
  err: ['var(--red)', 'var(--red)', 'var(--text)'],
};

const STATUS_LABEL = {
  ok: ['OK · streamed', 'var(--green-bg)', 'var(--green)'],
  fallback: ['Fallback · served', 'var(--amber-bg)', 'var(--amber)'],
} as const;

function snapshotOf(r: RoutedRequest): string {
  if (r.tag === 'local') return '$0 (local)';
  if (r.tag === 'sub') return 'subscription quota';
  return `$${String(r.inPrice)} / $${String(r.outPrice)} /1M`;
}

export function Inspector() {
  const app = useApp();
  const { state } = app;
  const sel = () => state.requests.find((r) => r.id === state.selId);

  return (
    <Show when={sel()}>
      {(r) => (
        <>
          <div class="overlay" onClick={() => app.select(null)} />
          <div class="drawer">
            <div style="flex:none;display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border2)">
              <div>
                <div
                  class="mono"
                  style="font:600 14px 'Geist Mono',monospace;letter-spacing:-.01em;color:var(--text)"
                >
                  {r().model}
                </div>
                <div
                  class="mono"
                  style="font:400 11px 'Geist Mono',monospace;color:var(--text3);margin-top:2px"
                >
                  {r().id} · {fmtTime(r().ts)}
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:10px">
                <span
                  style={{
                    padding: '2px 9px',
                    'border-radius': '10px',
                    font: "500 11px 'Geist',sans-serif",
                    background: STATUS_LABEL[r().status][1],
                    color: STATUS_LABEL[r().status][2],
                  }}
                >
                  {STATUS_LABEL[r().status][0]}
                </span>
                <span class="drawer-close" onClick={() => app.select(null)}>
                  ✕
                </span>
              </div>
            </div>
            <div style="flex:1;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:18px">
              <div style="display:flex;align-items:center;gap:8px">
                <span style="padding:5px 10px;background:var(--chip);border-radius:7px;font:500 11.5px 'Geist',sans-serif;color:var(--text2)">
                  {r().agent}
                </span>
                <span style="color:var(--faint)">→</span>
                <span style="padding:5px 10px;background:var(--accent-bg);border-radius:7px;font:500 11.5px 'Geist',sans-serif;color:var(--accent-deep)">
                  router · {r().layer}
                </span>
                <span style="color:var(--faint)">→</span>
                <span style="padding:5px 10px;background:var(--chip);border-radius:7px;font:500 11.5px 'Geist',sans-serif;color:var(--text2)">
                  {r().provider}
                  {r().tag !== null ? ` · ${String(r().tag)}` : ''}
                </span>
              </div>
              <div>
                <div class="upper-label" style="margin-bottom:9px">
                  Decision trace
                </div>
                <div style="display:flex;flex-direction:column">
                  <For each={r().steps}>
                    {(step, i) => (
                      <div style="display:flex;gap:12px">
                        <div style="display:flex;flex-direction:column;align-items:center;flex:none;width:16px">
                          <div
                            style={{
                              width: '9px',
                              height: '9px',
                              'border-radius': '50%',
                              background: SD[step.s][0],
                              border: `2px solid ${SD[step.s][1]}`,
                              flex: 'none',
                              'margin-top': '3px',
                            }}
                          />
                          <Show when={i() < r().steps.length - 1}>
                            <div style="width:1px;flex:1;background:var(--border);margin:2px 0" />
                          </Show>
                        </div>
                        <div style="padding-bottom:14px;min-width:0">
                          <div style="display:flex;align-items:baseline;gap:7px">
                            <span
                              class="mono"
                              style="font:500 10px 'Geist Mono',monospace;color:var(--faint)"
                            >
                              {step.k}
                            </span>
                            <span
                              style={{ font: "500 12px 'Geist',sans-serif", color: SD[step.s][2] }}
                            >
                              {step.title}
                            </span>
                          </div>
                          <div style="font:400 11.5px 'Geist',sans-serif;color:var(--text3);line-height:1.5;margin-top:2px">
                            {step.d}
                          </div>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </div>
              <Show when={r().feat}>
                {(feat) => (
                  <div>
                    <div class="upper-label" style="margin-bottom:9px">
                      Structural features (L1)
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px 14px;background:var(--bg);border:1px solid var(--border2);border-radius:9px;padding:12px 14px">
                      <For each={feat()}>
                        {(f) => (
                          <div
                            class="mono"
                            style="display:flex;justify-content:space-between;gap:8px;font:400 11px 'Geist Mono',monospace"
                          >
                            <span style="color:var(--text3)">{f.k}</span>
                            <span style="color:var(--text)">{f.v}</span>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </Show>
              <div>
                <div class="upper-label" style="margin-bottom:9px">
                  Usage & cost
                </div>
                <div class="kv-box">
                  <div style="display:flex;justify-content:space-between">
                    <span style="color:var(--text3)">input tokens</span>
                    <span style="color:var(--text)">{r().tin.toLocaleString()}</span>
                  </div>
                  <div style="display:flex;justify-content:space-between">
                    <span style="color:var(--text3)">output tokens</span>
                    <span style="color:var(--text)">
                      {r().tout.toLocaleString()}
                      {r().estimated ? ' ~est' : ''}
                    </span>
                  </div>
                  <div style="display:flex;justify-content:space-between">
                    <span style="color:var(--text3)">price snapshot</span>
                    <span style="color:var(--text)">{snapshotOf(r())}</span>
                  </div>
                  <div style="display:flex;justify-content:space-between;border-top:1px solid var(--border2);padding-top:7px">
                    <span style="color:var(--text3)">cost</span>
                    <span
                      style={{
                        color: r().tag === 'local' ? 'var(--green)' : 'var(--text)',
                        'font-weight': '500',
                      }}
                    >
                      {fmtCost(r())}
                    </span>
                  </div>
                </div>
                <div style="font:400 10.5px 'Geist',sans-serif;color:var(--faint);margin-top:6px">
                  {r().estimated
                    ? 'Provider omitted usage — output estimated from stream, flagged ~.'
                    : 'Token counts from provider usage; unit prices snapshotted at request time.'}
                </div>
              </div>
              <div>
                <div class="upper-label" style="margin-bottom:9px">
                  Timing
                </div>
                <div class="kv-box">
                  <div style="display:flex;justify-content:space-between">
                    <span style="color:var(--text3)">routing decision</span>
                    <span style="color:var(--text)">
                      {r().routeMs === 0 ? '0ms (explicit path)' : '<1ms (L1 structural)'}
                    </span>
                  </div>
                  <div style="display:flex;justify-content:space-between">
                    <span style="color:var(--text3)">first token</span>
                    <span style="color:var(--text)">{(r().ttfb / 1000).toFixed(1)}s</span>
                  </div>
                  <div style="display:flex;justify-content:space-between">
                    <span style="color:var(--text3)">total</span>
                    <span style="color:var(--text)">{(r().ms / 1000).toFixed(2)}s</span>
                  </div>
                  <div style="display:flex;justify-content:space-between">
                    <span style="color:var(--text3)">protocol</span>
                    <span style="color:var(--text)">
                      {r().provider === 'Anthropic' || r().provider === 'Claude Max'
                        ? 'openai → anthropic (translated)'
                        : 'openai passthrough'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </Show>
  );
}
