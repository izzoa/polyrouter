import { describe, expect, it } from 'vitest';
import type { AgentCalibration, AutoLayers, CalibrationEvent } from './api';
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
      agents: [],
      tenantPairStarved: null,
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
        agents: [],
        tenantPairStarved: null,
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
    expect(row!.movement).toBe('0.6 to 0.58 (high)');
    expect(row!.evidence).toBe('57 samples · 75% failed');
  });

  it('a low-edge move reads from the low pair side', () => {
    const [row] = toHistoryRows([
      event({ edge: 'low', oldLow: 0.25, newLow: 0.27, edgeSamples: 60, edgeFailures: 3 }),
    ]);
    expect(row!.movement).toBe('0.25 to 0.27 (low)');
    expect(row!.evidence).toBe('60 samples · 5% failed');
  });

  it('a revert row shows the cleared pair returning to defaults, labeled', () => {
    const [row] = toHistoryRows([
      event({ trigger: 'revert', edge: null, oldHigh: 0.58, oldLow: 0.27, edgeSamples: null }),
    ]);
    expect(row!.kind).toBe('revert');
    expect(row!.movement).toBe('0.58/0.27 to instance defaults');
    expect(row!.evidence).toBe('');
  });

  it('a rebase row is labeled as a defaults change, not a user action', () => {
    const [row] = toHistoryRows([event({ trigger: 'rebase', edge: null })]);
    expect(row!.kind).toBe('rebase');
    expect(row!.movement).toBe('instance defaults changed — calibration reset');
  });
});

describe('toCalibrationVm — the per-agent scope (add-per-agent-calibration)', () => {
  const agent = (over: Partial<AgentCalibration> = {}): AgentCalibration => ({
    id: 'a1',
    name: 'markus',
    calibratedHigh: null,
    calibratedLow: null,
    anchorHigh: null,
    anchorLow: null,
    epoch: 0,
    active: false,
    evidence: null,
    ...over,
  });

  it('names the three states distinctly', () => {
    // NO AGENTS is a different statement from "no agent has a pair", which is
    // different again from "this one inherits". Collapsing them is how a
    // correct system reads as a broken one.
    expect(toCalibrationVm(layers())!.noAgents).toBe(true);

    const inheriting = toCalibrationVm(layers({ agents: [agent()] }))!;
    expect(inheriting.noAgents).toBe(false);
    expect(inheriting.inheritingCount).toBe(1);
    expect(inheriting.agents[0]!.state).toBe('inheriting');
    // INHERITING is not "uncalibrated": the agent is routed by a real pair.
    expect(inheriting.agents[0]!.pairLine).toBeNull();

    const owned = toCalibrationVm(
      layers({
        agents: [
          agent({
            calibratedHigh: 0.53,
            calibratedLow: 0.32,
            anchorHigh: 0.55,
            anchorLow: 0.3,
            epoch: 2,
            active: true,
            evidence: { highSamples: 30, lowSamples: 8 },
          }),
        ],
      }),
    )!;
    expect(owned.inheritingCount).toBe(0);
    expect(owned.agents[0]).toMatchObject({
      state: 'own pair',
      pairLine: 'high 0.53 · low 0.32',
      anchorLine: 'anchored to 0.55 / 0.3',
      evidenceLine: '30 high · 8 low',
    });
  });

  it('presents an INERT pair as inheriting, matching the tenant rule', () => {
    // A stale-anchored pair is not routing, so showing its numbers would state
    // a threshold that is not in effect — the same rule the tenant pair follows.
    const vm = toCalibrationVm(
      layers({
        agents: [agent({ calibratedHigh: 0.53, calibratedLow: 0.32, active: false })],
      }),
    )!;
    expect(vm.agents[0]!.state).toBe('inheriting');
    expect(vm.agents[0]!.pairLine).toBeNull();
    expect(vm.inheritingCount).toBe(1);
  });

  it('orders pair-holders first, then by name', () => {
    const vm = toCalibrationVm(
      layers({
        agents: [
          agent({ id: 'z', name: 'zeta' }),
          agent({
            id: 'm',
            name: 'markus',
            calibratedHigh: 0.53,
            calibratedLow: 0.32,
            active: true,
          }),
          agent({ id: 'a', name: 'alpha' }),
        ],
      }),
    )!;
    expect(vm.agents.map((a) => a.name)).toEqual(['markus', 'alpha', 'zeta']);
  });

  it('flags a frozen tenant pair only when the server reports one', () => {
    expect(toCalibrationVm(layers())!.tenantStarved).toBe(false);
    expect(toCalibrationVm(layers({ tenantPairStarved: false }))!.tenantStarved).toBe(false);
    expect(toCalibrationVm(layers({ tenantPairStarved: true }))!.tenantStarved).toBe(true);
  });

  it('does not add a second enable control — the tenant flag is the only one', () => {
    // The per-agent scope is inert while the tenant toggle is off, on the
    // body_capture_override precedent, and the VM exposes no per-agent flag to
    // build one from.
    const vm = toCalibrationVm(
      layers({
        enabled: false,
        agents: [agent({ calibratedHigh: 0.53, calibratedLow: 0.32, active: true })],
      }),
    )!;
    expect(vm.enabled).toBe(false);
    // Disabling the tenant toggle does NOT hide agent pairs or stop describing
    // them as applying: disable means "stop moving", not "stop using".
    expect(vm.agents[0]!.state).toBe('own pair');
    expect(Object.keys(vm.agents[0]!)).not.toContain('enabled');
  });
});
