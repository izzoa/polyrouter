import type { AvailableBudgetProgress } from '@polyrouter/shared';
import { toMicros, type BudgetWindow, type PeriodInfo } from './period';

export const progressBucketSeconds = (window: BudgetWindow): number =>
  window === 'day' ? 900 : window === 'week' ? 3600 : 86400;

/** Bucket n contains [start + n*width, start + (n+1)*width). */
export function cumulativeProgress(
  period: PeriodInfo,
  asOfMs: number,
  bucketSeconds: number,
  buckets: ReadonlyMap<number, number>,
): AvailableBudgetProgress['points'] {
  const point = (at: number, spentMicros: number) => ({
    at: new Date(at).toISOString(),
    spentMicros,
  });
  const points = [point(period.startMs, 0)];
  const width = bucketSeconds * 1000;
  let total = 0;
  for (let n = 0; period.startMs + n * width < asOfMs; n += 1) {
    total += buckets.get(n) ?? 0;
    points.push(point(Math.min(period.startMs + (n + 1) * width, asOfMs), total));
  }
  return points;
}

export function progressAllowance(
  amount: number,
  spentMicros: number,
  pendingMicros: number,
  enabled: boolean,
  action: string,
) {
  const amountMicros = toMicros(amount);
  return {
    amountMicros,
    spentMicros,
    pendingMicros,
    remainingMicros: Math.max(0, amountMicros - spentMicros),
    overspendMicros: Math.max(0, spentMicros - amountMicros),
    usedPercent: amountMicros > 0 ? (100 * spentMicros) / amountMicros : null,
    availableMicros:
      enabled && action === 'block'
        ? Math.max(0, amountMicros - spentMicros - pendingMicros)
        : null,
  };
}
