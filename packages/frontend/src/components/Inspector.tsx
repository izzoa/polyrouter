import { createMemo, For, onCleanup, onMount, Show } from 'solid-js';
import { dialogKeyboard } from '../a11y';
import { toInspectorView } from '../data/analytics';
import type { RequestRow, RequestStatus } from '../data/api';
import { fmtTime } from '../data/catalog';
import { useApp } from '../state/context';

/** label / bg / fg per served status. */
const STATUS_BADGE: Record<RequestStatus, [string, string, string]> = {
  success: ['OK · served', 'var(--green-bg)', 'var(--green)'],
  fallback: ['Fallback · served', 'var(--amber-bg)', 'var(--amber)'],
  error: ['Error', 'var(--red-bg)', 'var(--red)'],
  // A client-cancelled request (disconnect) — neutral, not a provider error.
  cancelled: ['Cancelled · client', 'var(--chip)', 'var(--text3)'],
};

/** `request_log.status` is free-form text at the DB, so a legacy/unknown value must
 * render a neutral badge rather than crash on a missing map entry. */
function badgeFor(status: string): [string, string, string] {
  return STATUS_BADGE[status as RequestStatus] ?? [status || 'unknown', 'var(--chip)', 'var(--text3)'];
}

/** Routing-decision inspector over a real RequestLog row — header, route, the
 * verbatim decision layer + routing reason (transparency payload, invariant 1),
 * the immutable usage/price snapshots (rendered, never recomputed — invariant 4),
 * and timing. */
