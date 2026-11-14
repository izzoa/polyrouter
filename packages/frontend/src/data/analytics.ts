import type { RequestFilter, RequestMode, SpendDatum } from '../types';
import {
  labelOf,
  totalCostMicros,
  type AnalyticsSummary,
  type AttemptFailureEntry,
  type BreakdownRow,
  type RequestRow,
  type RequestsQuery,
  type RequestStatus,
  type RouteDeferral,
  type RouteLeg,
  type TimeseriesPoint,
} from './api';
import { fmtElapsed } from './batchBand';
import {
  costParts,
  EST_USAGE_PARTS,
  fmtLatency,
  isEstimateSource,
  money,
  partsText,
  priceLabelParts,
  requestCostState,
  type FigurePart,
} from './figures';
import { fmtUsd } from './format';

/** Pure view-model transforms over the #17 analytics shapes — unit-tested, and
 * the single source Overview/Costs/Requests/Inspector render from. All cost/price
 * values are the row's immutable snapshots, never recomputed (invariant 4). */

const rate = (num: number, denom: number): number => (denom === 0 ? 0 : num / denom);

export function successRate(s: AnalyticsSummary): number {
  return rate(s.successCount, s.requests);
}
export function fallbackRate(s: AnalyticsSummary): number {
  return rate(s.fallbackCount, s.requests);
}
export function escalationRate(s: AnalyticsSummary): number {
  return rate(s.escalatedCount, s.requests);
}

/** Timeseries → uPlot single-series data `[secs[], counts[]]` (x = epoch SECONDS,
 * uPlot's unit; y = requests per bucket). The server returns one point per NON-empty
 * bucket, so empty buckets are missing; we zero-fill them (an empty bucket had 0
 * requests) so the chart dips to the baseline over idle periods instead of drawing a
 * line interpolated across the gap that falsely implies continuous activity (A-31). */
export function timeseriesToChart(
  points: TimeseriesPoint[],
  bucketSeconds: number,
): [number[], number[]] {
  const rows = points.map((p) => ({
    t: Math.floor(new Date(p.bucket).getTime() / 1000),
    n: p.requests,
  }));
  const step = bucketSeconds > 0 ? bucketSeconds : Infinity;
  const secs: number[] = [];
  const counts: number[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (i > 0 && Number.isFinite(step)) {
      // Insert a zero point for each bucket skipped between the previous point and this one
      // (the server omits empty buckets), so the chart dips to the baseline over idle spans.
      for (let t = rows[i - 1]!.t + step; t < row.t - step / 2; t += step) {
        secs.push(t);
        counts.push(0);
      }
    }
    secs.push(row.t);
    counts.push(row.n);
  }
  return [secs, counts];
}

/** Seconds per timeseries bucket for zero-fill positioning. */
export function bucketSeconds(bucket: 'hour' | 'day'): number {
  return bucket === 'hour' ? 3600 : 86_400;
}

/** A breakdown row → a `BarRows` datum (label via the id fallback, spend in USD). */
export function breakdownToSpend(rows: BreakdownRow[]): SpendDatum[] {
  return rows.map((r) => ({ n: labelOf(r.label, r.key === '' ? null : r.key), v: r.spend }));
}

/** All four recorded components. `inputTokens` is *uncached* input — the adapters record
 * cached tokens separately — so summing only input+output would under-report a cached
 * workload while looking exact. */
export function totalTokens(r: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): number {
  return r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;
}

export function breakdownToTokens(rows: BreakdownRow[]): SpendDatum[] {
  // No `free` flag: it means a price of zero, which says nothing about tokens consumed.
  return rows.map((r) => ({ n: labelOf(r.label, r.key === '' ? null : r.key), v: totalTokens(r) }));
}

export type RequestFilterParams = Pick<RequestsQuery, 'status' | 'escalated' | 'decisionLayers'>;

/** The dashboard's filter chip → server-side query params (Decision 1). All chips
 * map to server filters so keyset pagination never returns an empty filtered page
 * mid-cursor. `explicit` covers deterministic routing incl. a smart request that
 * fell through to `default`. */
/** The execution-mode partition as a query param (add-batch-inference). `all` is
 * the absence of a filter, so it sends nothing. */
export function modeToRequestParams(mode: RequestMode): { mode?: 'sync' | 'batch' } {
  return mode === 'all' ? {} : { mode };
}

/** The agent selection as listing params (add-agent-request-attribution).
 *
 * DELIBERATELY separate from `filterToRequestParams`, whose input is the
 * routing-layer chip enum. Overloading that enum would make the two filters
 * mutually exclusive — and composing them is the whole point ("agent X's
 * escalations"). `null` means no selection and contributes nothing. */
export function agentToRequestParams(agentId: string | null): { agentId?: string } {
  return agentId === null || agentId === '' ? {} : { agentId };
}

export function filterToRequestParams(filter: RequestFilter): RequestFilterParams {
  switch (filter) {
    case 'explicit':
      return { decisionLayers: ['explicit', 'header', 'default'] };
    case 'auto':
      // L2-routed requests carry decision_layer='semantic' — include it or the
      // Auto filter silently drops them (clink change-4 Med-5). Workload-routed
      // requests carry 'workload' (add-workload-routing) — same rule.
      return { decisionLayers: ['structural', 'workload', 'semantic', 'cascade'] };
    case 'fallback':
      return { status: 'fallback' };
    case 'escalated':
      return { escalated: true };
    case 'all':
    default:
      return {};
  }
}

/** A settled batch item. `batchId` is the fact; `priceMode` is how it was priced —
 * either alone identifies one, and a row predating the columns is neither. The request
 * table's latency cell and the route trace's outcome node both read this predicate, so a
 * batch item's latency takes the same format on both (add-route-trace-inspector). */
export const isBatchItem = (r: Pick<RequestRow, 'batchId' | 'priceMode'>): boolean =>
  r.batchId !== null || r.priceMode === 'batch';

/** A request's latency as the table's latency cell writes it: a batch item's wall time
 * through `fmtElapsed` (its `duration_ms` is the job's, and runs to hours), every other
 * row through `fmtLatency` (`412ms` / `1.24s` / `2m 05s`). */
export function requestLatency(
  r: Pick<RequestRow, 'batchId' | 'priceMode' | 'durationMs'>,
): string {
  return isBatchItem(r) ? fmtElapsed(r.durationMs) : fmtLatency(r.durationMs);
}

/** The table's cost cell as parts (adopt-figure-states design D1, D3, D4): the request's
 * cost state from `requestCostState`, the function the inspector's total renders too, so the
 * two cannot drift. `· est.` follows the amount exactly when `priceEstimated` is set (the
 * served row or any attempt was priced `native_family` or `listed`); estimated usage never
 * marks money, it is marked on the tokens cell instead. */
export function rowCostParts(row: RequestRow): readonly FigurePart[] {
  return costParts(requestCostState(row));
}

/** The table's cost cell as text (`partsText` of `rowCostParts`): `$0 · not billed`,
 * `unpriced`, `$0 free`, `$0 free · est.`, `<$0.0001`, or the micros-exact total at four
 * decimals with `· est.` when its price was estimated. */
export function rowCostLabel(row: RequestRow): string {
  return partsText(rowCostParts(row));
}

export interface PriceSnapshotView {
  label: string;
  /** `$0 free` (snapshot 0) vs `unpriced` (snapshot null) — kept distinct. */
  value: string;
  /** `value` as parts: `$0` in the row's ink, `free` green, `· est.` and `unpriced` in
   * Ink 3 (adopt-figure-states design D1). `value` is their joined text. */
  parts: readonly FigurePart[];
  free: boolean;
  unpriced: boolean;
}

