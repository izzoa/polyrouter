import { describe, expect, it } from 'vitest';
import type { AutoLayers, AutoPerformance } from './api';
import {
  autoSeriesToChart,
  signalQualityGuidance,
  toAutoPerfVm,
  toSignalQualityVm,
  toWorkloadVm,
} from './autoPerf';

/** Baseline fixture mirroring the fakeClient default — mutated per case. */
function fixture(over: Partial<AutoPerformance> = {}): AutoPerformance {
  return {
    evaluated: 40,
    bands: {
      high: { requests: 12, declared: 2, unroutable: 1 },
      low: { requests: 16, declared: 0, unroutable: 0 },
      ambiguous: { requests: 12 },
    },
    cascade: {
      requests: 10,
      qualityPassed: 7,
      qualityUnknown: 1,
      failedOrCancelled: 1,
      escalated: 1,
    },
    semantic: {
      evaluated: 8,
      routed: { high: 3, low: 2 },
      outcomes: { success: 3, fallback: 1, error: 1, cancelled: 0 },
      source: { bundled: 6, learned: 2 },
    },
    fallthrough: 2,
    series: [],
    telemetrySince: '2026-07-10T00:00:00.000Z',
    savings: {
      netUsd: 1.62,
      grossUsd: 1.84,
      excessUsd: 0.22,
      rows: 6,
      uncostedRows: 1,
      basis: { kind: 'tier', label: 'premium', model: 'gpt-x' },
    },
    signalQuality: [],
    workloadMix: { evaluated: 0, unclassified: 0, since: null, revisions: [], classes: [] },
    ...over,
  };
}