export function Inspector() {
  const app = useApp();
  const { state } = app;
  const selected = (): RequestRow | undefined =>
    state.requestList.find((r) => r.id === state.selId) ??
    state.recentRequests.find((r) => r.id === state.selId);

  return (
    <Show when={selected()}>
      {(row) => {
        const view = createMemo(() => toInspectorView(row()));
        let drawerEl: HTMLDivElement | undefined;
        onMount(() => {
          const dispose = dialogKeyboard({
            root: () => drawerEl,
            onClose: () => app.select(null),
            // A modal stacked above owns the keyboard entirely (Escape AND Tab loop);
            // the drawer resumes when it closes.
            suspended: () => state.modal !== null,
          });
          onCleanup(dispose);
        });
        return (
          <>
            {/* eslint-disable-next-line a11y-guard/no-noninteractive-click -- pointer-only backdrop redundancy; Escape is the keyboard path */}
            <div class="overlay" onClick={() => app.select(null)} />
            <div
              class="drawer"
              id="inspector-drawer"
              role="dialog"
              aria-modal="true"
              aria-label="Request inspector"
              tabindex="-1"
              ref={(el) => {
                drawerEl = el;
              }}
            >
              <div style="flex:none;display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border2)">
                <div>
                  <div
                    class="mono"
                    style="font:600 14px 'Geist Mono',monospace;letter-spacing:-.01em;color:var(--text)"
                  >
                    {view().title}
                  </div>
                  <div
                    class="mono"
                    style="font:400 11px 'Geist Mono',monospace;color:var(--text3);margin-top:2px"
                  >
                    {view().id} · {fmtTime(view().createdAtMs)}
                  </div>
                </div>
                <div style="display:flex;align-items:center;gap:10px">
                  <span
                    style={{
                      padding: '2px 9px',
                      'border-radius': '10px',
                      font: "500 11px 'Geist',sans-serif",
                      background: badgeFor(view().status)[1],
                      color: badgeFor(view().status)[2],
                    }}
                  >
                    {badgeFor(view().status)[0]}
                  </span>
                  <button
                    type="button"
                    class="drawer-close"
                    aria-label="Close inspector"
                    onClick={() => app.select(null)}
                  >
                    ✕
                  </button>
                </div>
              </div>
              <div style="flex:1;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:18px">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                  <span style="padding:5px 10px;background:var(--chip);border-radius:7px;font:500 11.5px 'Geist',sans-serif;color:var(--text2)">
                    {view().agentLabel}
                  </span>
                  <span style="color:var(--faint)">→</span>
                  <span style="padding:5px 10px;background:var(--accent-bg);border-radius:7px;font:500 11.5px 'Geist',sans-serif;color:var(--accent-deep)">
                    router · {view().decisionLayer}
                  </span>
                  <span style="color:var(--faint)">→</span>
                  <span style="padding:5px 10px;background:var(--chip);border-radius:7px;font:500 11.5px 'Geist',sans-serif;color:var(--text2)">
                    {view().providerLabel}
                    {view().tier !== null ? ` · ${String(view().tier)}` : ''}
                  </span>
                </div>

                <div>
                  <div class="upper-label" style="margin-bottom:9px">
                    Decision
                  </div>
                  <div class="kv-box">
                    <div style="display:flex;justify-content:space-between;gap:16px">
                      <span style="color:var(--text3)">decision layer</span>
                      <span style="color:var(--text)">{view().decisionLayer}</span>
                    </div>
                    <div style="display:flex;justify-content:space-between;gap:16px">
                      <span style="color:var(--text3);flex:none">routing reason</span>
                      <span style="color:var(--text);text-align:right">{view().routingReason}</span>
                    </div>
                    <Show when={view().escalated}>
                      <div style="display:flex;justify-content:space-between">
                        <span style="color:var(--text3)">escalated</span>
                        <span style="color:var(--amber)">yes ↗</span>
                      </div>
                    </Show>
                    <Show when={view().qualitySignal !== null}>
                      <div style="display:flex;justify-content:space-between">
                        <span style="color:var(--text3)">quality signal</span>
                        <span style="color:var(--text)">{view().qualitySignal?.toFixed(2)}</span>
                      </div>
                    </Show>
                  </div>
                </div>

                <div>
                  <div class="upper-label" style="margin-bottom:9px">
                    Usage & cost
                  </div>
                  <div class="kv-box">
                    <div style="display:flex;justify-content:space-between">
                      <span style="color:var(--text3)">input tokens</span>
                      <span style="color:var(--text)">{view().inputTokens.toLocaleString()}</span>
                    </div>
                    <div style="display:flex;justify-content:space-between">
                      <span style="color:var(--text3)">output tokens</span>
                      <span style="color:var(--text)">
                        {view().outputTokens.toLocaleString()}
                        {view().usageEstimated ? ' ~est' : ''}
                      </span>
                    </div>
                    <Show when={view().cacheReadTokens !== null}>
                      <div style="display:flex;justify-content:space-between">
                        <span style="color:var(--text3)">cache read tokens</span>
                        <span style="color:var(--text)">
                          {(view().cacheReadTokens ?? 0).toLocaleString()}
                        </span>
                      </div>
                    </Show>
                    <Show when={view().cacheWriteTokens !== null}>
                      <div style="display:flex;justify-content:space-between">
                        <span style="color:var(--text3)">cache write tokens</span>
                        <span style="color:var(--text)">
                          {(view().cacheWriteTokens ?? 0).toLocaleString()}
                        </span>
                      </div>
                    </Show>
                    <For each={view().prices}>
                      {(p) => (
                        <div style="display:flex;justify-content:space-between">
                          <span style="color:var(--text3)">{p.label} price</span>
                          <span
                            style={{
                              color: p.unpriced
                                ? 'var(--text3)'
                                : p.free
                                  ? 'var(--green)'
                                  : 'var(--text)',
                            }}
                          >
                            {p.value}
                          </span>
                        </div>
                      )}
                    </For>
                    <Show when={view().priceSourceLabel !== null}>
                      <div style="display:flex;justify-content:space-between">
                        <span style="color:var(--text3)">price source</span>
                        <span style="color:var(--text)">{view().priceSourceLabel}</span>
                      </div>
                    </Show>
                    <div style="display:flex;justify-content:space-between;border-top:1px solid var(--border2);padding-top:7px">
                      <span style="color:var(--text3)">served cost</span>
                      <span style="color:var(--text)">{view().servedCost}</span>
                    </div>
                    <div style="display:flex;justify-content:space-between">
                      <span style="color:var(--text3)">attempt cost</span>
                      <span style="color:var(--text)">{view().attemptCost}</span>
                    </div>
                    <div style="display:flex;justify-content:space-between">
                      <span style="color:var(--text3)">total</span>
                      <span style="color:var(--text);font-weight:500">{view().totalCost}</span>
                    </div>
                  </div>
                  <div style="font:400 10.5px 'Geist',sans-serif;color:var(--text3);margin-top:6px">
                    {view().usageEstimated
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
                      <span style="color:var(--text3)">duration</span>
                      <span style="color:var(--text)">
                        {(view().durationMs / 1000).toFixed(2)}s
                      </span>
                    </div>
                    <div style="display:flex;justify-content:space-between">
                      <span style="color:var(--text3)">status</span>
                      <span style="color:var(--text)">{view().status}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </>
        );
      }}
    </Show>
  );
}
