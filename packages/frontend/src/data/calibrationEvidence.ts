/**
 * Calibration-evidence view-model (add-per-agent-calibration-evidence).
 *
 * Pure, so every judgment call here is testable without a DOM. The judgments:
 *
 * 1. **State is per EDGE, not per agent.** An agent routinely sits in different
 *    states on its two edges — 80 high-edge samples beside 0 low-edge samples is
 *    ordinary — so an agent-level verdict would have to discard one of them.
 * 2. **Four states, not three.** `sufficient` (at or above the acting floor) is
 *    the one that matters most and is the easiest to leave out.
 * 3. **A failure rate is reported beside the decision rate.** Counts shown
 *    against a floor imply that reaching the floor causes a move; an edge at 100
 *    samples and a 30% failure rate sits in the hysteresis dead zone and will
 *    never move. Saying so is what keeps the display from being a false promise.
 */
import type { CalibrationEdgeViews, CalibrationEvidence } from './api';

/** Where an edge sits in its evidence lifecycle. */
export type EdgeState =
  /** No decided rows for this edge in the window, under either view. */
  | 'absent'
  /** Rows exist in the window but none in the current epoch, AND a threshold
   * event actually occurred — the event restarted the stream. */
  | 'reset'
  /** The same shape with NO event ever having occurred: the rows predate epoch
   * tracking (a NULL `structural_epoch`, which `= 0` does not match), so they
   * are excluded from the current view by the same rule the calibrator uses.
   * Calling this `reset` would state an event that never happened
   * (fix-calibration-evidence-honesty). The COUNTS are identical either way —
   * folding NULL-epoch rows in would break agreement with the calibrator. */
  | 'unaligned'
  /** Current-epoch rows exist but number fewer than the acting floor. */
  | 'accumulating'
  /** Current-epoch rows meet or exceed the floor. NOT a promise of a move. */
  | 'sufficient';

export interface EdgeVm {
  state: EdgeState;
  /** Current-epoch counts — what the calibrator can act on now. */
  samples: number;
  failures: number;
  /** Every decided row for this edge in the window, whatever its epoch. */
  windowSamples: number;
  /** Current-epoch failure rate in [0,1]; null when there are no samples (never
   * NaN, and never a fabricated 0 that would read as "no failures"). */
  rate: number | null;
  /** The decision rate this edge is judged against. */
  decisionRate: number;
  /** True when the rate has NOT reached its decision bound — the edge sits in
   * the dead zone and will not move however much evidence accrues. */
  inDeadZone: boolean;
}

export interface AgentEvidenceVm {
  agentId: string | null;
  /** Never a raw id: a keyless row, a deleted agent and an id denormalized from
   * another tenant all resolve to null server-side and render as this marker. */
  label: string;
  high: EdgeVm;
  low: EdgeVm;
  middleRows: number;
  middleWindowRows: number;
  /** Both edges empty while decided rows DO exist between the zones. The reader's
   * next question after a collapse flag, and wrong if left to inference. */
  deadMiddle: boolean;
}

export interface CalibrationEvidenceVm {
  windowDays: number;
  high: number;
  low: number;
  edgeWidth: number;
  actingFloor: number;
  enabled: boolean;
  epochStartedAt: string | null;
  /** Calibration is HALTED for this tenant — the calibrator would skip it. */
  contracted: boolean;
  truncated: boolean;
  agents: AgentEvidenceVm[];
  total: AgentEvidenceVm;
}

export const EVIDENCE_UNLABELLED = '(no agent)';

function toEdge(
  v: CalibrationEdgeViews,
  floor: number,
  /** Null when the tenant has NEVER had a threshold event — the only way to
   * tell a genuine reset from rows that merely predate epoch tracking. */
  epochStartedAt: string | null,
  decisionRate: number,
  /** The high edge acts when the failure rate is AT OR ABOVE its bound; the low
   * edge when it is AT OR BELOW. The comparison direction is the difference. */
  direction: 'atLeast' | 'atMost',
): EdgeVm {
  const samples = v.currentEpoch.samples;
  const failures = v.currentEpoch.failures;
  const windowSamples = v.window.samples;
  const rate = samples === 0 ? null : failures / samples;
  const state: EdgeState =
    windowSamples === 0
      ? 'absent'
      : samples === 0
        ? epochStartedAt === null
          ? 'unaligned'
          : 'reset'
        : samples < floor
          ? 'accumulating'
          : 'sufficient';
  const reached =
    rate === null ? false : direction === 'atLeast' ? rate >= decisionRate : rate <= decisionRate;
  return {
    state,
    samples,
    failures,
    windowSamples,
    rate,
    decisionRate,
    inDeadZone: rate !== null && !reached,
  };
}

function toEntry(
  e: CalibrationEvidence['total'],
  floor: number,
  epochStartedAt: string | null,
  rateHigh: number,
  rateLow: number,
): AgentEvidenceVm {
  const high = toEdge(e.highEdge, floor, epochStartedAt, rateHigh, 'atLeast');
  const low = toEdge(e.lowEdge, floor, epochStartedAt, rateLow, 'atMost');
  return {
    agentId: e.agentId,
    label: e.label ?? EVIDENCE_UNLABELLED,
    high,
    low,
    middleRows: e.middleRows.currentEpoch,
    middleWindowRows: e.middleRows.window,
    // Zero on BOTH edges while decided rows exist between them. A bare pair of
    // zeros here reads as "the calibrator is broken" when the system is correct.
    deadMiddle:
      high.windowSamples === 0 && low.windowSamples === 0 && e.middleRows.window > 0,
  };
}

export function toCalibrationEvidenceVm(d: CalibrationEvidence): CalibrationEvidenceVm {
  return {
    windowDays: d.window.days,
    high: d.high,
    low: d.low,
    edgeWidth: d.edgeWidth,
    actingFloor: d.actingFloor,
    enabled: d.enabled,
    epochStartedAt: d.epochStartedAt,
    contracted: d.contracted,
    truncated: d.truncated,
    agents: d.agents.map((a) =>
      toEntry(a, d.actingFloor, d.epochStartedAt, d.rateHigh, d.rateLow),
    ),
    total: toEntry(d.total, d.actingFloor, d.epochStartedAt, d.rateHigh, d.rateLow),
  };
}

/** One edge's summary line. Every state says something different; none of them
 * promises a move, and `sufficient` explicitly does not. The floor is passed in
 * rather than carried on the edge — it is a property of the instance config, and
 * duplicating it per edge is how a stale copy gets rendered. */
export function edgeSummary(e: EdgeVm, actingFloor: number): string {
  // ONE DECIMAL, deliberately. An integer percent renders 64.6% as "65%", which
  // beside "inside the dead zone" contradicts a 65% bound and reads as a bug in
  // the check rather than a rate below it (fix-calibration-evidence-honesty).
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const rate = e.rate === null ? '—' : pct(e.rate);
  switch (e.state) {
    case 'absent':
      return 'no decided rows in this window';
    case 'unaligned':
      return `${String(e.windowSamples)} in the window, all predating epoch tracking`;
    case 'reset':
      return `${String(e.windowSamples)} in the window, none since the last threshold change`;
    case 'accumulating':
      return `${String(e.samples)} of ${String(actingFloor)} needed`;
    case 'sufficient':
      return e.inDeadZone
        ? `${String(e.samples)} samples · ${rate} failure rate — inside the dead zone, so no move`
        : `${String(e.samples)} samples · ${rate} failure rate`;
  }
}
