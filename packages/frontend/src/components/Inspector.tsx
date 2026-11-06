import { createMemo, For, Show, type JSX } from 'solid-js';
import { useModalSurface } from '../a11y';
import {
  SUPERSEDED_LABEL,
  toInspectorView,
  type ReceiptTokenRow,
  type RouteTraceNode,
} from '../data/analytics';
import { isKnownRequestStatus, type KnownRequestStatus, type RequestRow } from '../data/api';
import { fmtDateTime } from '../data/catalog';
import { FROM_DIALOG } from '../state/appState';
import { useApp } from '../state/context';
import { FigureText } from './FigureText';
import { Icon } from './Icon';

/** label / bg / fg per served status. */
const STATUS_BADGE: Record<KnownRequestStatus, [string, string, string]> = {
  success: ['OK · served', 'var(--green-bg)', 'var(--green-text)'],
  fallback: ['Fallback · served', 'var(--amber-bg)', 'var(--amber-text)'],
  error: ['Error', 'var(--red-bg)', 'var(--red-text)'],
  // A client-cancelled request (disconnect) — neutral, not a provider error.
  cancelled: ['Cancelled · client', 'var(--chip)', 'var(--text3)'],
};

/** `request_log.status` is free-form text at the DB, so a legacy/unknown value renders a
 * neutral badge, verbatim (`unknown` when blank), rather than crash on a missing map entry. */
function badgeFor(status: string): [string, string, string] {
  return isKnownRequestStatus(status)
    ? STATUS_BADGE[status]
    : [status || 'unknown', 'var(--chip)', 'var(--text3)'];
}

/** The separator between a route-trace node's parts, so a node reads as its view-model
 * `text` (add-route-trace-inspector design D1). */
const SEP = ' · ';

/** A node's parts in order, `SEP` between each part that is present. */
function joined(parts: readonly (JSX.Element | null)[]): JSX.Element[] {
  const out: JSX.Element[] = [];
  for (const p of parts) {
    if (p === null) continue;
    if (out.length > 0) out.push(SEP);
    out.push(p);
  }
  return out;
}

/** A node branches off the spine (an attempt, the superseded call, the outcome); the source
 * and the decision sit on it (DESIGN.md Route Trace › Anatomy). */
const BRANCHES: ReadonlySet<RouteTraceNode['kind']> = new Set(['attempt', 'superseded', 'outcome']);

/** One node's text block (design D6, the Text column): it states the node's outcome in words,
 * so the decoration beside it only repeats them. Identifiers (model ids, the failure label,
 * markers) are Mono; figures (the latency, `q=`, the attempt cost) are tabular Geist. */
function TraceNodeText(props: { node: RouteTraceNode }): JSX.Element {
  const n = props.node;
  switch (n.kind) {
    case 'source':
      return <>{n.text}</>;
    case 'decision':
      // The static chip (DESIGN.md Chips), in Ink 2 on the Chip Tone like the semantic and
      // workload chips: neutral for any layer, never an indigo tone (design D5).
      return (
        <span class="chip" style="font:500 0.6875rem/1rem 'Geist',sans-serif;color:var(--text2)">
          {n.text}
        </span>
      );
    case 'attempt':
      return (
        <>
          {joined([
            <span class="mono rt-model">{n.model}</span>,
            // A dispatched failure's label is the one red text in the trace (design D6,
            // Failure text); the skip label is not a failure and keeps the row's Ink 3.
            n.emphasis === 'failed' ? <span class="mono rt-failure">{n.label}</span> : n.label,
            ...(n.markers ?? []).map((m) => <span class="mono rt-meta">{m}</span>),
            n.leg === null ? null : <span class="rt-meta">{n.leg}</span>,
          ])}
        </>
      );
    case 'superseded':
      return (
        <>
          {joined([
            SUPERSEDED_LABEL,
            n.quality === null ? null : <span class="figure">{n.quality}</span>,
            n.costParts === null ? null : (
              <span class="figure rt-nowrap">
                <FigureText parts={n.costParts} />
              </span>
            ),
          ])}
        </>
      );
    case 'outcome':
      return (
        <>
          {joined([
            n.provider,
            n.model === null ? null : <span class="mono rt-model">{n.model}</span>,
            n.result,
            <span class="figure" data-testid="rt-latency">
              {n.latency}
            </span>,
          ])}
        </>
      );
  }
}

