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
   * (add-route-trace-cascade-legs design D8), and when no signal was recorded. */
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
 * node also states its outcome in its text, so the emphasis only repeats the words. */
export type RouteTraceEmphasis = 'lit' | 'neutral' | 'failed' | 'skipped';

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
   * row kept nothing about (design D6), the recorded escalation cause on an escalation row
   * (design D4); null when there is none. */
  readonly detail: string | null;
}

/** One recorded `attempt_failures` entry (add-fallback-attempt-detail), in stored order. It
 * names the member's model, never its provider (design D10), and carries no leg tag: the leg
 * row above it states the leg (add-route-trace-cascade-legs design D5). */
export interface RouteTraceAttemptNode extends RouteTraceNodeBase {
  readonly kind: 'attempt';
  /** `skipped` for a never-dispatched member, `failed` for a dispatched failure. */
  readonly emphasis: 'failed' | 'skipped';
  readonly model: string;
  /** A dispatched failure's label, `<kind> · HTTP <status>` or the kind alone when no
   * upstream status was recorded; for a member the walk's own deadline cut off, the cause
   * in words (`DEADLINE_LABEL_CHEAP` on the cheap leg, `DEADLINE_LABEL` off it) in place
   * of the kind; `SKIP_LABEL` (or `PAUSE_LABEL`) for a never-dispatched member. */
  readonly label: string;
  /** `deadline` when the label states the walk's deadline in words rather than a kind
   * token (keep-cheap-leg-attempt-trail design D5), so the view sets it as prose, not
   * Mono. Null on every other attempt. */
  readonly stop: 'deadline' | null;
  /** THIS attempt's retained classification (fix-bad-request-dead-end), so a RECOVERED
   * request's trail explains every refusal and not just its kind. Null when the entry
   * carries none (including entries predating capture). */
  readonly markers: readonly string[] | null;
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
}

export type RouteTraceNode =
  | RouteTraceSourceNode
  | RouteTraceDecisionNode
  | RouteTraceLegNode
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

const joinDot = (parts: readonly (string | null)[]): string =>
  parts.filter((p): p is string => p !== null).join(' · ');

function attemptNode(a: AttemptFailureEntry): RouteTraceAttemptNode {
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
      : `${a.kind}${a.status !== undefined && a.status !== null ? ` · HTTP ${String(a.status)}` : ''}`;
  const markers = normalizeMarkers(a.markers ?? null);
  return {
    kind: 'attempt',
    emphasis: skipped ? 'skipped' : 'failed',
    model: a.model,
    label,
    stop,
    markers,
    text: joinDot([a.model, label, ...(markers ?? [])]),
  };
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

function legNode(leg: RouteTraceLeg, detail: string | null): RouteTraceLegNode {
  return { kind: 'leg', emphasis: 'neutral', leg, detail, text: joinDot([leg, detail]) };
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
 * Null leaves the outcome's text as it read before. A `cancelled` row keeps no trail (the
 * recorder stores `attempt_failures` only on `error` and `fallback` rows), so it names the
 * recorded member, as the outcome already names its model. */
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

/** Design D3: exactly one outcome node; lit only for `success` / `fallback`. An unlit
 * outcome names the recorded provider first when `unlitProvider` allows it. A kept cheap
 * answer also states its passing verdict after the latency (add-route-trace-cascade-legs
 * design D7). */
function outcomeNode(r: RequestRow): RouteTraceOutcomeNode {
  const latency = requestLatency(r);
  const recordedModel = r.modelLabel ?? r.modelId;
  const node = (
    emphasis: 'lit' | 'neutral',
    provider: string | null,
    model: string | null,
    result: string,
    kept: string | null = null,
  ): RouteTraceOutcomeNode => ({
    kind: 'outcome',
    emphasis,
    provider,
    model,
    result,
    latency,
    keptQuality: kept,
    text: joinDot([
      provider,
      model,
      result,
      latency,
      ...(kept === null ? [] : [QUALITY_GATE_PASSED, kept]),
    ]),
  });
  // `request_log.status` is free-form text at the database (`RequestStatus` is a known
  // status or any string), so an unrecognised value takes the default branch.
  const status = r.status;
  switch (status) {
    case 'success':
    case 'fallback':
      return node('lit', r.providerLabel ?? r.providerId, recordedModel, 'served', keptQuality(r));
    case 'error':
      // An exhausted chain's terminal member is already the last attempt node, so the
      // outcome does not name a model again; any other error names the recorded one.
      return node(
        'neutral',
        unlitProvider(r),
        (r.attemptFailures ?? []).some((a) => a.terminal === true) ? null : recordedModel,
        'failed',
      );
    case 'cancelled':
      return node('neutral', unlitProvider(r), recordedModel, 'cancelled by client');
    default:
      // Verbatim, never blank: an empty value reads `unknown`, as the status badge does.
      return node('neutral', unlitProvider(r), null, status === '' ? 'unknown' : status);
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
  const cheapEntries = entries.slice(0, boundary).map(attemptNode);
  const laterEntries = entries.slice(boundary).map(attemptNode);
  const superseded = supersededNode(r, attemptParts);
  const layer = r.decisionLayer;
  const head: RouteTraceNode[] = [
    { kind: 'source', emphasis: 'neutral', text: agentRunLabel(r) },
    { kind: 'decision', emphasis: 'neutral', layer, text: `router · ${layer}` },
  ];
  const supersededNodes = superseded === null ? [] : [superseded];
  if (!isCascadeRequest(r)) {
    return [...head, ...cheapEntries, ...supersededNodes, ...laterEntries, outcomeNode(r)];
  }
  // add-route-trace-cascade-legs design D3: a `cheap leg` row, the cheap half and the
  // superseded call under it, then the `escalation` row with its recorded cause and the
  // remaining entries. A request that did not escalate draws no escalation row, and every
  // entry sits under the cheap leg row.
  const escalation = drawsEscalationRow(r);
  // Design D6: say so when the row kept nothing the trace can draw for the cheap leg.
  const cheapUnrecorded = escalation && cheapEntries.length === 0 && superseded === null;
  return [
    ...head,
    legNode(CHEAP_LEG, cheapUnrecorded ? ATTEMPTS_NOT_RECORDED : null),
    ...cheapEntries,
    ...supersededNodes,
    ...(escalation ? [legNode(ESCALATION_LEG, escalationCause(r.escalationSource))] : []),
    ...laterEntries,
    outcomeNode(r),
  ];
}

/** The request's recorded route as an ordered node list (design D1): a source node, the
 * decision chip, the leg rows a cascade request draws, one node per recorded attempt in stored
 * walk order (with the superseded cascade call between the legs), and one outcome node. Built
 * from this row alone: never from a chain member the request did not walk, from the routing
 * reason, from current routing configuration, or from a commit time, which is not recorded. */
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
    // verbatim routing reason keeps its `(q=…)`.
    qualitySignal: r.escalationSource === 'cheap_error' ? null : r.qualitySignal,
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
