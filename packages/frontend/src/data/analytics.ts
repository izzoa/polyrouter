import type { RequestFilter, SpendDatum } from '../types';
import {
  fmtMicros,
  labelOf,
  totalCostMicros,
  type AnalyticsSummary,
  type BreakdownRow,
  type RequestRow,
  type RequestsQuery,
  type RequestStatus,
  type TimeseriesPoint,
} from './api';

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

/** A percentage string (guards an empty range → `0.0%`, never NaN). */
export function pct(num: number, denom: number): string {
  return `${(rate(num, denom) * 100).toFixed(1)}%`;
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

/** Compact token counts — a bar label has no room for `1,234,567`. */
export function fmtTokens(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(Math.round(v));
}

export type RequestFilterParams = Pick<RequestsQuery, 'status' | 'escalated' | 'decisionLayers'>;

/** The dashboard's filter chip → server-side query params (Decision 1). All chips
 * map to server filters so keyset pagination never returns an empty filtered page
 * mid-cursor. `explicit` covers deterministic routing incl. a smart request that
 * fell through to `default`. */
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

/** The table's total-cost cell: micros-exact total, `~` when the cost is an
 * estimate — usage estimated OR the price is estimated (native-family/listed),
 * matching the inspector's `· est.` marking. */
export function rowCostLabel(row: RequestRow): string {
  return `${fmtMicros(totalCostMicros(row))}${row.usageEstimated || row.priceEstimated ? '~' : ''}`;
}

export interface PriceSnapshotView {
  label: string;
  /** `$0 free` (snapshot 0) vs `unpriced` (snapshot null) — kept distinct. */
  value: string;
  free: boolean;
  unpriced: boolean;
}

function priceView(
  label: string,
  v: number | null,
  source: string | null = null,
): PriceSnapshotView {
  if (v === null) return { label, value: 'unpriced', free: false, unpriced: true };
  // native-family (adjacent channel) and listed (provider's own) snapshots are
  // estimates — marked on EVERY priced row, the zero-priced (free) case included.
  const est = source === 'native_family' || source === 'listed' ? ' · est.' : '';
  if (v === 0) return { label, value: `$0 free${est}`, free: true, unpriced: false };
  return { label, value: `$${String(v)} / 1M${est}`, free: false, unpriced: false };
}

export interface InspectorView {
  title: string;
  id: string;
  createdAtMs: number;
  status: RequestStatus;
  agentLabel: string;
  providerLabel: string;
  tier: string | null;
  decisionLayer: string;
  routingReason: string;
  /** The matched routing header rendered as `name: value` (built-in) or the bare
   * name (custom rule — value never recorded); null hides the row entirely
   * (legacy + non-header layers). Gated on the NAME: a stray value without a
   * name (type- and CHECK-impossible) is never rendered. */
  matchedHeader: string | null;
  escalated: boolean;
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
  /** `unpriced` when served `cost` is null — distinct from `$0.0000`. */
  servedCost: string;
  attemptCost: string;
  /** `unpriced` when served `cost` is null (invariant 4 — no recompute). */
  totalCost: string;
  totalMicros: number;
  usageEstimated: boolean;
  /** Rendered price-source line (null hidden); `native_family` reads as an estimate. */
  priceSourceLabel: string | null;
  /** Served OR any attempt priced `native_family` — the TOTAL carries the marker. */
  priceEstimated: boolean;
  durationMs: number;
  /** The ERROR card (add-request-error-detail): non-null ONLY for a status=error
   * row with ≥1 normalized (trimmed, empty→null) detail field. */
  errorView: ErrorView | null;
  /** The structural fallback trail (add-fallback-attempt-detail): one line per
   * recorded attempt; empty for rows without the column (all history) — the
   * section is hidden and the drawer renders exactly as before. */
  attemptTrail: AttemptView[];
  /** True when the recorded terminal-marked attempt was a never-dispatched
   * breaker skip — read from the data, never inferred from kinds. */
  terminalSkipped: boolean;
}

export interface ErrorView {
  /** `rate_limit · HTTP 429` | `rate_limit` | `HTTP 429` — never a blank slot. */
  headline: string;
  message: string | null;
  requestId: string | null;
}

/** One rendered attempt line (add-fallback-attempt-detail). */
export interface AttemptView {
  model: string;
  /** `skipped — circuit open (provider not contacted)` for a never-dispatched
   * entry; the mapped kind (plus ` · HTTP <status>` when recorded) otherwise. */
  label: string;
  /** Cascade leg tag (`cheap`/`escalation`); null for a primary chain. */
  legLabel: string | null;
  skipped: boolean;
}

const SKIP_LABEL = 'skipped — circuit open (provider not contacted)';

/** The per-attempt trail view (add-fallback-attempt-detail): data-driven off the
 * stored column alone — a null column yields an empty trail (legacy rows render
 * exactly as before). */
export function toAttemptTrail(r: RequestRow): AttemptView[] {
  return (r.attemptFailures ?? []).map((a) => ({
    model: a.model,
    label:
      a.dispatched === false
        ? SKIP_LABEL
        : `${a.kind}${a.status !== undefined && a.status !== null ? ` · HTTP ${String(a.status)}` : ''}`,
    legLabel: a.leg ?? null,
    skipped: a.dispatched === false,
  }));
}

/** The recorded terminal attempt was a breaker skip — keyed off the recorder-set
 * marker, never inferred from kind-matching (an earlier skip beside a
 * `bad_request` stop must not present as terminal). */
export function isTerminalSkip(r: RequestRow): boolean {
  return (r.attemptFailures ?? []).some((a) => a.terminal === true && a.dispatched === false);
}

/** Trim; empty string → null (a junk empty value must not summon the card). */
function normalizeDetail(v: string | null): string | null {
  if (v === null) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/** The ERROR-card gate + headline rules. Card only for `status === 'error'`
 * AND ≥1 normalized field — legacy all-null error rows and non-error rows
 * (even ones carrying stray non-null detail) render exactly as before. */
export function toErrorView(r: RequestRow): ErrorView | null {
  if (r.status !== 'error') return null;
  const kind = normalizeDetail(r.errorKind);
  const message = normalizeDetail(r.errorMessage);
  const requestId = normalizeDetail(r.errorRequestId);
  const status = r.errorStatus;
  if (kind === null && message === null && requestId === null && status === null) return null;
  const headline =
    kind !== null && status !== null
      ? `${kind} · HTTP ${String(status)}`
      : (kind ?? (status !== null ? `HTTP ${String(status)}` : ''));
  return { headline, message, requestId };
}

/** RequestRow → the inspector view-model. Reads snapshots only; a null served
 * `cost` surfaces as "unpriced" (never $0.00). */
export function toInspectorView(r: RequestRow): InspectorView {
  return {
    title: labelOf(r.modelLabel, r.modelId),
    id: r.id,
    createdAtMs: new Date(r.createdAt).getTime(),
    status: r.status,
    agentLabel: labelOf(r.agentLabel, r.agentId),
    providerLabel: labelOf(r.providerLabel, r.providerId),
    tier: r.tierAssigned,
    decisionLayer: r.decisionLayer,
    routingReason: r.routingReason,
    matchedHeader:
      r.routingHeaderName === null
        ? null
        : r.routingHeaderValue === null
          ? r.routingHeaderName
          : `${r.routingHeaderName}: ${r.routingHeaderValue}`,
    escalated: r.escalated,
    qualitySignal: r.qualitySignal,
    semanticSource: r.semanticSource,
    semanticBand: r.semanticBand,
    workloadClass: r.workloadClass,
    workloadSource: r.workloadSource,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheWriteTokens: r.cacheWriteTokens,
    prices: [
      priceView('input', r.inputPriceSnapshot, r.priceSource),
      priceView('output', r.outputPriceSnapshot, r.priceSource),
      priceView('cache read', r.cacheReadPriceSnapshot, r.priceSource),
      priceView('cache write', r.cacheWritePriceSnapshot, r.priceSource),
    ],
    servedCost: r.cost === null ? 'unpriced' : fmtMicros(Math.round(r.cost * 1_000_000)),
    attemptCost: fmtMicros(r.attemptCostMicros),
    totalCost:
      r.cost === null
        ? 'unpriced'
        : `${fmtMicros(totalCostMicros(r))}${r.priceEstimated ? ' · est.' : ''}`,
    totalMicros: totalCostMicros(r),
    usageEstimated: r.usageEstimated,
    priceSourceLabel:
      r.priceSource === null
        ? null
        : r.priceSource === 'native_family'
          ? 'native family · estimate'
          : r.priceSource === 'listed'
            ? 'provider-listed · estimate'
            : r.priceSource,
    priceEstimated: r.priceEstimated,
    durationMs: r.durationMs,
    errorView: toErrorView(r),
    attemptTrail: toAttemptTrail(r),
    terminalSkipped: isTerminalSkip(r),
  };
}
