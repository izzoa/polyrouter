import type { AgentCalibration, AutoLayers, CalibrationEvent } from './api';

/** View-model for the Routing page's Self-calibration section
 * (add-auto-threshold-calibration). Pure — every display rule unit-testable. */
export interface CalibrationVm {
  enabled: boolean;
  /** `high 0.58 · low 0.27` — the pair the router actually uses. */
  thresholdsLine: string;
  /** Which pair that is. */
  tag: 'instance defaults' | 'calibrated';
  /** The revert action shows only while an ACTIVE calibrated pair exists. */
  showRevert: boolean;
  /** Per-agent rows (add-per-agent-calibration), pair-holders FIRST — they are
   * the ones carrying a decision, and an operator scanning this list is looking
   * for them. Within each group, by name, so the order is stable. */
  agents: AgentCalibrationVm[];
  /** How many agents inherit. Stated as a number rather than left to be counted
   * off the list, because "none of them has earned one" is the ordinary case
   * and reads as an error when it is only an absence. */
  inheritingCount: number;
  /** No agents at all — a different statement from "none has a pair". */
  noAgents: boolean;
  /** The tenant pair is no longer informed by the traffic it governs. */
  tenantStarved: boolean;
}

export interface AgentCalibrationVm {
  id: string;
  name: string;
  /** `high 0.53 · low 0.32`, or null while inheriting. */
  pairLine: string | null;
  /** INHERITING is not "uncalibrated": the agent is routed by a real pair, its
   * tenant's. Saying so is the difference between a state and a gap. */
  state: 'own pair' | 'inheriting';
  /** `anchored to 0.55 / 0.30` — which parent this pair was earned against, so
   * a stale one is legible rather than mysterious. */
  anchorLine: string | null;
  /** `30 high · 8 low` at this agent's own epoch; null while inheriting. */
  evidenceLine: string | null;
  epoch: number;
}

const fmtT = (n: number): string => String(Math.round(n * 100) / 100);

export function toCalibrationVm(al: AutoLayers | null): CalibrationVm | null {
  if (al === null) return null;
  const c = al.calibration;
  const calibrated = c.calibratedHigh !== null && c.calibratedLow !== null;
  const agents = [...(c.agents ?? [])]
    .map(toAgentVm)
    .sort(
      (a, b) =>
        Number(b.state === 'own pair') - Number(a.state === 'own pair') ||
        a.name.localeCompare(b.name),
    );
  return {
    enabled: c.enabled,
    thresholdsLine: `high ${fmtT(c.effectiveHigh)} · low ${fmtT(c.effectiveLow)}`,
    tag: calibrated ? 'calibrated' : 'instance defaults',
    showRevert: calibrated,
    agents,
    inheritingCount: agents.filter((a) => a.state === 'inheriting').length,
    noAgents: agents.length === 0,
    // Only ever true alongside a tenant pair — there is nothing to freeze
    // otherwise, and a bare `false` would read as a reassurance nobody asked for.
    tenantStarved: c.tenantPairStarved === true,
  };
}

function toAgentVm(a: AgentCalibration): AgentCalibrationVm {
  const own = a.active && a.calibratedHigh !== null && a.calibratedLow !== null;
  return {
    id: a.id,
    name: a.name,
    pairLine: own ? `high ${fmtT(a.calibratedHigh!)} · low ${fmtT(a.calibratedLow!)}` : null,
    state: own ? 'own pair' : 'inheriting',
    anchorLine:
      own && a.anchorHigh !== null && a.anchorLow !== null
        ? `anchored to ${fmtT(a.anchorHigh)} / ${fmtT(a.anchorLow)}`
        : null,
    evidenceLine:
      own && a.evidence !== null
        ? `${String(a.evidence.highSamples)} high · ${String(a.evidence.lowSamples)} low`
        : null,
    epoch: a.epoch,
  };
}

export interface CalibrationHistoryRowVm {
  id: string;
  date: string;
  /** `0.6 → 0.58 (high)` for a move; `→ instance defaults` for revert/rebase. */
  movement: string;
  /** `57 samples · 75% failed` — empty for revert/rebase rows. */
  evidence: string;
  kind: 'move' | 'revert' | 'rebase';
}

export function toHistoryRows(events: CalibrationEvent[]): CalibrationHistoryRowVm[] {
  return events.map((e) => {
    const date = new Date(e.createdAt).toLocaleDateString();
    if (e.trigger === 'calibrator' && e.edge !== null) {
      const from = e.edge === 'high' ? e.oldHigh : e.oldLow;
      const to = e.edge === 'high' ? e.newHigh : e.newLow;
      const rate =
        e.edgeSamples !== null && e.edgeSamples > 0 && e.edgeFailures !== null
          ? ` · ${String(Math.round((e.edgeFailures / e.edgeSamples) * 100))}% failed`
          : '';
      return {
        id: e.id,
        date,
        movement: `${fmtT(from)} to ${fmtT(to)} (${e.edge})`,
        evidence: e.edgeSamples !== null ? `${String(e.edgeSamples)} samples${rate}` : '',
        kind: 'move' as const,
      };
    }
    return {
      id: e.id,
      date,
      movement:
        e.trigger === 'rebase'
          ? 'instance defaults changed — calibration reset'
          : `${fmtT(e.oldHigh)}/${fmtT(e.oldLow)} to instance defaults`,
      evidence: '',
      kind: e.trigger === 'rebase' ? ('rebase' as const) : ('revert' as const),
    };
  });
}