describe('toAutoPerfVm', () => {
  it('returns null before data loads', () => {
    expect(toAutoPerfVm(null)).toBeNull();
  });

  it('computes band shares of evaluated and declared across both bands', () => {
    const vm = toAutoPerfVm(fixture())!;
    expect(vm.evaluated).toBe(40);
    expect(vm.ambiguousPct).toBe('30%'); // 12/40
    expect(vm.declaredPct).toBe('5%'); // (2+0)/40
    expect(vm.unroutable).toBe(1); // high 1 + low 0
  });

  it('computes the four disjoint cascade outcome rates over cascade.requests', () => {
    const vm = toAutoPerfVm(fixture())!;
    expect(vm.cascadeRequests).toBe(10);
    expect(vm.passedPct).toBe('70%');
    expect(vm.escalatedPct).toBe('10%');
    expect(vm.unknownPct).toBe('10%');
    expect(vm.failedPct).toBe('10%');
  });

  it('exposes the semantic slice: routed total, outcome split over routed, source split over evaluated', () => {
    const vm = toAutoPerfVm(fixture())!;
    expect(vm.semantic).not.toBeNull();
    expect(vm.semantic?.evaluated).toBe(8);
    expect(vm.semantic?.routed).toBe(5); // 3 high + 2 low
    expect(vm.semantic?.routedHigh).toBe(3);
    expect(vm.semantic?.routedLow).toBe(2);
    // Outcomes are shares of routed (5), disjoint + exhaustive.
    expect(vm.semantic?.successPct).toBe('60%'); // 3/5
    expect(vm.semantic?.fallbackPct).toBe('20%'); // 1/5
    expect(vm.semantic?.errorPct).toBe('20%'); // 1/5
    expect(vm.semantic?.cancelledPct).toBe('0%'); // 0/5
    // Source is a share of evaluated (8).
    expect(vm.semantic?.learnedPct).toBe('25%'); // 2/8
    expect(vm.semantic?.bundledPct).toBe('75%'); // 6/8
    // Routing traffic exists ⇒ cascade figures are residual-only.
    expect(vm.cascadeIsResidual).toBe(true);
  });

  it('zero-data honesty: an unevaluated semantic slice yields null (no fabricated zeros) and no residual label', () => {
    const vm = toAutoPerfVm(
      fixture({
        semantic: {
          evaluated: 0,
          routed: { high: 0, low: 0 },
          outcomes: { success: 0, fallback: 0, error: 0, cancelled: 0 },
          source: { bundled: 0, learned: 0 },
        },
      }),
    )!;
    expect(vm.semantic).toBeNull();
    expect(vm.cascadeIsResidual).toBe(false);
  });

  it('evaluated-but-unrouted semantic slice renders (source only) but does not mark cascade residual', () => {
    const vm = toAutoPerfVm(
      fixture({
        semantic: {
          evaluated: 4,
          routed: { high: 0, low: 0 },
          outcomes: { success: 0, fallback: 0, error: 0, cancelled: 0 },
          source: { bundled: 4, learned: 0 },
        },
      }),
    )!;
    expect(vm.semantic?.evaluated).toBe(4);
    expect(vm.semantic?.routed).toBe(0);
    expect(vm.cascadeIsResidual).toBe(false); // nothing diverted from cascade
  });

  it('workload routing makes the cascade residual too, names its cause, and totals routed (add-workload-routing)', () => {
    const wm = (routedCode: number, routedVision: number): AutoPerformance['workloadMix'] => ({
      evaluated: 10,
      unclassified: 0,
      since: '2026-07-01T00:00:00.000Z',
      revisions: [],
      classes: [
        {
          class: 'code',
          requests: 6,
          unpricedRequests: 0,
          unpricedAttempts: 0,
          spendUsd: 1,
          routed: routedCode,
        },
        {
          class: 'vision',
          requests: 2,
          unpricedRequests: 0,
          unpricedAttempts: 0,
          spendUsd: 0,
          routed: routedVision,
        },
        {
          class: 'none',
          requests: 2,
          unpricedRequests: 0,
          unpricedAttempts: 0,
          spendUsd: 0,
          routed: 0,
        },
      ],
    });
    const unrouted = toAutoPerfVm(
      fixture({
        semantic: {
          evaluated: 0,
          routed: { high: 0, low: 0 },
          outcomes: { success: 0, fallback: 0, error: 0, cancelled: 0 },
          source: { bundled: 0, learned: 0 },
        },
        workloadMix: wm(0, 0),
      }),
    )!;
    expect(unrouted.workloadRouted).toBe(0);
    expect(unrouted.cascadeIsResidual).toBe(false);
    expect(unrouted.residualCauses).toEqual({ semantic: false, workload: false });
    const routed = toAutoPerfVm(
      fixture({
        semantic: {
          evaluated: 0,
          routed: { high: 0, low: 0 },
          outcomes: { success: 0, fallback: 0, error: 0, cancelled: 0 },
          source: { bundled: 0, learned: 0 },
        },
        workloadMix: wm(4, 1),
      }),
    )!;
    expect(routed.workloadRouted).toBe(5);
    expect(routed.cascadeIsResidual).toBe(true); // claimed requests never cascade
    expect(routed.residualCauses).toEqual({ semantic: false, workload: true });
    expect(routed.workload?.rows.map((r) => [r.class, r.routed])).toEqual([
      ['code', 4],
      ['vision', 1],
      ['none', 0],
    ]);
  });

  it('rates are 0% (not NaN) when no cascade traffic exists', () => {
    const vm = toAutoPerfVm(
      fixture({
        cascade: {
          requests: 0,
          qualityPassed: 0,
          qualityUnknown: 0,
          failedOrCancelled: 0,
          escalated: 0,
        },
      }),
    )!;
    expect(vm.passedPct).toBe('0%');
    expect(vm.escalatedPct).toBe('0%');
  });

  describe('savings', () => {
    it('positive net: formatted USD, coverage counts eligible = rows + uncosted', () => {
      const vm = toAutoPerfVm(fixture())!;
      const sv = vm.savings!;
      expect(sv.net).toBe('$1.6200');
      expect(sv.negative).toBe(false);
      expect(sv.excess).toBe('$0.2200');
      expect(sv.basisLabel).toBe('premium');
      expect(sv.coverage).toBe('based on 6 of 7 quality-passed requests');
      expect(sv.incomplete).toBe(true); // uncostedRows > 0
      expect(sv.moneyless).toBe(false);
    });

    it('negative net: flags negative and formats the magnitude', () => {
      const vm = toAutoPerfVm(
        fixture({
          savings: {
            netUsd: -0.979,
            grossUsd: 0.019,
            excessUsd: 0.998,
            rows: 2,
            uncostedRows: 0,
            basis: { kind: 'model', label: 'gpt-x', model: 'gpt-x' },
          },
        }),
      )!;
      const sv = vm.savings!;
      expect(sv.negative).toBe(true);
      expect(sv.net).toBe('$0.9790'); // magnitude — the UI adds the framing
      expect(sv.excess).toBe('$0.9980');
      expect(sv.incomplete).toBe(false);
      expect(sv.coverage).toBe('based on 2 of 2 quality-passed requests');
    });

    it('moneyless: every eligible row uncostable → null money, coverage retained', () => {
      const vm = toAutoPerfVm(
        fixture({
          savings: {
            netUsd: null,
            grossUsd: null,
            excessUsd: null,
            rows: 0,
            uncostedRows: 3,
            basis: { kind: 'tier', label: 'premium', model: 'gpt-x' },
          },
        }),
      )!;
      const sv = vm.savings!;
      expect(sv.moneyless).toBe(true);
      // Unknown-not-zero: no fabricated $0.0000 strings from null totals.
      expect(sv.net).toBeNull();
      expect(sv.excess).toBeNull();
      expect(sv.negative).toBe(false);
      expect(sv.coverage).toBe('based on 0 of 3 quality-passed requests');
    });

    it('omitted entirely when the endpoint reports savings null (no basis)', () => {
      const vm = toAutoPerfVm(fixture({ savings: null }))!;
      expect(vm.savings).toBeNull();
    });
  });

  describe('zero states', () => {
    it('none when the range has evaluated traffic', () => {
      expect(toAutoPerfVm(fixture())!.zeroState).toBe('none');
    });

    it('preCapture when the range is empty but the tenant has older telemetry', () => {
      const vm = toAutoPerfVm(
        fixture({
          evaluated: 0,
          bands: {
            high: { requests: 0, declared: 0, unroutable: 0 },
            low: { requests: 0, declared: 0, unroutable: 0 },
            ambiguous: { requests: 0 },
          },
        }),
      )!;
      expect(vm.zeroState).toBe('preCapture');
      expect(vm.telemetrySince).toBe('2026-07-10T00:00:00.000Z');
    });

    it('empty when the tenant has never captured telemetry', () => {
      const vm = toAutoPerfVm(
        fixture({
          evaluated: 0,
          bands: {
            high: { requests: 0, declared: 0, unroutable: 0 },
            low: { requests: 0, declared: 0, unroutable: 0 },
            ambiguous: { requests: 0 },
          },
          telemetrySince: null,
        }),
      )!;
      expect(vm.zeroState).toBe('empty');
    });
  });
});

