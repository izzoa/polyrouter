import type { SemanticLearningEvent, SemanticLearningStatus } from './api';

/** View-model for the Routing page's L2 learning card (add-semantic-dashboard
 * D3). Pure — every display rule is unit-testable, mirroring the calibration
 * card's VM. No claim of learning EFFECTIVENESS is rendered (clink set-Med-5):
 * only what has been absorbed, which source is active, and how to undo it. */
export interface SemanticLearningVm {
  enabled: boolean;
  /** `learning from 12 low · 5 high` — the fresh pending sample counts. */
  samplesLine: string;
  /** The currently-active classification source. */
  source: 'learned' | 'bundled';
  /** Present-tense one-liner: `active: learned centroids` / `active: bundled anchors`. */
  sourceLine: string;
  /** `applied Jul 3, 2026` or `never applied`. */
  lastAppliedLine: string;
  /** Honest degradation: a promoted centroid that is inactive (model/revision
   * changed) shows `source: bundled` WITH this reason — never a silent wrong
   * "learned" badge. Null when not stale. */
  staleReason: string | null;
  /** Revert is offered whenever a centroid has been promoted this epoch —
   * including the stale case (reverting still fences it, idempotently). */
  showRevert: boolean;
  generation: number;
}

const fmtN = (n: number): string => String(Math.round(n * 1000) / 1000);

export function toLearningVm(status: SemanticLearningStatus | null): SemanticLearningVm | null {
  if (status === null) return null;
  const learned = status.source === 'learned';
  // A promoted centroid (generation > 0) that is NOT the active source is stale:
  // the embedder or its revision moved under it, so the router fell back to the
  // bundled anchors. Surface that, never a wrong "learned" claim.
  const stale = status.generation > 0 && !learned;
  return {
    enabled: status.enabled,
    samplesLine: `learning from ${status.freshLow.toLocaleString()} low · ${status.freshHigh.toLocaleString()} high`,
    source: status.source,
    sourceLine: learned ? 'active: learned centroids' : 'active: bundled anchors',
    lastAppliedLine:
      status.lastAppliedAt !== null
        ? `applied ${new Date(status.lastAppliedAt).toLocaleDateString()}`
        : 'never applied',
    staleReason: stale
      ? 'a learned centroid exists but is inactive (embedder or revision changed) — routing on bundled anchors'
      : null,
    showRevert: status.generation > 0,
    generation: status.generation,
  };
}

export interface SemanticLearningHistoryRowVm {
  id: string;
  date: string;
  /** `apply` / `discard_revision` / `revert`. */
  trigger: string;
  /** `12 low · 5 high` — the samples that fed this sweep. */
  samples: string;
  /** `drift 0.03/0.05 · sim 0.97/0.95` (low/high) — numeric evidence, empty when absent. */
  evidence: string;
  reason: string;
}

export function toLearningHistoryRows(
  events: SemanticLearningEvent[],
): SemanticLearningHistoryRowVm[] {
  return events.map((e) => {
    const parts: string[] = [];
    if (e.lowDrift !== null || e.highDrift !== null) {
      parts.push(`drift ${fmtN(e.lowDrift ?? 0)}/${fmtN(e.highDrift ?? 0)}`);
    }
    if (e.lowSimilarity !== null || e.highSimilarity !== null) {
      parts.push(`sim ${fmtN(e.lowSimilarity ?? 0)}/${fmtN(e.highSimilarity ?? 0)}`);
    }
    return {
      id: e.id,
      date: new Date(e.createdAt).toLocaleDateString(),
      trigger: e.trigger,
      samples: `${e.lowSamples.toLocaleString()} low · ${e.highSamples.toLocaleString()} high`,
      evidence: parts.join(' · '),
      reason: e.reason,
    };
  });
}