/** The count group's test id: the input and output counts keep the ids their tests read. */
function countTestId(label: ReceiptTokenRow['label']): string | undefined {
  return label === 'input'
    ? 'inspector-input-tokens'
    : label === 'output'
      ? 'inspector-output-tokens'
      : undefined;
}

/** Routing-decision inspector over a real RequestLog row (add-route-trace-inspector design
 * D7): the ERROR card when there is one, the route trace (the recorded walk, its latency on
 * the outcome node), the verbatim decision layer + routing reason (transparency payload,
 * invariant 1), the price receipt (the immutable snapshots, rendered and never recomputed —
 * invariant 4), and the payload when one is stored. */
export function Inspector() {
  const app = useApp();
  const { state } = app;
  /** The payload Delete asks first, in the shared destructive confirmation
   * (adopt-red-destructive-actions D6 / D7), whose commit carries the busy state: the trigger
   * only opens it (dashboard-core "A card action shows that it is working"). The payload
   * section, and with it the trigger, goes on success, so focus lands on the inspector root
   * (D8), which stays open beneath the dialog. */
  const deletePayload = (id: string): void => {
    app.confirmDestructive({
      title: 'Delete this request’s payload?',
      body: 'Its stored request and response bodies are deleted. The request stays in the log.',
      commitLabel: 'Delete payload',
      busyLabel: 'Deleting…',
      run: () => app.deleteSelectedBodies(id, FROM_DIALOG),
      fallbackFocus: () => document.getElementById('inspector-drawer'),
    });
  };
  /** The selected row: the live one from the loaded lists when it is there, so an update to
   * it (a deleted payload) shows; otherwise the row as it was when last found, for the same
   * selection. A list read that failed removes its rows (adopt-figure-states D5), and a
   * background refresh that does so must neither close the inspector the user is reading nor,
   * once a later read brings the row back, reopen it by itself and take focus. Keeping the row
   * open is not "stale as current": a recorded request is immutable (invariant 4). Clearing
   * the selection (`select(null)`, a page change, the identity reset) still closes it. */
  const selected = createMemo<RequestRow | undefined>((prev) => {
    const id = state.selId;
    if (id === null) return undefined;
    const live =
      state.requestList.find((r) => r.id === id) ?? state.recentRequests.find((r) => r.id === id);
    if (live !== undefined) return live;
    return prev?.id === id ? prev : undefined;
  });

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
                    style="font:600 0.9375rem/1.25rem 'Geist Mono',monospace;letter-spacing:-.01em;color:var(--text)"
                  >
                    {view().title}
                  </div>
                  {/* The id is an identifier (Mono); the time is a figure (tabular Geist):
                      DESIGN.md The Machine-String Rule. */}
                  <div class="t-caption" style="color:var(--text3);margin-top:4px">
                    <span class="mono" data-testid="inspector-id">
                      {view().id}
                    </span>{' '}
                    ·{' '}
                    <span class="figure" data-testid="inspector-time">
                      {fmtDateTime(view().createdAtMs)}
                    </span>
                  </div>
                </div>
                <div style="display:flex;align-items:center;gap:8px">
                  <span
                    class="chip"
                    style={{
                      font: "500 0.6875rem/1rem 'Geist',sans-serif",
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
                {/* The ERROR card leads (design D7): a failed request opens on what the provider
                    said. Its rules are add-request-error-detail's, unchanged; its label and
                    headline are the contrast-passing red TEXT token. */}
                <Show when={view().errorView} keyed>
                  {(ev) => (
                    <div data-testid="inspector-error">
                      <div class="upper-label" style="margin-bottom:8px;color:var(--red-text)">
                        Error
                      </div>
                      <div class="kv-box" style="border-color:var(--red-bg)">
                        <Show when={ev.headline !== ''}>
                          <div style="display:flex;justify-content:space-between;gap:16px">
                            <span style="color:var(--text3)">kind</span>
                            <span class="mono t-label" style="color:var(--red-text)">
                              {ev.headline}
                            </span>
                          </div>
                        </Show>
                        <Show when={ev.message !== null}>
                          <div style="display:flex;flex-direction:column;gap:4px">
                            <span style="color:var(--text3)">provider said</span>
                            <span
                              class="mono t-dense"
                              style="color:var(--text2);white-space:pre-wrap;word-break:break-word"
                            >
                              {ev.message}
                            </span>
                          </div>
                        </Show>
                        {/* fix-bad-request-dead-end: where `provider said` is a
                            fixed withheld marker, THIS is the only row that says why
                            the provider refused. Absent markers drop the row — an
                            empty diagnosis is worse than none. */}
                        <Show when={ev.markers} keyed>
                          {(ms) => (
                            <div style="display:flex;justify-content:space-between;gap:16px">
                              <span style="color:var(--text3)">classification</span>
                              <span
                                class="mono t-label"
                                style="color:var(--text2);text-align:right;word-break:break-all"
                              >
                                {ms.join(' · ')}
                              </span>
                            </div>
                          )}
                        </Show>
                        <Show when={ev.requestId !== null}>
                          <div style="display:flex;justify-content:space-between;gap:16px">
                            <span style="color:var(--text3)">provider request id</span>
                            <span class="mono t-caption" style="color:var(--text)">
                              {ev.requestId}
                            </span>
                          </div>
                        </Show>
                        {/* add-fallback-attempt-detail: the terminal member was a
                            breaker skip — read from the recorded marker, never
                            inferred — so a bare kind must not present as an
                            upstream failure. */}
                        <Show when={view().terminalSkipped}>
                          <div class="t-caption" style="color:var(--text3)">
                            The last chain member was never contacted — its provider's circuit was
                            open when this request walked the chain.
                          </div>
                        </Show>
                      </div>
                    </div>
                  )}
                </Show>

                {/* The route trace (add-route-trace-inspector design D1–D6; DESIGN.md Route
                    Trace): the recorded walk as an ordered list, read from this row alone —
                    never a member it did not walk, never today's routing config, and no commit
                    marker (commit time is not recorded). Each node states its outcome in text;
                    its spine, branch and node mark are `aria-hidden` decoration, drawn by the
                    `rt-*` rules and never animated. The served branch is the inspector's one
                    focal series (the Indigo Budget), so only its node is a focal root. */}
                <div data-testid="route-trace">
                  {/* An explicit list role: WebKit drops list semantics from a marker-less list. */}
                  <ol class="rt" role="list" aria-label="Route trace">
                    <For each={view().trace}>
                      {(n) => (
                        <li
                          class={`rt-node rt-node--${n.emphasis}`}
                          data-kind={n.kind}
                          data-series={n.emphasis === 'lit' ? 'focal' : undefined}
                          data-measure={n.emphasis === 'lit' ? 'route-trace' : undefined}
                        >
                          <span class="rt-spine" aria-hidden="true" />
                          <Show when={BRANCHES.has(n.kind)}>
                            <span class="rt-branch" aria-hidden="true" />
                          </Show>
                          <span class="rt-dot" aria-hidden="true" />
                          <div class="rt-text">
                            <TraceNodeText node={n} />
                          </div>
                        </li>
                      )}
                    </For>
                  </ol>
                  <Show when={view().traceCaption} keyed>
                    {(caption) => <p class="t-caption rt-caption">{caption}</p>}
                  </Show>
                </div>

                <div>
                  <div class="upper-label" style="margin-bottom:8px">
                    Decision
                  </div>
                  <div class="kv-box" data-testid="inspector-decision">
                    <div style="display:flex;justify-content:space-between;gap:16px">
                      <span style="color:var(--text3)">decision layer</span>
                      <span style="color:var(--text)">{view().decisionLayer}</span>
                    </div>
                    <div style="display:flex;justify-content:space-between;gap:16px">
                      <span style="color:var(--text3);flex:none">routing reason</span>
                      <span style="color:var(--text);text-align:right">{view().routingReason}</span>
                    </div>
                    {/* The served tier (design D7): it rode the old provider chip, which the
                        trace replaced. It follows `tier_assigned` alone, never the header gate
                        below; a tier name is an identifier, and the kv-box sets Mono. It wraps
                        only where it must (DESIGN.md Long content: `overflow-wrap: anywhere`). */}
                    <Show when={view().tier} keyed>
                      {(tier) => (
                        <div style="display:flex;justify-content:space-between;gap:16px">
                          <span style="color:var(--text3);flex:none">tier</span>
                          <span
                            style="color:var(--text);text-align:right;overflow-wrap:anywhere"
                            data-testid="inspector-tier"
                          >
                            {tier}
                          </span>
                        </div>
                      )}
                    </Show>
                    <Show when={view().matchedHeader !== null}>
                      <div style="display:flex;justify-content:space-between;gap:16px">
                        <span style="color:var(--text3);flex:none">header</span>
                        <span
                          class="mono t-label"
                          style="color:var(--text);text-align:right;word-break:break-all"
                        >
                          {view().matchedHeader}
                        </span>
                      </div>
                    </Show>
                    {/* A batch item's decision really was `explicit` — a batch is
                        never produced by `auto` — so the MODE goes beneath it rather
                        than replacing it (add-batch-inference D12/task 5.4). The
                        job id is text in this phase; Phase D links it. */}
                    <Show when={view().batchId !== null}>
                      <div style="display:flex;justify-content:space-between;gap:16px">
                        <span style="color:var(--text3)">mode</span>
                        <span style="color:var(--text)">batch</span>
                      </div>
                      <div style="display:flex;justify-content:space-between;gap:16px">
                        <span style="color:var(--text3);flex:none">batch job</span>
                        {/* Phase D: the id is a LINK to the Batches page, where the
                            job's progress, wall time, reservation and retention
                            window live — the questions an id alone cannot answer. */}
                        <button
                          type="button"
                          class="link-accent mono t-label"
                          style="text-align:right;word-break:break-all"
                          data-batch-id={view().batchId}
                          onClick={() => app.go('batches')}
                        >
                          {view().batchId}
                        </button>
                      </div>
                    </Show>
                    <Show when={view().escalated}>
                      <div style="display:flex;justify-content:space-between">
                        <span style="color:var(--text3)">escalated</span>
                        <span style="color:var(--amber-text)">
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
                        <span
                          class="chip"
                          style="font:500 0.6875rem/1rem 'Geist',sans-serif;color:var(--text2)"
                        >
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
                        add-workload-routing) — the trace's `router ·` chip says the same. */}
                    <Show when={view().workloadClass !== null}>
                      <div style="display:flex;justify-content:space-between;align-items:center;gap:16px">
                        <span style="color:var(--text3)">workload</span>
                        <span
                          data-testid="workload-chip"
                          class="chip"
                          style="font:500 0.6875rem/1rem 'Geist',sans-serif;color:var(--text2)"
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

                {/* The price receipt (add-route-trace-inspector design D8; DESIGN.md Price
                    Receipt): what the request cost and on what terms. The caption says when the
                    snapshot was taken — at completion, or at a batch's submission — and an
                    unpriced request makes no snapshot claim. Token counts, prices and costs are
                    figures (tabular Geist, `.kv-box--figures`); the one identifier, the price
                    source, keeps Mono. Each token row is count × unit price, its count group
                    and its price group each one no-wrap unit, so the row wraps only at the ` × `
                    and an estimate marker never leaves its own figure. Every money figure and
                    price renders its parts through `FigureText` (adopt-figure-states D1); the
                    total is the table cost cell's own state (`requestCostState`). */}
                <div data-testid="inspector-receipt">
                  <div class="t-section" style="color:var(--text)">
                    Price snapshot
                  </div>
                  <Show when={view().receiptCaption} keyed>
                    {(caption) => (
                      <div
                        class="t-caption"
                        style="color:var(--text3);margin-top:4px"
                        data-testid="receipt-caption"
                      >
                        {caption}
                      </div>
                    )}
                  </Show>
                  <div class="kv-box kv-box--figures" style="margin-top:8px">
                    <For each={view().tokenRows}>
                      {(t) => (
                        <div
                          style="display:flex;justify-content:space-between;gap:16px"
                          data-testid="receipt-token-row"
                        >
                          <span style="color:var(--text3);flex:none">{t.label}</span>
                          <span style="color:var(--text);text-align:right">
                            <Show when={t.countParts} keyed>
                              {(count) => (
                                <>
                                  <span class="rt-nowrap" data-testid={countTestId(t.label)}>
                                    <FigureText parts={count} />
                                  </span>
                                  {' × '}
                                </>
                              )}
                            </Show>
                            <span
                              class="rt-nowrap"
                              style="color:var(--text)"
                              data-testid="inspector-price"
                            >
                              <FigureText parts={t.priceParts} />
                            </span>
                          </span>
                        </div>
                      )}
                    </For>
                    <Show when={view().receiptSource} keyed>
                      {(source) => (
                        <div style="display:flex;justify-content:space-between;gap:16px">
                          <span style="color:var(--text3)">source</span>
                          {/* Which RULE priced it, beside where the rate came from: a
                              batch item is charged the provider's batch tier, and a
                              `listed`/`native_family` batch rate is an estimate exactly
                              as it is for a synchronous request. */}
                          <span
                            class="mono"
                            style="color:var(--text);text-align:right"
                            data-testid="receipt-source"
                          >
                            {source}
                          </span>
                        </div>
                      )}
                    </Show>
                    <div style="display:flex;justify-content:space-between;gap:16px;border-top:1px solid var(--border2);padding-top:8px">
                      <span style="color:var(--text3)">served</span>
                      <span
                        style="color:var(--text);text-align:right"
                        data-testid="inspector-served-cost"
                      >
                        <FigureText parts={view().servedParts} />
                      </span>
                    </div>
                    {/* Only when superseded calls cost money; the same parts the trace's
                        superseded node renders (design D4). */}
                    <Show when={view().attemptsRowParts} keyed>
                      {(parts) => (
                        <div style="display:flex;justify-content:space-between;gap:16px">
                          <span style="color:var(--text3)">attempts</span>
                          <span
                            style="color:var(--text);text-align:right"
                            data-testid="inspector-attempt-cost"
                          >
                            <FigureText parts={parts} />
                          </span>
                        </div>
                      )}
                    </Show>
                    <div style="display:flex;justify-content:space-between;gap:16px;border-top:1px solid var(--border);padding-top:8px;font-size:0.8125rem;line-height:1.25rem;font-weight:600">
                      <span style="color:var(--text3)">total</span>
                      <span
                        style="color:var(--text);text-align:right"
                        data-testid="inspector-total-cost"
                      >
                        <FigureText parts={view().totalParts} />
                      </span>
                    </div>
                  </div>
                  {/* The one note under the receipt: not billed (about the SERVED call only, so
                      it stays true beside a real attempt cost), or estimated usage. */}
                  <Show when={view().receiptNote} keyed>
                    {(note) => (
                      <div
                        data-testid={view().notBilled ? 'not-billed-note' : undefined}
                        class="t-caption"
                        style="color:var(--text3);margin-top:8px"
                      >
                        {note}
                      </div>
                    )}
                  </Show>
                </div>

                {/* Payload (add-body-capture): rendered ONLY when bodies are
                    stored (data-driven, legacy rows byte-identical); content is
                    fetched lazily on expand, never on the listing. */}
                <Show when={row().hasBodies}>
                  <div>
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
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
                            style="font-size:0.75rem"
                            onClick={() => void app.loadSelectedBodies(row().id)}
                          >
                            Show bodies
                          </button>
                        }
                      >
                        <button
                          type="button"
                          class="btn-ghost btn-ghost--destructive"
                          onClick={() => deletePayload(row().id)}
                        >
                          Delete
                        </button>
                      </Show>
                    </div>
                    <Show when={state.selBodies.loading}>
                      <div class="t-caption" style="color:var(--text3)">
                        Loading…
                      </div>
                    </Show>
                    <Show when={state.selBodies.error} keyed>
                      {(e) => (
                        <div class="t-caption" style="color:var(--red-text)">
                          {e}
                        </div>
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
                                    style="font-size:0.6875rem"
                                    onClick={() => app.copy(b.content, 'Body copied')}
                                  >
                                    Copy
                                  </button>
                                </div>
                                <pre
                                  class="mono t-caption"
                                  style="color:var(--text2);white-space:pre-wrap;word-break:break-word;max-height:220px;overflow-y:auto;margin:0"
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
              </div>
            </div>
          </>
        );
      }}
    </Show>
  );
}
