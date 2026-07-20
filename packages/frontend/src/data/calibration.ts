import type { AutoLayers, CalibrationEvent } from './api';

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
}

const fmtT = (n: number): string => String(Math.round(n * 100) / 100);

export function toCalibrationVm(al: AutoLayers | null): CalibrationVm | null {
  if (al === null) return null;
  const c = al.calibration;
  const calibrated = c.calibratedHigh !== null && c.calibratedLow !== null;
  return {
    enabled: c.enabled,
    thresholdsLine: `high ${fmtT(c.effectiveHigh)} · low ${fmtT(c.effectiveLow)}`,
    tag: calibrated ? 'calibrated' : 'instance defaults',
    showRevert: calibrated,
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
        movement: `${fmtT(from)} → ${fmtT(to)} (${e.edge})`,
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
          : `${fmtT(e.oldHigh)}/${fmtT(e.oldLow)} → instance defaults`,
      evidence: '',
      kind: e.trigger === 'rebase' ? ('rebase' as const) : ('revert' as const),
    };
  });
}
