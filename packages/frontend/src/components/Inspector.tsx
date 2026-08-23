import { createMemo, For, Show } from 'solid-js';
import { useModalSurface } from '../a11y';
import { toInspectorView } from '../data/analytics';
import type { RequestRow, RequestStatus } from '../data/api';
import { fmtDateTime } from '../data/catalog';
import { useApp } from '../state/context';
import { Icon } from './Icon';

/** label / bg / fg per served status. */
const STATUS_BADGE: Record<RequestStatus, [string, string, string]> = {
  success: ['OK · served', 'var(--green-bg)', 'var(--green-text)'],
  fallback: ['Fallback · served', 'var(--amber-bg)', 'var(--amber)'],
  error: ['Error', 'var(--red-bg)', 'var(--red)'],
  // A client-cancelled request (disconnect) — neutral, not a provider error.
  cancelled: ['Cancelled · client', 'var(--chip)', 'var(--text3)'],
};

/** `request_log.status` is free-form text at the DB, so a legacy/unknown value must
 * render a neutral badge rather than crash on a missing map entry. */
function badgeFor(status: string): [string, string, string] {
  return (
    STATUS_BADGE[status as RequestStatus] ?? [status || 'unknown', 'var(--chip)', 'var(--text3)']
  );
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
        // No `suspended` predicate any more. Which layer owns the keyboard is the
        // arbiter's single derivation, so the drawer no longer has to enumerate every
        // surface that might stack above it — the enumeration that grew a term per phase.
        const surface = useModalSurface(app, {
          when: () => true, // this branch only renders while a row is selected
          label: 'Request inspector',
          onDismiss: () => app.select(null),
        });
        return (
          <>
            {/* eslint-disable-next-line a11y-guard/no-noninteractive-click -- pointer-only backdrop redundancy; Escape is the keyboard path */}
            <div
              class="overlay"
              style={{ 'z-index': String(surface.z().backdrop) }}
              onClick={() => app.select(null)}
            />
            <div
              class="drawer"
              style={{ 'z-index': String(surface.z().surface) }}
              inert={state.navExpanded ? true : undefined}
              id="inspector-drawer"
              {...surface.props}
              ref={surface.props['ref'] as (n: HTMLElement) => void}
            >
              {/* Layout in classes, not inline: the sheet presentation has to restate this
                  padding at narrow width, and an inline style would outrank the rule. */}
              <div class="drawer-head">
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
                    {view().id} · {fmtDateTime(view().createdAtMs)}
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
                    <Icon name="close" size={13} />
                  </button>
                </div>
              </div>
              <div class="drawer-body">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                  <span style="padding:5px 10px;background:var(--chip);border-radius:7px;font:500 11.5px 'Geist',sans-serif;color:var(--text2)">
                    {view().agentLabel}
                  </span>
                  <Icon name="arrowRight" size={12} style="color:var(--faint)" />
                  <span style="padding:5px 10px;background:var(--accent-bg);border-radius:7px;font:500 11.5px 'Geist',sans-serif;color:var(--accent-deep)">
                    router · {view().decisionLayer}
                  </span>
                  <Icon name="arrowRight" size={12} style="color:var(--faint)" />
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
                    <Show when={view().matchedHeader !== null}>
                      <div style="display:flex;justify-content:space-between;gap:16px">
                        <span style="color:var(--text3);flex:none">header</span>
                        <span
                          class="mono"
                          style="font:500 11.5px 'Geist Mono',monospace;color:var(--text);text-align:right;word-break:break-all"
                        >
                          {view().matchedHeader}
                        </span>
                      </div>
                    </Show>
                    <Show when={view().escalated}>
                      <div style="display:flex;justify-content:space-between">
                        <span style="color:var(--text3)">escalated</span>
                        <span style="color:var(--amber)">
                          yes <Icon name="escalated" size={11} />
                        </span>
                      </div>
                    </Show>
                    <Show when={view().qualitySignal !== null}>
                      <div style="display:flex;justify-content:space-between">
                        <span style="color:var(--text3)">quality signal</span>
                        <span style="color:var(--text)">{view().qualitySignal?.toFixed(2)}</span>
                      </div>
                    </Show>
                    <Show when={view().semanticSource !== null}>
                      <div style="display:flex;justify-content:space-between;align-items:center;gap:16px">
                        <span style="color:var(--text3)">semantic source</span>
                        <span style="padding:2px 8px;background:var(--chip);border-radius:5px;font:500 10.5px 'Geist',sans-serif;color:var(--text2)">
                          {view().semanticSource}
                          {view().semanticBand !== null ? ` · ${String(view().semanticBand)}` : ''}
                        </span>
                      </div>
                    </Show>
                    {/* Workload verdict (add-workload-telemetry): read-only transparency —
                        the class + its source when the classifier evaluated the request;
                        `none` reads as plain language; hidden (never a placeholder) when null.
                        The classifier itself does not route: a row reads `routed` only when
                        the workload stage claimed it (decision_layer `workload`,
                        add-workload-routing) — the `router ·` line above says the same. */}
                    <Show when={view().workloadClass !== null}>
                      <div style="display:flex;justify-content:space-between;align-items:center;gap:16px">
                        <span style="color:var(--text3)">workload</span>
                        <span
                          data-testid="workload-chip"
                          style="padding:2px 8px;background:var(--chip);border-radius:5px;font:500 10.5px 'Geist',sans-serif;color:var(--text2)"
                        >
                          {view().workloadClass === 'none'
                            ? 'no specialist workload'
                            : `workload · ${String(view().workloadClass)}`}
                          {view().workloadSource !== null
                            ? ` (${String(view().workloadSource)})`
                            : ''}
                          {view().decisionLayer === 'workload' ? ' · routed' : ''}
                        </span>
                      </div>
                    </Show>
                  </div>
                </div>

                {/* Structural fallback trail (add-fallback-attempt-detail): one
                    line per recorded attempt — a never-dispatched breaker skip
                    is labeled, not disguised as an upstream failure. Data-driven:
                    rows without the column render exactly as before. */}
                <Show when={view().attemptTrail.length > 0}>
                  <div>
                    <div class="upper-label" style="margin-bottom:9px">
                      Fallback trail
                    </div>
                    <div class="kv-box">
                      <For each={view().attemptTrail}>
                        {(a) => (
                          <div style="display:flex;justify-content:space-between;gap:16px">
                            <span
                              class="mono"
                              style="font:500 11.5px 'Geist Mono',monospace;color:var(--text2);word-break:break-all"
                            >
                              {a.model}
                              {a.legLabel !== null ? ` · ${a.legLabel}` : ''}
                            </span>
                            <span
                              style={{
                                color: a.skipped ? 'var(--text3)' : 'var(--text)',
                                'text-align': 'right',
                              }}
                            >
                              {a.label}
                            </span>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

                <Show when={view().errorView} keyed>
                  {(ev) => (
                    <div>
                      <div class="upper-label" style="margin-bottom:9px;color:var(--red)">
                        Error
                      </div>
                      <div class="kv-box" style="border-color:var(--red-bg)">
                        <Show when={ev.headline !== ''}>
                          <div style="display:flex;justify-content:space-between;gap:16px">
                            <span style="color:var(--text3)">kind</span>
                            <span
                              class="mono"
                              style="font:500 11.5px 'Geist Mono',monospace;color:var(--red)"
                            >
                              {ev.headline}
                            </span>
                          </div>
                        </Show>
                        <Show when={ev.message !== null}>
                          <div style="display:flex;flex-direction:column;gap:4px">
                            <span style="color:var(--text3)">provider said</span>
                            <span
                              class="mono"
                              style="font:400 11.5px 'Geist Mono',monospace;color:var(--text2);white-space:pre-wrap;word-break:break-word"
                            >
                              {ev.message}
                            </span>
                          </div>
                        </Show>
                        <Show when={ev.requestId !== null}>
                          <div style="display:flex;justify-content:space-between;gap:16px">
                            <span style="color:var(--text3)">provider request id</span>
                            <span
                              class="mono"
                              style="font:400 11px 'Geist Mono',monospace;color:var(--text)"
                            >
                              {ev.requestId}
                            </span>
                          </div>
                        </Show>
                        {/* add-fallback-attempt-detail: the terminal member was a
                            breaker skip — read from the recorded marker, never
                            inferred — so a bare kind must not present as an
                            upstream failure. */}
                        <Show when={view().terminalSkipped}>
                          <div style="font:400 11px 'Geist',sans-serif;color:var(--text3)">
                            The last chain member was never contacted — its provider's circuit was
                            open when this request walked the chain.
                          </div>
                        </Show>
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
                                  ? 'var(--green-text)'
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

                {/* Payload (add-body-capture): rendered ONLY when bodies are
                    stored (data-driven, legacy rows byte-identical); content is
                    fetched lazily on expand, never on the listing. */}
                <Show when={row().hasBodies}>
                  <div>
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:9px">
                      <div class="upper-label">Payload</div>
                      <Show
                        when={
                          state.selBodies.rows !== null ||
                          state.selBodies.loading ||
                          state.selBodies.error !== null
                        }
                        fallback={
                          <button
                            type="button"
                            class="link-accent"
                            style="font-size:11.5px"
                            onClick={() => void app.loadSelectedBodies(row().id)}
                          >
                            Show bodies
                          </button>
                        }
                      >
                        <button
                          type="button"
                          class="link-accent"
                          style="font-size:11.5px;color:var(--red)"
                          onClick={() => void app.deleteSelectedBodies(row().id)}
                        >
                          Delete
                        </button>
                      </Show>
                    </div>
                    <Show when={state.selBodies.loading}>
                      <div style="font:400 11.5px 'Geist',sans-serif;color:var(--text3)">
                        Loading…
                      </div>
                    </Show>
                    <Show when={state.selBodies.error} keyed>
                      {(e) => (
                        <div style="font:400 11.5px 'Geist',sans-serif;color:var(--red)">{e}</div>
                      )}
                    </Show>
                    <Show when={state.selBodies.rows} keyed>
                      {(rows) => (
                        <div style="display:flex;flex-direction:column;gap:8px">
                          <For each={rows}>
                            {(b) => (
                              <div class="kv-box">
                                <div style="display:flex;justify-content:space-between;align-items:center">
                                  <span style="color:var(--text3)">
                                    {b.direction}
                                    {b.truncated
                                      ? ` · truncated (${(b.bytes / 1024).toFixed(1)} KB total)`
                                      : ''}
                                    {b.partial ? ' · partial' : ''}
                                  </span>
                                  <button
                                    type="button"
                                    class="link-accent"
                                    style="font-size:11px"
                                    onClick={() => app.copy(b.content, 'Body copied')}
                                  >
                                    Copy
                                  </button>
                                </div>
                                <pre
                                  class="mono"
                                  style="font:400 11px 'Geist Mono',monospace;color:var(--text2);white-space:pre-wrap;word-break:break-word;max-height:220px;overflow-y:auto;margin:0"
                                >
                                  {b.content}
                                </pre>
                              </div>
                            )}
                          </For>
                        </div>
                      )}
                    </Show>
                  </div>
                </Show>

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