function priceView(
  label: string,
  v: number | null,
  source: string | null = null,
): PriceSnapshotView {
  // native-family (adjacent channel) and listed (provider's own) snapshots are
  // estimates — marked on EVERY priced row, the zero-priced (free) case included.
  const estimated = isEstimateSource(source);
  const parts = priceLabelParts(
    v === null
      ? { kind: 'unpriced' }
      : v === 0
        ? { kind: 'free', estimated }
        : // Display precision (zero-cost-unbilled-errors): raw `String(v)` printed float
          // artifacts such as `$0.09999999999999999 / 1M`. The stored snapshot is untouched.
          { kind: 'priced', text: `${fmtUsd(v)} / 1M`, estimated },
  );
  return { label, value: partsText(parts), parts, free: v === 0, unpriced: v === null };
}

export interface InspectorView {
  title: string;
  id: string;
  createdAtMs: number;
  status: RequestStatus;
  /** The recorded served tier (`tier_assigned`): the Decision section's `tier` row, null
   * hiding it. The route trace's source node reads `agentRunLabel` and its outcome node the
   * provider, so the view carries no agent or provider chip label (the old chip row's
   * `labelOf(agentLabel, agentId)` fell back to the raw agent id). */
  tier: string | null;
  /** The provider the request table's Provider column shows (`providerLabel ?? providerId`),
   * but only when the row records one AND the trace's outcome node names none (an unlit
   * outcome whose provider `unlitProvider` cannot confirm, flag RF-1). The Decision section's
   * `recorded provider` row: what was recorded, with no claim about which provider failed.
   * Null otherwise, hiding the row, so a lit or confirmed outcome never says it twice
   * (add-docked-inspector flag F3: the docked list hides the Provider cell). */
  recordedProvider: string | null;
  decisionLayer: string;
  routingReason: string;
  /** The matched routing header rendered as `name: value` (built-in) or the bare
   * name (custom rule — value never recorded); null hides the row entirely
   * (legacy + non-header layers). Gated on the NAME: a stray value without a
   * name (type- and CHECK-impossible) is never rendered. */
  matchedHeader: string | null;
  escalated: boolean;
  /** The Decision section's `quality signal` row; null hides it. Null on a `cheap_error`
   * escalation, whose recorded signal is not a gate verdict on the escalation
   * (add-route-trace-cascade-legs design D8), unless its route record says the cheap leg ended
   * `replay_failed`: that answer passed the gate, so its signal is the real score
   * (record-route-legs design D7). Null when no signal was recorded. */
  qualitySignal: number | null;
  /** L2 provenance (add-semantic-dashboard D4): the active classification source
   * (`learned`/`bundled`) and the verdict band when Layer 2 evaluated this
   * request; both null otherwise — the chip is hidden, never a fabricated value. */
  semanticSource: string | null;
  semanticBand: string | null;
  /** Workload verdict (add-workload-telemetry): the class (taxonomy ∪ `none`)
   * and its source when the classifier evaluated this request; both null
   * otherwise — the chip is hidden, never a fabricated value. */
  workloadClass: string | null;
  workloadSource: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  prices: PriceSnapshotView[];
  /** The served call's cost state (`requestCostState` over the served call alone):
   * `$0 · not billed` for a `billed = false` row, whatever its attempt cost; `unpriced`
   * when served `cost` is null; `$0 free` for a zero cost at zero prices; otherwise the
   * four-decimal amount, `<$0.0001` below it. `· est.` follows exactly when the SERVED price
   * was estimated (`native_family` or `listed`). */
  servedCost: string;
  servedParts: readonly FigurePart[];
  /** The attempt ledger at four decimals. `· est.` follows when the rolled-up flag can only
   * have come from an attempt (served price exact); the listing carries no per-attempt
   * source, so an attempt that shares an estimated served row's flag cannot be told apart. */
  attemptCost: string;
  attemptParts: readonly FigurePart[];
  /** The receipt's `attempts` row: `attemptParts` itself (the same array the route trace's
   * superseded node renders), or null when the attempt cost is zero and no row is drawn. */
  attemptsRowParts: readonly FigurePart[] | null;
  /** The `Price snapshot` caption: when the snapshot was taken, by `priceMode` (sync or
   * null → recorded with the request; batch → at submission). Null when the served cost is
   * null: an unpriced request makes no snapshot claim. */
  receiptCaption: string | null;
  /** One receipt row per token class, as count × unit price: input and output always, a
   * cache class when its count or its snapshot is recorded. */
  tokenRows: readonly ReceiptTokenRow[];
  /** The receipt's source row (`priceSourceLabel`, after `batch · ` on a batch-priced row);
   * null when the price source is null. */
  receiptSource: string | null;
  /** The one note under the receipt: not billed, or estimated usage; null otherwise. */
  receiptNote: string | null;
  /** `requestCostState(row)` — the same state, in the same words, as the table's cost cell
   * (invariant 4 — no recompute). `· est.` exactly when `priceEstimated` is set. */
  totalCost: string;
  totalParts: readonly FigurePart[];
  totalMicros: number;
  /** zero-cost-unbilled-errors: the served call was never sent or was rejected, so
   * nothing was billed for it (`billed === false`). Drives the one inspector note;
   * true even when an attempt line carries cost. */
  notBilled: boolean;
  usageEstimated: boolean;
  /** Rendered price-source line (null hidden); `native_family` reads as an estimate. */
  priceSourceLabel: string | null;
  /** Served OR any attempt priced `native_family` — the TOTAL carries the marker. */
  priceEstimated: boolean;
  durationMs: number;
  /** add-batch-inference (task 5.4): the job this item settled under, or null for a
   * synchronous request. Shown as TEXT in this phase; Phase D links it to the
   * Batches page. */
  batchId: string | null;
  /** Whether the row was priced by the BATCH rule rather than the synchronous one —
   * a different rate, so the drawer says which applied rather than leaving the
   * reader to infer it from the number. */
  batchPriced: boolean;
  /** The ERROR card (add-request-error-detail): non-null ONLY for a status=error
   * row with ≥1 normalized (trimmed, empty→null) detail field. */
  errorView: ErrorView | null;
  /** The route trace (add-route-trace-inspector design D1–D4): the recorded route as an
   * ordered node list, built from this row alone by `toRouteTrace`. */
  trace: readonly RouteTraceNode[];
  /** `attempt history was not recorded for this request` on a `fallback` row whose
   * `attemptFailures` is null; null on every other row. */
  traceCaption: string | null;
  /** True when the recorded terminal-marked attempt was a never-dispatched
   * breaker skip — read from the data, never inferred from kinds. */
  terminalSkipped: boolean;
  /** Why that terminal skip happened, read from the recorded `skipReason`: `plan_cooldown` when
   * the member's provider plan was paused (classify-plan-quota-errors), null for a circuit-open
   * skip (no reason recorded) and for any row without a terminal skip. */
  terminalSkipReason: 'plan_cooldown' | null;
}

/** One token row of the price receipt (design D8 item 2). Its two groups each render as one
 * no-wrap unit, so the row wraps only at the ` × ` between them and a marker never leaves
 * its own figure (`310 · est. usage × $15 / 1M · est.`). */
export interface ReceiptTokenRow {
  readonly label: 'input' | 'output' | 'cache read' | 'cache write';
  /** The count group: the exact grouped count, then `· est. usage` when the provider did not
   * report usage. Null for a cache class whose count is null: the row shows the unit price
   * alone, never a `0` count. */
  readonly countParts: readonly FigurePart[] | null;
  /** The price group: the snapshot's display parts (`$15 / 1M`, `$0 free`, `unpriced`, each
   * with `· est.` when the price was estimated). */
  readonly priceParts: readonly FigurePart[];
  /** The row's plain text: `<count> × <price>`, or the price alone. */
  readonly text: string;
}

export interface ErrorView {
  /** `rate_limit · HTTP 429` | `rate_limit` | `HTTP 429` — never a blank slot. */
  headline: string;
  message: string | null;
  requestId: string | null;
  /** The provider's retained classification (fix-bad-request-dead-end). Where
   * `message` is a fixed withheld marker this is the ONLY field that says why the
   * provider refused, so the card must not suppress it. Null (row dropped), never
   * an empty list — absent markers are unknown, not an empty diagnosis. */
  markers: readonly string[] | null;
}