describe('signal quality (add-auto-signal-honesty)', () => {
  const entry = (over: Partial<AutoPerformance['signalQuality'][number]> = {}) => ({
    agentId: 'a1',
    label: 'markus',
    bandedRows: 272,
    ambiguousRows: 272,
    distinctScores: 24,
    modalScore: 0.45,
    modalShare: 0.85,
    collapsed: true as boolean | null,
    ...over,
  });

  it('flagged agent renders label, modal bucket, share, and ambiguous denominator', () => {
    const vm = toSignalQualityVm([entry()]);
    expect(vm.show).toBe(true);
    expect(vm.flagged).toHaveLength(1);
    expect(vm.flagged[0]!.label).toBe('markus');
    expect(vm.flagged[0]!.detail).toBe('score 0.45 · 85% of 272 ambiguous requests');
    expect(vm.coverage).toBeNull();
  });

  it('MIXED state: a flag never hides the coverage disclosure (codex r2 item-6)', () => {
    const vm = toSignalQualityVm([
      entry(),
      entry({ agentId: 'a2', label: 'small', ambiguousRows: 10, collapsed: null }),
      entry({ agentId: 'a3', label: 'quiet', ambiguousRows: 8, collapsed: null }),
    ]);
    expect(vm.flagged).toHaveLength(1);
    expect(vm.coverage).toBe('1 of 3 agents have enough evaluated traffic to assess');
    expect(vm.show).toBe(true);
  });

  it('coverage-only when nothing is flagged but agents sit below the floor', () => {
    const vm = toSignalQualityVm([
      entry({ collapsed: false }),
      entry({ agentId: 'a2', collapsed: null }),
    ]);
    expect(vm.flagged).toHaveLength(0);
    expect(vm.coverage).toBe('1 of 2 agents have enough evaluated traffic to assess');
    expect(vm.show).toBe(true);
  });

  it('hidden entirely when every agent is assessed healthy (no empty scaffolding)', () => {
    const vm = toSignalQualityVm([
      entry({ collapsed: false }),
      entry({ agentId: 'a2', collapsed: false }),
    ]);
    expect(vm).toEqual({ show: false, flagged: [], coverage: null });
    // And with no agents at all:
    expect(toSignalQualityVm([]).show).toBe(false);
  });

  it('null label renders the keyless fallback; null modal fields render em-dashes', () => {
    const vm = toSignalQualityVm([
      entry({ agentId: null, label: null, modalScore: null, modalShare: null }),
    ]);
    expect(vm.flagged[0]!.label).toBe('(no agent)');
    expect(vm.flagged[0]!.detail).toContain('score —');
  });

  it('guidance is availability-aware and never claims L2 success', () => {
    const layers = (over: Partial<AutoLayers>): AutoLayers =>
      ({
        structural: true,
        cascade: true,
        semantic: false,
        semanticAvailable: false,
        semanticLearning: false,
        semanticLearningAvailable: false,
        structuralAvailable: true,
        cascadeAvailable: true,
        ...over,
      }) as AutoLayers;
    // Unavailable → the whole configuration surface, no specific-missing-piece claim.
    const unavailable = signalQualityGuidance(layers({}));
    expect(unavailable).toContain('ROUTING_AUTO_LAYERS');
    expect(unavailable).toContain('SEMANTIC_MODEL_PATH');
    expect(unavailable).toContain('Pin it to a tier');
    // Not-yet-loaded state uses the same safe variant.
    expect(signalQualityGuidance(null)).toBe(unavailable);
    // Available but off → points at the toggle.
    const off = signalQualityGuidance(layers({ semanticAvailable: true }));
    expect(off).toContain('enable L2 · Semantic');
    expect(off).toContain('evaluates exactly this ambiguous slice');
    // Active → evaluation claim only; the word "success" never appears.
    const active = signalQualityGuidance(layers({ semanticAvailable: true, semantic: true }));
    expect(active).toContain('L2 · Semantic evaluates it');
    for (const g of [unavailable, off, active]) {
      expect(g.toLowerCase()).not.toContain('success');
      expect(g.toLowerCase()).not.toContain('discriminat');
    }
  });
});

