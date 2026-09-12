/**
 * Pure per-agent calibration-evidence assembly (add-per-agent-calibration-evidence).
 *
 * The SQL side delivers one grouped result set — per `agent_id`, ten conditional
 * counts. THIS module owns every judgment call so it is unit-testable without a
 * database: the tenant total as the exact sum of its parts (never a second query
 * that could disagree with the group-by), owner-scoped label attachment (keyless,
 * deleted and foreign ids all stay null), and a deterministic order.
 *
 * Mirrors `signal-quality.ts`, which established this split on the same endpoint.
 */
import type {
  CalibrationEdgeViews,
  CalibrationEvidenceData,
  CalibrationEvidenceEntry,
} from '@polyrouter/shared/server';

/** One `GROUP BY agent_id` row. Counts are already integers from the SQL side. */
export interface CalibrationEvidenceAgg {
  agentId: string | null;
  highSamplesCurrent: number;
  highFailuresCurrent: number;
  highSamplesWindow: number;
  highFailuresWindow: number;
  lowSamplesCurrent: number;
  lowFailuresCurrent: number;
  lowSamplesWindow: number;
  lowFailuresWindow: number;
  middleCurrent: number;
  middleWindow: number;
}

const zeroEdge = (): CalibrationEdgeViews => ({
  currentEpoch: { samples: 0, failures: 0 },
  window: { samples: 0, failures: 0 },
});

const addEdge = (
  a: CalibrationEdgeViews,
  samplesCur: number,
  failuresCur: number,
  samplesWin: number,
  failuresWin: number,
): void => {
  a.currentEpoch.samples += samplesCur;
  a.currentEpoch.failures += failuresCur;
  a.window.samples += samplesWin;
  a.window.failures += failuresWin;
};

/** Bound on the rendered agent list (fix-calibration-evidence-honesty). The
 * sibling breakdown endpoint caps at 100; an unbounded list is both an
 * unbounded label `IN (...)` and an unbounded DOM. The TOTAL is unaffected —
 * see below. */
export const CALIBRATION_EVIDENCE_AGENT_CAP = 50;

export function computeCalibrationEvidence(
  rows: readonly CalibrationEvidenceAgg[],
  labels: ReadonlyMap<string, string>,
): CalibrationEvidenceData {
  const total: CalibrationEvidenceEntry = {
    agentId: null,
    label: null,
    highEdge: zeroEdge(),
    lowEdge: zeroEdge(),
    middleRows: { currentEpoch: 0, window: 0 },
  };

  const agents = rows.map((r): CalibrationEvidenceEntry => {
    // The TOTAL is the sum of the groups, by construction. A separate aggregate
    // query could disagree with the group-by under any predicate drift, and the
    // disagreement would be invisible — the whole point of this read is that its
    // numbers can be trusted against the calibrator's.
    addEdge(
      total.highEdge,
      r.highSamplesCurrent,
      r.highFailuresCurrent,
      r.highSamplesWindow,
      r.highFailuresWindow,
    );
    addEdge(
      total.lowEdge,
      r.lowSamplesCurrent,
      r.lowFailuresCurrent,
      r.lowSamplesWindow,
      r.lowFailuresWindow,
    );
    total.middleRows.currentEpoch += r.middleCurrent;
    total.middleRows.window += r.middleWindow;

    const highEdge = zeroEdge();
    addEdge(
      highEdge,
      r.highSamplesCurrent,
      r.highFailuresCurrent,
      r.highSamplesWindow,
      r.highFailuresWindow,
    );
    const lowEdge = zeroEdge();
    addEdge(
      lowEdge,
      r.lowSamplesCurrent,
      r.lowFailuresCurrent,
      r.lowSamplesWindow,
      r.lowFailuresWindow,
    );
    return {
      agentId: r.agentId,
      // A keyless row has no id to resolve; a deleted agent and an id
      // denormalized from ANOTHER tenant both miss the owner-scoped resolver.
      // All three stay null — a foreign id never surfaces another tenant's name.
      label: r.agentId === null ? null : (labels.get(r.agentId) ?? null),
      highEdge,
      lowEdge,
      middleRows: { currentEpoch: r.middleCurrent, window: r.middleWindow },
    };
  });

  // Stable, meaningful order: most window evidence first, keyless last among
  // ties — the same ordering rule the signal-quality list uses.
  agents.sort(
    (a, b) =>
      b.highEdge.window.samples +
      b.lowEdge.window.samples -
      (a.highEdge.window.samples + a.lowEdge.window.samples) ||
      (a.agentId ?? '￿').localeCompare(b.agentId ?? '￿'),
  );
  // Truncate AFTER the total has been accumulated over every row above. Summing
  // the visible subset instead would silently under-report the figure the
  // calibrator evaluates — the one number on this block that must be exact.
  const truncated = agents.length > CALIBRATION_EVIDENCE_AGENT_CAP;
  return {
    total,
    agents: truncated ? agents.slice(0, CALIBRATION_EVIDENCE_AGENT_CAP) : agents,
    truncated,
  };
}