/* ---- the route trace (add-route-trace-inspector design D1–D4, D10) ------------------- */

/** How a route-trace node is drawn (design D6). Only a served outcome is `lit`; every
 * node also states its outcome in its text, so the emphasis only repeats the words.
 * `in_flight` is the member a client's cancel caught in flight (record-route-legs design D7):
 * contacted, so solid, and not a failure, so never red. */
export type RouteTraceEmphasis = 'lit' | 'neutral' | 'failed' | 'skipped' | 'in_flight';

/** A cascade leg's word, stated once by its leg row (add-route-trace-cascade-legs design D1,
 * D5). A primary (non-cascade) chain draws no leg row. */
export type RouteTraceLeg = 'cheap leg' | 'escalation';

/** Every node carries `text`, its whole reading as plain text, in the order the node's
 * parts are drawn. */
interface RouteTraceNodeBase {
  readonly text: string;
}

/** Where the request came from: the agent label, or `(no agent)`, never the raw id. */
export interface RouteTraceSourceNode extends RouteTraceNodeBase {
  readonly kind: 'source';
  readonly emphasis: 'neutral';
}

/** The decision chip, `router · <decision layer>`, verbatim for any layer value. */
export interface RouteTraceDecisionNode extends RouteTraceNodeBase {
  readonly kind: 'decision';
  readonly emphasis: 'neutral';
  readonly layer: string;
}

/** A cascade leg row (add-route-trace-cascade-legs design D1): a router decision on the
 * spine, like the source and the decision chip, never a branch. It states its leg once, so the
 * attempt nodes under it carry no leg tag (design D5). */
export interface RouteTraceLegNode extends RouteTraceNodeBase {
  readonly kind: 'leg';
  readonly emphasis: 'neutral';
  readonly leg: RouteTraceLeg;
  /** The row's one detail after ` · `: `ATTEMPTS_NOT_RECORDED` on a cheap leg row whose leg the
   * row kept nothing about (design D6), the escalation cause on an escalation row (design D4:
   * the recorded `escalation_source` in words, or, record-route-legs design D7, the route
   * record's cheap-leg end in words); null when there is none. */
  readonly detail: string | null;
  /** The cheap leg's recorded end time, in the latency format (`fmtLatency(endedMs)`), on an
   * escalation row whose cause the route record states (record-route-legs design D7): the row
   * then reads `… · at <time>`. Null on every other leg row, which states no time. */
  readonly at: string | null;
}

/** A member a leg's plan moved behind the others, from the route record (record-route-legs
 * design D7): a router decision on the spine, like a leg row, never a branch, because the walk
 * may never have reached it. It names the member in words and states why it was deferred. */
export interface RouteTraceDeferralNode extends RouteTraceNodeBase {
  readonly kind: 'deferral';
  readonly emphasis: 'neutral';
  readonly model: string;
  /** `LACKS_TOOLS`, `LACKS_VISION` or `LACKS_TOOLS_AND_VISION`; null when the member was not
   * deferred for a capability. Stated first. */
  readonly lacks: string | null;
  /** The output-cap reason's figures in the integer grouping: the member's cap, and the
   * request's ask (null when the leg recorded none). Null when the member was not deferred
   * for its output cap. */
  readonly outputCap: { readonly cap: string; readonly ask: string | null } | null;
}

/** One recorded `attempt_failures` entry (add-fallback-attempt-detail), in stored order, or the
 * sent member the route record names as stopping its leg's walk (record-route-legs design D7).
 * It names the member's model, never its provider (design D10), and carries no leg tag: the leg
 * row above it states the leg (add-route-trace-cascade-legs design D5). */
export interface RouteTraceAttemptNode extends RouteTraceNodeBase {
  readonly kind: 'attempt';
  /** `skipped` for a never-dispatched member, `failed` for a dispatched failure (a recorded
   * non-retryable stopper included), `in_flight` for the member a client's cancel caught in
   * flight. */
  readonly emphasis: 'failed' | 'skipped' | 'in_flight';
  readonly model: string;
  /** A dispatched failure's label, `<kind> · HTTP <status>` or the kind alone when no
   * upstream status was recorded; for a member the walk's own deadline cut off, the cause
   * in words (`DEADLINE_LABEL_CHEAP` on the cheap leg, `DEADLINE_LABEL` off it) in place
   * of the kind; `SKIP_LABEL` (or `PAUSE_LABEL`) for a never-dispatched member; `IN_FLIGHT`
   * for an in-flight member. */
  readonly label: string;
  /** `deadline` when the label states the walk's deadline in words rather than a kind
   * token (keep-cheap-leg-attempt-trail design D5), so the view sets it as prose, not
   * Mono. Null on every other attempt. */
  readonly stop: 'deadline' | null;
  /** THIS attempt's retained classification (fix-bad-request-dead-end), so a RECOVERED
   * request's trail explains every refusal and not just its kind. Null when the entry
   * carries none (including entries predating capture). */
  readonly markers: readonly string[] | null;
  /** The output cap this member was sent with, in the integer grouping, when the route record
   * lists a clamp of it at the same leg and index (record-route-legs design D7): the node then
   * reads `… · output capped at <to>` after its markers. Null on a skipped member, and
   * whenever the record lists none. */
  readonly clamp: string | null;
}

/** The superseded cascade cheap call, drawn only from the recorded rollups (design D4):
 * it never names a model, because the listing does not carry one. */
export interface RouteTraceSupersededNode extends RouteTraceNodeBase {
  readonly kind: 'superseded';
  readonly emphasis: 'neutral';
  /** `q=<score>` at two decimals, only for a `quality_gate` escalation with a recorded
   * score; null otherwise (a `cheap_error` score may be a legacy 0 and would misreport). */
  readonly quality: string | null;
  /** The attempt cost: `InspectorView.attemptParts` itself, the parts the receipt's
   * `attempts` row renders. Null when the attempt cost is zero. */
  readonly costParts: readonly FigurePart[] | null;
}

/** The one outcome node, which carries the request's latency (design D3). */
export interface RouteTraceOutcomeNode extends RouteTraceNodeBase {
  readonly kind: 'outcome';
  /** `lit` only for a `success` or `fallback` row. */
  readonly emphasis: 'lit' | 'neutral';
  /** The served provider on a lit outcome. On an unlit one, the recorded provider when the
   * row shows it was the last provider tried (`unlitProvider`, flag RF-1), else null. */
  readonly provider: string | null;
  /** The served or recorded model; null when the outcome names none (an exhausted chain,
   * whose terminal member is already the last attempt node, or an unrecognised status). */
  readonly model: string | null;
  /** `served`, `failed`, `cancelled by client`, or the recorded status verbatim. */
  readonly result: string;
  /** The latency in the request table's format (`requestLatency`). */
  readonly latency: string;
  /** A kept cheap answer's gate score, `q=<score>` at two decimals (add-route-trace-cascade-legs
   * design D7): the node then also reads `QUALITY_GATE_PASSED`, on a second line after the
   * latency. Null on every other outcome, and on a kept answer that recorded no score. */
  readonly keptQuality: string | null;
  /** The served member's recorded clamp, on a lit outcome only (record-route-legs design D7):
   * its own line after the latency, above any kept-answer line, reading `output capped at <to>
   * of <ask> asked`, or `output capped at <to>` when the leg recorded no ask. Figures in the
   * integer grouping. Null on an unlit outcome, and whenever the record lists none. */
  readonly clamp: { readonly to: string; readonly ask: string | null } | null;
  /** The recorded commit time in the latency format (record-commit-time design D5/D6): its own
   * line, `committed at <time>`, after any clamp line and above any kept-answer line, on a lit
   * outcome and on an unlit one whose stream committed before it failed or lost its client.
   * Read only from the row's `committedMs`, never from the latency, keepalives, the early
   * response commit or a leg's `endedMs`. Null when the row records none. */
  readonly committed: string | null;
}