describe('autoSeriesToChart', () => {
  const DAY = 86_400;

  it('returns empty arrays for an empty series', () => {
    expect(autoSeriesToChart([], DAY)).toEqual([[], [], [], []]);
  });

  it('maps buckets to epoch seconds with per-band arrays', () => {
    const [xs, high, low, ambiguous] = autoSeriesToChart(
      [
        { bucket: '2026-07-14T00:00:00.000Z', high: 6, low: 8, ambiguous: 5 },
        { bucket: '2026-07-15T00:00:00.000Z', high: 6, low: 8, ambiguous: 7 },
      ],
      DAY,
    );
    expect(xs).toEqual([
      Date.parse('2026-07-14T00:00:00.000Z') / 1000,
      Date.parse('2026-07-15T00:00:00.000Z') / 1000,
    ]);
    expect(high).toEqual([6, 6]);
    expect(low).toEqual([8, 8]);
    expect(ambiguous).toEqual([5, 7]);
  });

  it('zero-fills gaps at the bucket interval (idle spans dip, never interpolate)', () => {
    const [xs, high, low, ambiguous] = autoSeriesToChart(
      [
        { bucket: '2026-07-14T00:00:00.000Z', high: 3, low: 1, ambiguous: 0 },
        { bucket: '2026-07-17T00:00:00.000Z', high: 2, low: 0, ambiguous: 4 },
      ],
      DAY,
    );
    expect(xs).toHaveLength(4); // 14th..17th inclusive
    expect(high).toEqual([3, 0, 0, 2]);
    expect(low).toEqual([1, 0, 0, 0]);
    expect(ambiguous).toEqual([0, 0, 0, 4]);
  });
});

