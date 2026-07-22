import { describe, expect, it } from 'vitest';
import type { AutoLayers, CalibrationEvent } from './api';
import { toCalibrationVm, toHistoryRows } from './calibration';

function layers(cal: Partial<AutoLayers['calibration']> = {}): AutoLayers {
  return {
    structural: true,
    cascade: true,
    structuralAvailable: true,
    cascadeAvailable: true,
    semantic: false,
    semanticAvailable: false,
    semanticLearning: false,
    semanticLearningAvailable: false,
    calibration: {
      enabled: false,
      calibratedHigh: null,
      calibratedLow: null,
      instanceHigh: 0.6,
      instanceLow: 0.25,
      effectiveHigh: 0.6,
      effectiveLow: 0.25,
      ...cal,
    },
  };
}

function event(over: Partial<CalibrationEvent> = {}): CalibrationEvent {
  return {
    id: 'e1',
    trigger: 'calibrator',
    oldHigh: 0.6,
    oldLow: 0.25,
    newHigh: 0.58,
    newLow: 0.25,
    anchorHigh: 0.6,
    anchorLow: 0.25,
    windowFrom: null,
    windowTo: null,
    edge: 'high',
    edgeSamples: 57,
    edgeFailures: 43,
    reason: 'r',
    createdAt: '2026-07-19T04:00:00.000Z',
    ...over,
  };
}

describe('toCalibrationVm', () => {
  it('returns null before layers load', () => {
    expect(toCalibrationVm(null)).toBeNull();
  });

  it('uncalibrated: instance tag, no revert', () => {
    const vm = toCalibrationVm(layers())!;
    expect(vm.enabled).toBe(false);
    expect(vm.thresholdsLine).toBe('high 0.6 · low 0.25');
    expect(vm.tag).toBe('instance defaults');
    expect(vm.showRevert).toBe(false);
  });

  it('calibrated: the pair the router uses, tagged, revert shown', () => {
    const vm = toCalibrationVm(
      layers({
        enabled: true,
        calibratedHigh: 0.58,
        calibratedLow: 0.27,
        effectiveHigh: 0.58,
        effectiveLow: 0.27,
      }),
    )!;
    expect(vm.enabled).toBe(true);
    expect(vm.thresholdsLine).toBe('high 0.58 · low 0.27');
    expect(vm.tag).toBe('calibrated');
    expect(vm.showRevert).toBe(true);
  });

  it('an inert pair (API reports nulls) reads as instance — no revert', () => {
    // The server presents anchor-stale/rail-violating pairs as nulls with
    // effective = instance; the VM must not invent a calibrated state.
    const vm = toCalibrationVm(layers({ enabled: true }))!;
    expect(vm.tag).toBe('instance defaults');
    expect(vm.showRevert).toBe(false);
  });
});

describe('toHistoryRows', () => {
  it('a move row: numeric movement with its edge and evidence rate', () => {
    const [row] = toHistoryRows([event()]);
    expect(row!.kind).toBe('move');
    expect(row!.movement).toBe('0.6 → 0.58 (high)');
    expect(row!.evidence).toBe('57 samples · 75% failed');
  });

  it('a low-edge move reads from the low pair side', () => {
    const [row] = toHistoryRows([
      event({ edge: 'low', oldLow: 0.25, newLow: 0.27, edgeSamples: 60, edgeFailures: 3 }),
    ]);
    expect(row!.movement).toBe('0.25 → 0.27 (low)');
    expect(row!.evidence).toBe('60 samples · 5% failed');
  });

  it('a revert row shows the cleared pair returning to defaults, labeled', () => {
    const [row] = toHistoryRows([
      event({ trigger: 'revert', edge: null, oldHigh: 0.58, oldLow: 0.27, edgeSamples: null }),
    ]);
    expect(row!.kind).toBe('revert');
    expect(row!.movement).toBe('0.58/0.27 → instance defaults');
    expect(row!.evidence).toBe('');
  });

  it('a rebase row is labeled as a defaults change, not a user action', () => {
    const [row] = toHistoryRows([event({ trigger: 'rebase', edge: null })]);
    expect(row!.kind).toBe('rebase');
    expect(row!.movement).toBe('instance defaults changed — calibration reset');
  });
});