export type RouteTraceNode =
  | RouteTraceSourceNode
  | RouteTraceDecisionNode
  | RouteTraceLegNode
  | RouteTraceDeferralNode
  | RouteTraceAttemptNode
  | RouteTraceSupersededNode
  | RouteTraceOutcomeNode;

/** The full contract string for a never-dispatched (circuit-open) member. */
export const SKIP_LABEL = 'skipped — circuit open (provider not contacted)';
/** The full contract string for a member skipped because its provider's plan was paused
 * (classify-plan-quota-errors). Chosen from the recorded `skipReason`, never inferred from the
 * kind. */
export const PAUSE_LABEL = 'skipped — plan paused (provider not contacted)';
/** A dispatched member the cascade cheap leg's own deadline cut off, read from the
 * recorded `stopReason` (keep-cheap-leg-attempt-trail design D5), never inferred from the
 * kind or a duration. It replaces the kind, which reads `unavailable` like an outage. */
export const DEADLINE_LABEL_CHEAP = 'no reply by the cheap deadline';
/** The same cause on any other leg, or on no leg (not produced today). */
export const DEADLINE_LABEL = 'no reply by the deadline';
/** The superseded cascade cheap call's label. */
export const SUPERSEDED_LABEL = 'cheap attempt superseded';
/** The trace caption for a recovered request that predates per-attempt capture. */
export const TRACE_NOT_RECORDED = 'attempt history was not recorded for this request';

/* Leg-row contract strings (add-route-trace-cascade-legs design D1, D4, D6, D7). DESIGN.md's
   Route Trace section quotes them exactly. */
/** The cheap leg row's word. */
export const CHEAP_LEG = 'cheap leg';
/** The escalation row's word. */
export const ESCALATION_LEG = 'escalation';
/** The cheap leg row's detail when the row kept nothing the trace can draw for that leg. */
export const ATTEMPTS_NOT_RECORDED = 'attempts not recorded';
/** The escalation cause for `escalation_source = 'quality_gate'`. */
export const CAUSE_QUALITY_GATE = 'quality gate';
/** The escalation cause for `escalation_source = 'cheap_error'`: every other pre-commit
 * escalation (a failed, timed-out or skipped cheap chain, or a replay failure after a passing
 * verdict), so it says only what the value proves. */
export const CAUSE_CHEAP_DID_NOT_SERVE = 'cheap leg did not serve';
/** The kept cheap answer's verdict, before its `q=<score>`. */
export const QUALITY_GATE_PASSED = 'quality gate passed';

/* Route-record contract strings (record-route-legs design D7). DESIGN.md's Route Trace section
   quotes them exactly. */
/** A deferral row's word: `deferred · <model> · <reason>`. */
export const DEFERRED = 'deferred';
/** A deferral reason: the member lacks tool calling. */
export const LACKS_TOOLS = 'lacks tools';
/** A deferral reason: the member lacks vision. */
export const LACKS_VISION = 'lacks vision';
/** A deferral reason: the member lacks both. */
export const LACKS_TOOLS_AND_VISION = 'lacks tools and vision';
/** An output-cap deferral reason's opening words: `output cap <cap> < <ask> asked`. */
export const OUTPUT_CAP = 'output cap';
/** The word after the request's ask, in an output-cap deferral and a served clamp line. */
export const ASKED = 'asked';
/** A clamp's opening words: `output capped at <to>` on an attempt, and `output capped at <to> of
 * <ask> asked` on the lit outcome's own line. */
export const OUTPUT_CAPPED_AT = 'output capped at';
/** An in-flight member's label: `<model> · in flight`. */
export const IN_FLIGHT = 'in flight';
/** The escalation cause for a recorded cheap end of `exhausted`. */
export const CAUSE_CHEAP_EXHAUSTED = 'cheap leg exhausted';
/** The escalation cause for a recorded cheap end of `deadline`. */
export const CAUSE_CHEAP_DEADLINE = 'cheap deadline';
/** The escalation cause for a recorded cheap end of `replay_failed`. */
export const CAUSE_NOT_DELIVERED = 'cheap answer not delivered';
/** The escalation cause for a recorded cheap end of `stopped`. */
export const CAUSE_CHEAP_STOPPED = 'cheap leg stopped';
/** The word before the cheap leg's recorded end time on the escalation row: `· at <time>`. */
export const ENDED_AT = 'at';
/** The commit line's opening words (record-commit-time design D5): `committed at <time>`, the
 * recorded instant the proxy committed to the member that served the stream. It names the commit,
 * never a token: on some upstreams the commit event precedes the first text. */
export const COMMITTED_AT = 'committed at';

const joinDot = (parts: readonly (string | null)[]): string =>
  parts.filter((p): p is string => p !== null).join(' · ');

/** A recorded integer in the dashboard's integer grouping (the price receipt's token counts'):
 * `4,096`, `100,000`. */
const grouped = (n: number): string => n.toLocaleString();

/** `output cap <cap> < <ask> asked`, or `output cap <cap>` when the leg recorded no ask. The `<`
 * compares two token counts; joined as words so it never reads as the retired spaced
 * below-precision money form (`figureStrings.test.ts`). */
export function outputCapText(cap: string, ask: string | null): string {
  return (ask === null ? [OUTPUT_CAP, cap] : [OUTPUT_CAP, cap, '<', ask, ASKED]).join(' ');
}

/** `output capped at <to>`, then ` of <ask> asked` when an ask is given (the lit outcome's
 * line; an attempt's part never states the ask). */
export function clampText(to: string, ask: string | null = null): string {
  return ask === null
    ? `${OUTPUT_CAPPED_AT} ${to}`
    : `${OUTPUT_CAPPED_AT} ${to} of ${ask} ${ASKED}`;
}

/* ---- the route record (record-route-legs design D2, D7) ------------------------------ */

/** The row's route record; a null (every row recorded before the column, and a batch item) or
 * empty one is no record, and every reading below then falls back to what it drew before. */
const routeLegsOf = (r: Pick<RequestRow, 'routeLegs'>): readonly RouteLeg[] => r.routeLegs ?? [];

/** The recorded leg of that name, or undefined. */
const recordedLeg = (
  r: Pick<RequestRow, 'routeLegs'>,
  name: RouteLeg['leg'],
): RouteLeg | undefined => routeLegsOf(r).find((l) => l.leg === name);

/** The record's final leg (its last entry, in execution order), or undefined without one. */
const finalLeg = (r: Pick<RequestRow, 'routeLegs'>): RouteLeg | undefined => routeLegsOf(r).at(-1);

/** The leg a trail entry was walked on: its recorded leg, or `primary` for an untagged entry of
 * a non-cascade chain. Trail and record indexes share one space per leg (design D2). */
const entryLeg = (a: AttemptFailureEntry): RouteLeg['leg'] => a.leg ?? 'primary';

/** The cap a leg's record lists for the member at `index`, grouped, or null. */
function clampOf(leg: RouteLeg | undefined, index: number): string | null {
  const c = leg?.clamps?.find((x) => x.index === index);
  return c === undefined ? null : grouped(c.to);
}

/** A leg's end that names no served member: a final leg that ended so leaves the row's
 * provider and model columns naming that leg's first member, not the member that stopped it
 * (design D8), so the outcome names neither. */
const isStopEnd = (end: RouteLeg['end']): boolean =>
  end === 'stopped' || end === 'cancelled' || end === 'deadline';

/** The escalation cause in words for a recorded cheap-leg end; undefined for an end that states
 * none (`served`, `cancelled`), whose escalation row keeps the `escalation_source` words. */
const CHEAP_END_CAUSE: Readonly<Partial<Record<RouteLeg['end'], string>>> = {
  gate_failed: CAUSE_QUALITY_GATE,
  exhausted: CAUSE_CHEAP_EXHAUSTED,
  deadline: CAUSE_CHEAP_DEADLINE,
  replay_failed: CAUSE_NOT_DELIVERED,
  stopped: CAUSE_CHEAP_STOPPED,
};

