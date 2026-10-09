import { cumulativeProgress, progressAllowance, progressBucketSeconds } from './progress-math';
import { periodInfo, type BudgetWindow } from './period';

describe('recorded budget progress math', () => {
  it.each<BudgetWindow>(['day', 'week', 'month'])(
    'emits ordered bounded %s points across calendar boundaries',
    (window) => {
      for (const date of [
        '2024-02-29T23:59:59Z',
        '2026-12-31T23:59:59Z',
        '2027-01-01T00:00:00Z',
        '2026-04-30T23:59:59Z',
      ]) {
        const at = new Date(date);
        const p = periodInfo(window, at);
        const width = progressBucketSeconds(window);
        const points = cumulativeProgress(
          p,
          at.getTime(),
          width,
          new Map([
            [0, 10],
            [3, 20],
          ]),
        );
        expect(points.length).toBeLessThanOrEqual(170);
        expect(points[0]).toEqual({ at: new Date(p.startMs).toISOString(), spentMicros: 0 });
        expect(points.at(-1)!.at).toBe(at.toISOString());
        for (let i = 1; i < points.length; i++) {
          expect(Date.parse(points[i]!.at)).toBeGreaterThan(Date.parse(points[i - 1]!.at));
          expect(Date.parse(points[i]!.at)).toBeLessThanOrEqual(at.getTime());
          expect(points[i]!.spentMicros).toBeGreaterThanOrEqual(points[i - 1]!.spentMicros);
        }
      }
    },
  );
  it('has one zero point at reset, no duplicate exact boundaries, and carries empty buckets', () => {
    const p = periodInfo('day', new Date('2026-10-08T00:00:00Z'));
    expect(cumulativeProgress(p, p.startMs, 900, new Map())).toHaveLength(1);
    const points = cumulativeProgress(
      p,
      p.startMs + 3600000,
      900,
      new Map([
        [0, 10],
        [3, 20],
      ]),
    );
    expect(points.map((p) => p.spentMicros)).toEqual([0, 10, 10, 10, 30]);
    const partial = cumulativeProgress(p, p.startMs + 3600001, 900, new Map([[4, 1]]));
    expect(partial.at(-1)!.spentMicros).toBe(1);
    expect(partial.at(-1)!.at).toBe('2026-10-08T01:00:00.001Z');
  });
  it('retains exact allowances, uncapped percentages, and nullable effective-zero percentages', () => {
    expect(progressAllowance(25, 12400000, 3000000, true, 'block')).toMatchObject({
      usedPercent: 49.6,
      remainingMicros: 12600000,
      overspendMicros: 0,
      availableMicros: 9600000,
    });
    expect(progressAllowance(25, 26500000, 0, true, 'block')).toMatchObject({
      usedPercent: 106,
      remainingMicros: 0,
      overspendMicros: 1500000,
      availableMicros: 0,
    });
    expect(progressAllowance(25, 1, 0, true, 'alert').availableMicros).toBeNull();
    expect(progressAllowance(25, 1, 0, false, 'block').availableMicros).toBeNull();
    expect(progressAllowance(0.0000001, 1, 0, true, 'block')).toMatchObject({
      amountMicros: 0,
      usedPercent: null,
      overspendMicros: 1,
    });
  });
});
