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
 * uPlot's unit; y = requests per bucket). */
export function timeseriesToChart(points: TimeseriesPoint[]): [number[], number[]] {
  const secs: number[] = [];
  const counts: number[] = [];
  for (const p of points) {
    secs.push(Math.floor(new Date(p.bucket).getTime() / 1000));
    counts.push(p.requests);
  }
  return [secs, counts];
}

/** A breakdown row → a `BarRows` datum (label via the id fallback, spend in USD). */
export function breakdownToSpend(rows: BreakdownRow[]): SpendDatum[] {
  return rows.map((r) => ({ n: labelOf(r.label, r.key === '' ? null : r.key), v: r.spend }));
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
      return { decisionLayers: ['structural', 'cascade'] };
    case 'fallback':
      return { status: 'fallback' };
    case 'escalated':
      return { escalated: true };
    case 'all':
    default:
      return {};
  }
}

/** The table's total-cost cell: micros-exact total, `~` when usage was estimated. */
export function rowCostLabel(row: RequestRow): string {
  return `${fmtMicros(totalCostMicros(row))}${row.usageEstimated ? '~' : ''}`;
}

export interface PriceSnapshotView {
  label: string;
  /** `$0 free` (snapshot 0) vs `unpriced` (snapshot null) — kept distinct. */
  value: string;
  free: boolean;
  unpriced: boolean;
}

function priceView(label: string, v: number | null): PriceSnapshotView {
  if (v === null) return { label, value: 'unpriced', free: false, unpriced: true };
  if (v === 0) return { label, value: '$0 free', free: true, unpriced: false };
  return { label, value: `$${String(v)} / 1M`, free: false, unpriced: false };
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
  escalated: boolean;
  qualitySignal: number | null;
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
  durationMs: number;
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
    escalated: r.escalated,
    qualitySignal: r.qualitySignal,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheWriteTokens: r.cacheWriteTokens,
    prices: [
      priceView('input', r.inputPriceSnapshot),
      priceView('output', r.outputPriceSnapshot),
      priceView('cache read', r.cacheReadPriceSnapshot),
      priceView('cache write', r.cacheWritePriceSnapshot),
    ],
    servedCost: r.cost === null ? 'unpriced' : fmtMicros(Math.round(r.cost * 1_000_000)),
    attemptCost: fmtMicros(r.attemptCostMicros),
    totalCost: r.cost === null ? 'unpriced' : fmtMicros(totalCostMicros(r)),
    totalMicros: totalCostMicros(r),
    usageEstimated: r.usageEstimated,
    durationMs: r.durationMs,
  };
}