/** A deferral's capability reason in words, or null when it names neither capability. */
function lacksText(capabilities: ReadonlySet<string>): string | null {
  const tools = capabilities.has('tools');
  const vision = capabilities.has('vision');
  return tools && vision
    ? LACKS_TOOLS_AND_VISION
    : tools
      ? LACKS_TOOLS
      : vision
        ? LACKS_VISION
        : null;
}

/** A leg's deferral rows (design D7): one per deferred member, in index order, the capability
 * reason first when a member was deferred for both. Empty without a recorded leg. */
function deferralNodes(leg: RouteLeg | undefined): RouteTraceDeferralNode[] {
  const byIndex = new Map<number, RouteDeferral[]>();
  for (const d of leg?.deferred ?? []) byIndex.set(d.index, [...(byIndex.get(d.index) ?? []), d]);
  const ask = leg?.ask === undefined ? null : grouped(leg.ask);
  return [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, ds]) => {
      const capabilities = new Set<string>();
      let cap: number | null = null;
      for (const d of ds) {
        if (d.reason === 'capability') for (const c of d.capabilities) capabilities.add(c);
        else cap ??= d.cap;
      }
      const lacks = lacksText(capabilities);
      const outputCap = cap === null ? null : { cap: grouped(cap), ask };
      const model = ds[0]!.model;
      return {
        kind: 'deferral',
        emphasis: 'neutral',
        model,
        lacks,
        outputCap,
        text: joinDot([
          DEFERRED,
          model,
          lacks,
          outputCap === null ? null : outputCapText(outputCap.cap, outputCap.ask),
        ]),
      };
    });
}

/** The `<kind> · HTTP <status>` label of a dispatched failure, or the kind alone. */
const failureLabel = (kind: string, status: number | null | undefined): string =>
  `${kind}${status !== undefined && status !== null ? ` · HTTP ${String(status)}` : ''}`;

/** An attempt node from its parts; `text` joins them in drawn order. */
function attemptOf(
  emphasis: RouteTraceAttemptNode['emphasis'],
  model: string,
  label: string,
  stop: 'deadline' | null,
  markers: readonly string[] | null,
  clamp: string | null,
): RouteTraceAttemptNode {
  return {
    kind: 'attempt',
    emphasis,
    model,
    label,
    stop,
    markers,
    clamp,
    text: joinDot([model, label, ...(markers ?? []), clamp === null ? null : clampText(clamp)]),
  };
}

/** The sent member a leg's record names as stopping its walk (design D7), drawn as the leg's
 * last node: a failed attempt on a `stopped` end (`<model> · <kind> · HTTP <status>`), an
 * `in_flight` one on a `cancelled` end. Null when the record names no such member, when it was
 * never sent (as for any member the walk did not contact), and when the trail already holds an
 * entry at the same leg and index, as RT-2's deadline cut does: a member is drawn once. A
 * deadline stopper the trail does not hold reads as that entry would. A `stopped` end that
 * recorded neither a kind nor a status has nothing to state and draws none. */
function stopperNode(
  leg: RouteLeg | undefined,
  entries: readonly AttemptFailureEntry[],
): RouteTraceAttemptNode | null {
  const s = leg?.stopped;
  if (leg === undefined || s === undefined || !s.sent || !isStopEnd(leg.end)) return null;
  if (entries.some((a) => entryLeg(a) === leg.leg && a.index === s.index)) return null;
  const clamp = clampOf(leg, s.index);
  switch (leg.end) {
    case 'cancelled':
      return attemptOf('in_flight', s.model, IN_FLIGHT, null, null, clamp);
    case 'deadline':
      return attemptOf(
        'failed',
        s.model,
        leg.leg === 'cheap' ? DEADLINE_LABEL_CHEAP : DEADLINE_LABEL,
        'deadline',
        null,
        clamp,
      );
    default: {
      const label =
        s.kind !== undefined
          ? failureLabel(s.kind, s.status)
          : s.status !== undefined
            ? `HTTP ${String(s.status)}`
            : null;
      return label === null ? null : attemptOf('failed', s.model, label, null, null, clamp);
    }
  }
}

function attemptNode(a: AttemptFailureEntry, leg: RouteLeg | undefined): RouteTraceAttemptNode {
  const skipped = a.dispatched === false;
  // A never-dispatched member reads its skip label whatever else it carries; only a
  // dispatched member can have been cut off by the deadline.
  const stop = !skipped && a.stopReason === 'deadline' ? 'deadline' : null;
  const label = skipped
    ? a.skipReason === 'plan_cooldown'
      ? PAUSE_LABEL
      : SKIP_LABEL
    : stop !== null
      ? a.leg === 'cheap'
        ? DEADLINE_LABEL_CHEAP
        : DEADLINE_LABEL
      : failureLabel(a.kind, a.status);
  // record-route-legs design D7: a clamp the leg's record lists at this entry's index, on a
  // dispatched member only (a skipped one was never sent, so it was never capped).
  const clamp = skipped ? null : clampOf(leg, a.index);
  return attemptOf(
    skipped ? 'skipped' : 'failed',
    a.model,
    label,
    stop,
    normalizeMarkers(a.markers ?? null),
    clamp,
  );
}

/** The escalation row's cause, in words, from the recorded `escalation_source` alone
 * (add-route-trace-cascade-legs design D4): `quality gate`, `cheap leg did not serve`, any
 * other recorded value verbatim, and null (no cause) when none is recorded or the value is
 * blank. Never read from the routing reason. The parameter is a plain string because the view
 * must not blank or error on a value the dashboard has no case for. */
export function escalationCause(source: string | null): string | null {
  if (source === null) return null;
  switch (source) {
    case 'quality_gate':
      return CAUSE_QUALITY_GATE;
    case 'cheap_error':
      return CAUSE_CHEAP_DID_NOT_SERVE;
    default:
      return source.trim() === '' ? null : source;
  }
}

/** Design D2: a cascade request draws leg rows. Keyed on the recorded data as well as the
 * layer, so a recorded leg never loses its statement when the per-attempt tag is gone. */
function isCascadeRequest(r: Pick<RequestRow, 'decisionLayer' | 'attemptFailures'>): boolean {
  return (
    r.decisionLayer === 'cascade' ||
    (r.attemptFailures ?? []).some((a) => a.leg === 'cheap' || a.leg === 'escalation')
  );
}

/** Design D2: a cascade request draws its escalation row when it escalated or recorded an
 * escalation-leg attempt. */
function drawsEscalationRow(r: Pick<RequestRow, 'escalated' | 'attemptFailures'>): boolean {
  return r.escalated || (r.attemptFailures ?? []).some((a) => a.leg === 'escalation');
}

function legNode(
  leg: RouteTraceLeg,
  detail: string | null,
  at: string | null = null,
): RouteTraceLegNode {
  return {
    kind: 'leg',
    emphasis: 'neutral',
    leg,
    detail,
    at,
    text: joinDot([leg, detail, at === null ? null : `${ENDED_AT} ${at}`]),
  };
}

/** The escalation row (record-route-legs design D7): when the route record holds a cheap leg
 * whose end states a cause, that cause and the leg's recorded end time, `… · at <time>`, in the
 * latency format; otherwise RT-1's words for the recorded `escalation_source`, with no time.
 * Never read from the routing reason, the latency or a configured deadline. */
function escalationRow(r: RequestRow): RouteTraceLegNode {
  const cheap = recordedLeg(r, 'cheap');
  const cause = cheap === undefined ? undefined : CHEAP_END_CAUSE[cheap.end];
  return cheap !== undefined && cause !== undefined
    ? legNode(ESCALATION_LEG, cause, fmtLatency(cheap.endedMs))
    : legNode(ESCALATION_LEG, escalationCause(r.escalationSource));
}

/** Design D7: the gate score of a cheap answer the cascade kept: a `cascade` row that did not
 * escalate, was served (`success` / `fallback`) and recorded a signal. A failing verdict always
 * escalates, so a kept answer's score can only have passed; a gate that failed open recorded
 * none, and the node then states no verdict. Null on every other row. */