describe('toWorkloadVm (add-workload-telemetry D7)', () => {
  const mix = (
    over: Partial<AutoPerformance['workloadMix']> = {},
  ): AutoPerformance['workloadMix'] => ({
    evaluated: 0,
    unclassified: 0,
    since: null,
    revisions: [],
    classes: [],
    ...over,
  });
  const cls = (
    c: string,
    requests: number,
    spendUsd: number | null,
    over: Partial<AutoPerformance['workloadMix']['classes'][number]> = {},
  ): AutoPerformance['workloadMix']['classes'][number] => ({
    class: c,
    requests,
    unpricedRequests: 0,
    unpricedAttempts: 0,
    spendUsd,
    routed: 0,
    ...over,
  });

  it('is EMPTY (null) only when there are no classified parents AND no classes', () => {
    expect(toWorkloadVm(mix())).toBeNull();
    // attempt-only classes are NOT empty
    const w = toWorkloadVm(mix({ classes: [cls('code', 0, 0.25, { unpricedAttempts: 1 })] }));
    expect(w).not.toBeNull();
    expect(w!.attemptOnly).toBe(true);
    expect(w!.rows[0]).toMatchObject({ class: 'code', sharePct: '0%', unpricedNote: '1 unpriced' });
  });

  it('rows keep the aggregation order, shares are of evaluated, none reads as plain language', () => {
    const w = toWorkloadVm(
      mix({
        evaluated: 10,
        classes: [
          cls('code', 5, 2),
          cls('none', 3, 0.1),
          cls('structured', 2, 0.5, { unpricedRequests: 1 }),
        ],
      }),
    )!;
    expect(w.rows.map((r) => r.label)).toEqual(['code', 'no specialist workload', 'structured']);
    expect(w.rows.map((r) => r.sharePct)).toEqual(['50%', '30%', '20%']);
    expect(w.rows[2]!.unpricedNote).toBe('1 unpriced');
    expect(w.rows[0]!.unpricedNote).toBeNull();
    expect(w.attemptOnly).toBe(false);
    expect(w.coverage).toBeNull();
    expect(w.revisionNote).toBeNull();
  });

  it('spend honesty: null → no figure (dash + unpriced), 0 → a $0 figure with no qualifier, attempt-side unpriced qualifies', () => {
    const w = toWorkloadVm(
      mix({
        evaluated: 3,
        classes: [
          cls('vision', 1, null, { unpricedRequests: 1 }),
          cls('code', 1, 0),
          cls('structured', 1, 1, { unpricedAttempts: 1 }),
        ],
      }),
    )!;
    const by = new Map(w.rows.map((r) => [r.class, r]));
    expect(by.get('vision')!.spend).toBeNull();
    expect(by.get('vision')!.unpricedNote).toBe('1 unpriced');
    expect(by.get('code')!.spend).toMatch(/\$0/);
    expect(by.get('code')!.unpricedNote).toBeNull();
    expect(by.get('structured')!.spend).toMatch(/\$1/);
    expect(by.get('structured')!.unpricedNote).toBe('1 unpriced');
  });

  it('discloses coverage (structurally evaluated wording) and multi-revision ranges (request figures wording)', () => {
    const w = toWorkloadVm(
      mix({
        evaluated: 8,
        unclassified: 2,
        revisions: [
          { revision: 'structural/v1/c1/aaa', requests: 5 },
          { revision: 'structural/v1/c1/bbb', requests: 3 },
        ],
        classes: [cls('none', 8, 0)],
      }),
    )!;
    expect(w.coverage).toBe(
      '8 of 10 structurally evaluated auto requests carry workload telemetry',
    );
    expect(w.revisionNote).toBe('request figures span 2 classifier revisions');
  });

  it('the zero state keys on the WORKLOAD since, independent of structural telemetrySince', () => {
    const pre = toAutoPerfVm(fixture({ workloadMix: mix({ since: '2026-07-12T00:00:00.000Z' }) }))!;
    expect(pre.workload).toBeNull();
    expect(pre.workloadZero).toBe('preCapture');
    const empty = toAutoPerfVm(
      fixture({ workloadMix: mix(), telemetrySince: '2026-07-10T00:00:00.000Z' }),
    )!;
    expect(empty.workload).toBeNull();
    expect(empty.workloadZero).toBe('empty'); // structural telemetrySince does not stand in
  });
});
