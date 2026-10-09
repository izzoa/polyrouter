import type { AvailableBudgetProgress, BudgetProgressConfig } from '@polyrouter/shared';

/** Browser/unit fixture only; production period selection belongs to the server. */
export function fakeBudgetProgress(
  budget: BudgetProgressConfig,
  asOf: string,
  spentMicros = 0,
  pendingMicros = 0,
): AvailableBudgetProgress {
  const at = new Date(asOf);
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  if (budget.window === 'month') start.setUTCDate(1);
  if (budget.window === 'week')
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const end = new Date(start);
  if (budget.window === 'month') end.setUTCMonth(end.getUTCMonth() + 1);
  else end.setUTCDate(end.getUTCDate() + (budget.window === 'week' ? 7 : 1));
  const amountMicros = Math.round(budget.amount * 1000000);
  return {
    id: budget.id,
    availability: 'available',
    budget,
    period: { id: start.toISOString(), start: start.toISOString(), end: end.toISOString() },
    bucketSeconds: budget.window === 'day' ? 900 : budget.window === 'week' ? 3600 : 86400,
    amountMicros,
    spentMicros,
    pendingMicros,
    remainingMicros: Math.max(0, amountMicros - spentMicros),
    overspendMicros: Math.max(0, spentMicros - amountMicros),
    usedPercent: amountMicros > 0 ? (100 * spentMicros) / amountMicros : null,
    availableMicros:
      budget.enabled && budget.action === 'block'
        ? Math.max(0, amountMicros - spentMicros - pendingMicros)
        : null,
    provenance: {
      meteredRows: spentMicros > 0 ? 4 : 0,
      unpricedRows: 0,
      unknownSpendMicros: 0,
      usageEstimated: false,
      priceEstimated: false,
    },
    points:
      start.toISOString() === asOf
        ? [{ at: asOf, spentMicros: 0 }]
        : [
            { at: start.toISOString(), spentMicros: 0 },
            { at: asOf, spentMicros },
          ],
  };
}