function keptQuality(
  r: Pick<RequestRow, 'decisionLayer' | 'escalated' | 'status' | 'qualitySignal'>,
): string | null {
  if (r.decisionLayer !== 'cascade' || r.escalated || r.qualitySignal === null) return null;
  if (r.status !== 'success' && r.status !== 'fallback') return null;
  return `q=${r.qualitySignal.toFixed(2)}`;
}

/** Design D4: drawn for an escalated row that records a `quality_gate` source or a non-zero
 * attempt cost. A non-zero attempt cost proves a superseded call ran, even on a row that
 * predates `escalation_source`; a legacy escalation of a free or unpriced cheap call
 * therefore draws nothing, which is what was recorded. */
function supersededNode(
  r: RequestRow,
  attemptParts: readonly FigurePart[],
): RouteTraceSupersededNode | null {
  if (!r.escalated) return null;
  if (r.escalationSource !== 'quality_gate' && r.attemptCostMicros <= 0) return null;
  const quality =
    r.escalationSource === 'quality_gate' && r.qualitySignal !== null
      ? `q=${r.qualitySignal.toFixed(2)}`
      : null;
  const cost = r.attemptCostMicros > 0 ? attemptParts : null;
  return {
    kind: 'superseded',
    emphasis: 'neutral',
    quality,
    costParts: cost,
    text: joinDot([SUPERSEDED_LABEL, quality, cost === null ? null : partsText(cost)]),
  };
}

/** The provider an unlit outcome names (flag RF-1, option 1): `providerLabel ?? providerId`,
 * but only when the row shows it was the last provider tried. The recorder records a failed
 * or cancelled walk against its final leg's FIRST member (`failedContext` → `meta[0]`, and a
 * cascade leg's `servedFrom(…, 0, …)`), not the member that ended the walk. So:
 * - an exhausted chain names it only when its terminal entry, the last member tried, is on
 *   that provider;
 * - any other row names it only when no recorded attempt is on that provider. The member
 *   that ended such a walk never enters the trail (a non-retryable stop's or a post-commit
 *   failure's error is not a recorded failure), so a recorded provider that the trail also
 *   holds may be the leg's first member rather than the last one tried.
 * Null leaves the outcome's text as it read before. The trail is kept on `error`, `fallback`
 * and `cancelled` rows and on an escalated `success` (record-route-legs design D6); a
 * `cancelled` row recorded before that kept none, so it names the recorded member, as the
 * outcome already names its model.
 *
 * A row with a route record reads this only when its final leg ended `exhausted` or with an
 * end the outcome rule does not name (record-route-legs design D7, `outcomeNode`). */
function unlitProvider(r: RequestRow): string | null {
  const provider = r.providerLabel ?? r.providerId;
  if (provider === null) return null;
  const entries = r.attemptFailures ?? [];
  const terminal = entries.find((a) => a.terminal === true);
  const lastTried =
    terminal !== undefined
      ? terminal.providerId === r.providerId
      : entries.every((a) => a.providerId !== r.providerId);
  return lastTried ? provider : null;
}

/** The served member's recorded clamp (record-route-legs design D7): on a final leg that ended
 * `served`, a clamp the leg lists at its `servedIndex`, with the leg's recorded ask. */
function servedClamp(final: RouteLeg | undefined): RouteTraceOutcomeNode['clamp'] {
  if (final?.end !== 'served' || final.servedIndex === undefined) return null;
  const to = clampOf(final, final.servedIndex);
  return to === null ? null : { to, ask: final.ask === undefined ? null : grouped(final.ask) };
}

/** Design D3: exactly one outcome node; lit only for `success` / `fallback`. An unlit
 * outcome names the recorded provider first when `unlitProvider` allows it. A kept cheap
 * answer also states its passing verdict after the latency (add-route-trace-cascade-legs
 * design D7).
 *
 * A row with a route record (record-route-legs design D7, D8): its provider and model columns
 * name a failed or cancelled leg's FIRST member, so when the final leg ended `stopped`,
 * `cancelled` or `deadline` (sent or not) the unlit outcome names neither, and the stopping
 * member, when sent, is the leg's own last node. A final leg that ended `served` (a failure or
 * cancel after commit) names the recorded provider and model, the committed member's. Any other
 * end (`exhausted` above all) keeps the rule a row without a record reads. A lit outcome states
 * its served member's recorded clamp on its own line. Any outcome whose row records a commit time
 * states it on its own line (record-commit-time). */
function outcomeNode(r: RequestRow): RouteTraceOutcomeNode {
  const latency = requestLatency(r);
  // record-commit-time D6: the recorded commit time, on every outcome that has one — a row with
  // none (buffered, a replayed cheap answer, never committed, a batch item, or recorded before
  // the column) draws no line and never a zero.
  const commitTime =
    typeof r.committedMs === 'number' && Number.isFinite(r.committedMs)
      ? fmtLatency(r.committedMs)
      : null;
  const recordedModel = r.modelLabel ?? r.modelId;
  const recordedProvider = r.providerLabel ?? r.providerId;
  const node = (
    emphasis: 'lit' | 'neutral',
    provider: string | null,
    model: string | null,
    result: string,
    kept: string | null = null,
    clamp: RouteTraceOutcomeNode['clamp'] = null,
  ): RouteTraceOutcomeNode => ({
    kind: 'outcome',
    emphasis,
    provider,
    model,
    result,
    latency,
    keptQuality: kept,
    clamp,
    committed: commitTime,
    text: joinDot([
      provider,
      model,
      result,
      latency,
      clamp === null ? null : clampText(clamp.to, clamp.ask),
      commitTime === null ? null : `${COMMITTED_AT} ${commitTime}`,
      ...(kept === null ? [] : [QUALITY_GATE_PASSED, kept]),
    ]),
  });
  const final = finalLeg(r);
  const stopped = final !== undefined && isStopEnd(final.end);
  const committed = final?.end === 'served';
  // `request_log.status` is free-form text at the database (`RequestStatus` is a known
  // status or any string), so an unrecognised value takes the default branch.
  const status = r.status;
  switch (status) {
    case 'success':
    case 'fallback':
      return node(
        'lit',
        recordedProvider,
        recordedModel,
        'served',
        keptQuality(r),
        servedClamp(final),
      );
    case 'error':
      if (stopped) return node('neutral', null, null, 'failed');
      if (committed) return node('neutral', recordedProvider, recordedModel, 'failed');
      // An exhausted chain's terminal member is already the last attempt node, so the
      // outcome does not name a model again; any other error names the recorded one.
      return node(
        'neutral',
        unlitProvider(r),
        (r.attemptFailures ?? []).some((a) => a.terminal === true) ? null : recordedModel,
        'failed',
      );
    case 'cancelled':
      if (stopped) return node('neutral', null, null, 'cancelled by client');
      if (committed) return node('neutral', recordedProvider, recordedModel, 'cancelled by client');
      return node('neutral', unlitProvider(r), recordedModel, 'cancelled by client');
    default:
      // Verbatim, never blank: an empty value reads `unknown`, as the status badge does.
      return node(
        'neutral',
        stopped ? null : unlitProvider(r),
        null,
        status === '' ? 'unknown' : status,
      );
  }
}

/** The attempt ledger's parts at four decimals (adopt-figure-states flag F1, kept here as
 * design D4): `· est.` exactly when `attemptCostMicros > 0 && priceEstimated &&
 * !isEstimateSource(priceSource)`. The rolled-up flag can then only have come from an
 * attempt. When the served price is itself an estimate the listing cannot tell whether an
 * attempt was estimated too, so the figure stays unmarked and the total carries `· est.`. */
function attemptCostParts(r: RequestRow): readonly FigurePart[] {
  return costParts({
    kind: 'amount',
    micros: r.attemptCostMicros,
    text: money(r.attemptCostMicros, 'four'),
    priceEstimated: r.attemptCostMicros > 0 && r.priceEstimated && !isEstimateSource(r.priceSource),
  });
}

