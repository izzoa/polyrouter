import { describe, expect, it } from 'vitest';
import type { AutoPerformance } from './api';
import { autoSeriesToChart, toAutoPerfVm } from './autoPerf';

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
