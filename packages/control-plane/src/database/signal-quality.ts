/**
 * Pure per-agent signal-quality assembly (add-auto-signal-honesty). The SQL
 * side delivers two grouped result sets — per-agent totals and per-(agent,
 * 2-decimal bucket) ambiguous counts; THIS module owns every judgment call so
 * it is unit-testable without a database: modal selection (most rows wins;
 * equal rows break toward the LOWEST bucket — deterministic), the null-shaped
 * zero-ambiguous case (never NaN), the tri-state verdict (floor → null, never
 * an accusation), and owner-scoped label attachment (keyless/deleted/foreign
 * ids stay null — the resolver already dropped anything not owned).
 */
import {
  SIGNAL_QUALITY_COLLAPSE_SHARE,
  SIGNAL_QUALITY_MIN_ROWS,
  type AgentSignalQuality,
} from '@polyrouter/shared/server';

export interface SignalQualityAgentAgg {
  agentId: string | null;
  bandedRows: number;
  ambiguousRows: number;
  distinctScores: number;
}

export interface SignalQualityBucketAgg {
  agentId: string | null;
  /** `round(structural_score::numeric, 2)::float8` — the operator-facing
   * 2-decimal score bucket. */
  bucket: number;
  rows: number;
}

export function computeSignalQuality(
  perAgent: readonly SignalQualityAgentAgg[],
  perBucket: readonly SignalQualityBucketAgg[],
  labels: ReadonlyMap<string, string>,
): AgentSignalQuality[] {
  // Modal bucket per agent: most rows wins; a TIE keeps the lowest bucket.
  const modal = new Map<string | null, { bucket: number; rows: number }>();
  for (const b of perBucket) {
    const cur = modal.get(b.agentId);
    if (
      cur === undefined ||
      b.rows > cur.rows ||
      (b.rows === cur.rows && b.bucket < cur.bucket)
    ) {
      modal.set(b.agentId, { bucket: b.bucket, rows: b.rows });
    }
  }
  const out = perAgent.map((r): AgentSignalQuality => {
    const m = r.ambiguousRows > 0 ? (modal.get(r.agentId) ?? null) : null;
    const modalShare = m === null ? null : m.rows / r.ambiguousRows;
    return {
      agentId: r.agentId,
      label: r.agentId === null ? null : (labels.get(r.agentId) ?? null),
      bandedRows: r.bandedRows,
      ambiguousRows: r.ambiguousRows,
      distinctScores: r.distinctScores,
      modalScore: m === null ? null : m.bucket,
      modalShare,
      collapsed:
        r.ambiguousRows >= SIGNAL_QUALITY_MIN_ROWS
          ? modalShare !== null && modalShare >= SIGNAL_QUALITY_COLLAPSE_SHARE
          : null,
    };
  });
  // Stable, meaningful order: most traffic first; keyless last among ties.
  out.sort(
    (a, b) =>
      b.bandedRows - a.bandedRows ||
      (a.agentId ?? '￿').localeCompare(b.agentId ?? '￿'),
  );
  return out;
}