function buildRouteTrace(r: RequestRow, attemptParts: readonly FigurePart[]): RouteTraceNode[] {
  const entries = r.attemptFailures ?? [];
  // Design D2: split the stored array after its last cheap-leg entry, and never sort it.
  // Entry indexes are leg-relative, so they collide across legs; the stored order is the
  // walk order, cheap leg first. With no cheap entry the split is at 0, so a primary chain
  // keeps its whole array in stored order and a superseded node follows the decision.
  const boundary = entries.findLastIndex((a) => a.leg === 'cheap') + 1;
  // record-route-legs design D7: each entry reads its leg's record for a clamp at its index.
  const toNode = (a: AttemptFailureEntry): RouteTraceAttemptNode =>
    attemptNode(a, recordedLeg(r, entryLeg(a)));
  const cheapEntries = entries.slice(0, boundary).map(toNode);
  const laterEntries = entries.slice(boundary).map(toNode);
  const superseded = supersededNode(r, attemptParts);
  const layer = r.decisionLayer;
  const head: RouteTraceNode[] = [
    { kind: 'source', emphasis: 'neutral', text: agentRunLabel(r) },
    { kind: 'decision', emphasis: 'neutral', layer, text: `router · ${layer}` },
  ];
  const supersededNodes = superseded === null ? [] : [superseded];
  /** A leg's sent stopper as its last node, when the record names one to draw (design D7). */
  const stopper = (leg: RouteLeg | undefined): RouteTraceNode[] => {
    const node = stopperNode(leg, entries);
    return node === null ? [] : [node];
  };
  if (!isCascadeRequest(r)) {
    // A primary chain: its deferral rows after the decision chip, its stopper after its trail.
    const primary = recordedLeg(r, 'primary');
    return [
      ...head,
      ...deferralNodes(primary),
      ...cheapEntries,
      ...supersededNodes,
      ...laterEntries,
      ...stopper(primary),
      outcomeNode(r),
    ];
  }
  // add-route-trace-cascade-legs design D3: a `cheap leg` row, the cheap half and the
  // superseded call under it, then the `escalation` row with its recorded cause and the
  // remaining entries. A request that did not escalate draws no escalation row, and every
  // entry sits under the cheap leg row. record-route-legs design D7: each leg's deferral rows
  // directly under its leg row, and its sent stopper after its trail (before the superseded
  // call, which sits after the cheap leg's attempt nodes).
  const cheap = recordedLeg(r, 'cheap');
  const escalated = recordedLeg(r, 'escalation');
  const escalation = drawsEscalationRow(r);
  // Design D6: say so when the row kept nothing the trace can draw for the cheap leg. A route
  // record that holds a cheap leg never needs the note: its escalation row states how that leg
  // ended (record-route-legs design D7).
  const cheapUnrecorded =
    escalation && cheapEntries.length === 0 && superseded === null && cheap === undefined;
  return [
    ...head,
    legNode(CHEAP_LEG, cheapUnrecorded ? ATTEMPTS_NOT_RECORDED : null),
    ...deferralNodes(cheap),
    ...cheapEntries,
    ...stopper(cheap),
    ...supersededNodes,
    ...(escalation ? [escalationRow(r), ...deferralNodes(escalated)] : []),
    ...laterEntries,
    ...(escalation ? stopper(escalated) : []),
    outcomeNode(r),
  ];
}

/** The request's recorded route as an ordered node list (design D1): a source node, the
 * decision chip, the leg rows a cascade request draws, the deferral rows its route record lists,
 * one node per recorded attempt in stored walk order (with the superseded cascade call between
 * the legs), the sent member its route record names as stopping a walk, and one outcome node.
 * Built from this row alone: never from a chain member the request did not walk (a recorded
 * deferral names one in words, on the spine), from the routing reason, or from current routing
 * configuration. A commit time is drawn only from the recorded `committedMs` (record-commit-time),
 * never derived from the latency or a leg's `endedMs`. */
export function toRouteTrace(r: RequestRow): RouteTraceNode[] {
  return buildRouteTrace(r, attemptCostParts(r));
}

/** The trace caption (design D1): only a recovered (`fallback`) row with no recorded
 * attempts says so. An `error` or `success` row without attempts cannot be told apart from
 * a walk that stopped at, or was served by, its first member, so it shows none. */
export function routeTraceCaption(
  r: Pick<RequestRow, 'status' | 'attemptFailures'>,
): string | null {
  return r.status === 'fallback' && r.attemptFailures === null ? TRACE_NOT_RECORDED : null;
}

/** The recorded terminal attempt was a breaker skip — keyed off the recorder-set
 * marker, never inferred from kind-matching (an earlier skip beside a
 * `bad_request` stop must not present as terminal). */
export function isTerminalSkip(r: RequestRow): boolean {
  return (r.attemptFailures ?? []).some((a) => a.terminal === true && a.dispatched === false);
}

/** Why the recorded terminal skip happened: the terminal-marked, never-dispatched entry's own
 * `skipReason`. Null when there is no terminal skip or it carries no reason (circuit open). */
export function terminalSkipReason(r: RequestRow): 'plan_cooldown' | null {
  const terminal = (r.attemptFailures ?? []).find(
    (a) => a.terminal === true && a.dispatched === false,
  );
  return terminal?.skipReason === 'plan_cooldown' ? 'plan_cooldown' : null;
}

/** Trim; empty string → null (a junk empty value must not summon the card). */
function normalizeDetail(v: string | null): string | null {
  if (v === null) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/** The ERROR-card gate + headline rules. Card only for `status === 'error'`
 * AND ≥1 normalized field — legacy all-null error rows and non-error rows
 * (even ones carrying stray non-null detail) render exactly as before. The
 * FIVE error-detail fields normalize here (fix-bad-request-dead-end); an empty
 * marker list normalizes to null exactly as an empty string does. */
export function toErrorView(r: RequestRow): ErrorView | null {
  if (r.status !== 'error') return null;
  const kind = normalizeDetail(r.errorKind);
  const message = normalizeDetail(r.errorMessage);
  const requestId = normalizeDetail(r.errorRequestId);
  const status = r.errorStatus;
  const markers = normalizeMarkers(r.errorMarkers);
  if (
    kind === null &&
    message === null &&
    requestId === null &&
    status === null &&
    markers === null
  ) {
    return null;
  }
  const headline =
    kind !== null && status !== null
      ? `${kind} · HTTP ${String(status)}`
      : (kind ?? (status !== null ? `HTTP ${String(status)}` : ''));
  return { headline, message, requestId, markers };
}

/** Empty list → null, so the card drops the row rather than rendering an empty
 * diagnosis. Values arrive already allowlisted; trimming is belt to that. */
function normalizeMarkers(v: readonly string[] | null): readonly string[] | null {
  if (v === null) return null;
  const out = v.map((m) => m.trim()).filter((m) => m !== '');
  return out.length > 0 ? out : null;
}

/* ---- the price receipt (add-route-trace-inspector design D8) ------------------------ */

/** The receipt caption for a synchronous row: its snapshot is fixed when it completes. */
export const SNAPSHOT_CAPTION_SYNC = 'Recorded with the request — later price changes never apply.';
/** The receipt caption for a batch-priced row: its snapshot is fixed at the job's submission. */
export const SNAPSHOT_CAPTION_BATCH = 'Batch rate, recorded at submission.';
/** The note under a `billed = false` row's receipt (zero-cost-unbilled-errors). About the
 * SERVED call only, so it stays true when an attempt line carries real cost. */
export const NOT_BILLED_NOTE =
  'Not billed — the served call was never sent or was rejected by the provider, so nothing was charged for it.';
/** The note under a receipt whose provider omitted usage (adopt-figure-states). */
export const USAGE_ESTIMATED_NOTE = 'Provider omitted usage — token counts are estimated.';

/** One token row: the count group (the exact count with digit grouping, then `· est. usage`
 * when usage was estimated, since every count on such a row is an estimate) and the price
 * group (the snapshot's own parts). */
function tokenRow(
  label: ReceiptTokenRow['label'],
  count: number | null,
  price: PriceSnapshotView,
  usageEstimated: boolean,
): ReceiptTokenRow {
  const countParts: readonly FigurePart[] | null =
    count === null
      ? null
      : [
          { text: count.toLocaleString(), tone: 'slot' },
          ...(usageEstimated ? EST_USAGE_PARTS : []),
        ];
  return {
    label,
    countParts,
    priceParts: price.parts,
    text:
      countParts === null
        ? partsText(price.parts)
        : `${partsText(countParts)} × ${partsText(price.parts)}`,
  };
}

/** RequestRow → the inspector view-model. Reads snapshots only; a null served
 * `cost` surfaces as "unpriced" (never $0.00). */
export function toInspectorView(r: RequestRow): InspectorView {
  const servedParts = costParts(
    requestCostState({
      ...r,
      attemptCostMicros: 0,
      priceEstimated: isEstimateSource(r.priceSource),
    }),
  );
  const attemptParts = attemptCostParts(r);
  const totalParts = rowCostParts(r);
  const prices = [
    priceView('input', r.inputPriceSnapshot, r.priceSource),
    priceView('output', r.outputPriceSnapshot, r.priceSource),
    priceView('cache read', r.cacheReadPriceSnapshot, r.priceSource),
    priceView('cache write', r.cacheWritePriceSnapshot, r.priceSource),
  ] as const;
  const [inputPrice, outputPrice, cacheReadPrice, cacheWritePrice] = prices;
  const tokenRows: ReceiptTokenRow[] = [
    tokenRow('input', r.inputTokens, inputPrice, r.usageEstimated),
    tokenRow('output', r.outputTokens, outputPrice, r.usageEstimated),
  ];
  // A cache class renders when its count OR its snapshot is recorded, so no recorded
  // snapshot disappears; with neither there is nothing to state (design D8 item 2).
  if (r.cacheReadTokens !== null || r.cacheReadPriceSnapshot !== null) {
    tokenRows.push(tokenRow('cache read', r.cacheReadTokens, cacheReadPrice, r.usageEstimated));
  }
  if (r.cacheWriteTokens !== null || r.cacheWritePriceSnapshot !== null) {
    tokenRows.push(tokenRow('cache write', r.cacheWriteTokens, cacheWritePrice, r.usageEstimated));
  }
  const priceSourceLabel =
    r.priceSource === null
      ? null
      : r.priceSource === 'native_family'
        ? 'native family · estimate'
        : r.priceSource === 'listed'
          ? 'provider-listed · estimate'
          : r.priceSource;
  const batchPriced = r.priceMode === 'batch';
  return {
    title: labelOf(r.modelLabel, r.modelId),
    id: r.id,
    createdAtMs: new Date(r.createdAt).getTime(),
    status: r.status,
    tier: r.tierAssigned,
    recordedProvider: outcomeNode(r).provider === null ? (r.providerLabel ?? r.providerId) : null,
    decisionLayer: r.decisionLayer,
    routingReason: r.routingReason,
    matchedHeader:
      r.routingHeaderName === null
        ? null
        : r.routingHeaderValue === null
          ? r.routingHeaderName
          : `${r.routingHeaderName}: ${r.routingHeaderValue}`,
    escalated: r.escalated,
    // add-route-trace-cascade-legs design D8: on a `cheap_error` escalation the recorded signal
    // is not the gate's verdict on the escalation (the proxy writes a placeholder 0, or a
    // passing score whose replay failed), so the Decision section draws no row for it. The
    // verbatim routing reason keeps its `(q=…)`. record-route-legs design D7: a route record
    // whose cheap leg ended `replay_failed` says which: that answer passed the gate, so its
    // signal is the real score and the row renders it.
    qualitySignal:
      r.escalationSource === 'cheap_error' && recordedLeg(r, 'cheap')?.end !== 'replay_failed'
        ? null
        : r.qualitySignal,
    semanticSource: r.semanticSource,
    semanticBand: r.semanticBand,
    workloadClass: r.workloadClass,
    workloadSource: r.workloadSource,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheWriteTokens: r.cacheWriteTokens,
    prices: [...prices],
    servedCost: partsText(servedParts),
    servedParts,
    attemptCost: partsText(attemptParts),
    attemptParts,
    attemptsRowParts: r.attemptCostMicros > 0 ? attemptParts : null,
    receiptCaption:
      r.cost === null ? null : batchPriced ? SNAPSHOT_CAPTION_BATCH : SNAPSHOT_CAPTION_SYNC,
    tokenRows,
    receiptSource:
      priceSourceLabel === null
        ? null
        : batchPriced
          ? `batch · ${priceSourceLabel}`
          : priceSourceLabel,
    receiptNote:
      r.billed === false ? NOT_BILLED_NOTE : r.usageEstimated ? USAGE_ESTIMATED_NOTE : null,
    totalCost: partsText(totalParts),
    totalParts,
    totalMicros: totalCostMicros(r),
    notBilled: r.billed === false,
    usageEstimated: r.usageEstimated,
    priceSourceLabel,
    priceEstimated: r.priceEstimated,
    durationMs: r.durationMs,
    batchId: r.batchId,
    batchPriced,
    errorView: toErrorView(r),
    trace: buildRouteTrace(r, attemptParts),
    traceCaption: routeTraceCaption(r),
    terminalSkipped: isTerminalSkip(r),
    terminalSkipReason: terminalSkipReason(r),
  };
}

/** What a group boundary shows when a row's agent cannot be named — a keyless
 * request, a deleted agent, or an id denormalized from another tenant (which the
 * owner-scoped label resolver deliberately leaves null).
 *
 * Matches the per-agent analytics precedent so the two surfaces say the same
 * thing about the same rows. NOT `labelOf`: that falls back to the raw id, and
 * the table must never render one (add-agent-request-attribution). */
export const AGENT_UNATTRIBUTED = '(no agent)';

/** Does `rows[i]` begin a new agent run?
 *
 * Compared on `agentId`, never on the label: two agents may share a NAME, and a
 * keyless row followed by a deleted agent's row both label as null while being
 * different agents. Index 0 always begins a run when there are rows, so the
 * first group is labelled like every other. */
export function startsAgentRun(rows: readonly Pick<RequestRow, 'agentId'>[], i: number): boolean {
  const row = rows[i];
  if (row === undefined) return false;
  if (i === 0) return true;
  return row.agentId !== rows[i - 1]?.agentId;
}

/** The boundary's text for a row. Never the raw `agentId`. */
export function agentRunLabel(row: Pick<RequestRow, 'agentLabel'>): string {
  return row.agentLabel ?? AGENT_UNATTRIBUTED;
}

/** A deleted agent still owns its history, so its rows still return — but its
 * owner-scoped label no longer resolves. Distinct from `AGENT_UNATTRIBUTED`:
 * that is traffic with NO agent id, which cannot be filtered at all. */
export const AGENT_DELETED = '(deleted agent)';

/** One entry in the Overview agent strip. `filterable` is false ONLY for keyless
 * traffic: an empty agent id is rejected by the listing (400), so offering the
 * click-through would present a broken action. */
export interface AgentStripEntry {
  readonly key: string;
  readonly label: string;
  readonly requests: number;
  readonly filterable: boolean;
}

/** Breakdown rows -> strip entries. PURE.
 *
 * Keyless traffic arrives under the endpoint's empty-string key; it is KEPT (an
 * omitted row silently under-reports the total) but not made actionable. Rows
 * with no activity never arrive at all, so "absent" needs no special case. */
export function toAgentStrip(rows: readonly BreakdownRow[]): AgentStripEntry[] {
  return rows.map((r) => ({
    key: r.key,
    label: r.key === '' ? AGENT_UNATTRIBUTED : (r.label ?? AGENT_DELETED),
    requests: r.requests,
    filterable: r.key !== '',
  }));
}
