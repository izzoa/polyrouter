import type { AvailableBudgetProgress } from '@polyrouter/shared';
import { Chart } from './Chart';

/** Compact large axis ticks and retain positive sub-cent ticks within the gutter.
 * Exact amounts remain in the directly labelled ceiling and textual summary. */
export function budgetAxisMoney(value: number): string {
  if (value >= 1000000000)
    return `$${(value / 1000000000).toFixed(value % 1000000000 === 0 ? 0 : 1)}B`;
  if (value >= 1000000) return `$${(value / 1000000).toFixed(value % 1000000 === 0 ? 0 : 1)}M`;
  if (value >= 1000) return `$${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}K`;
  if (value === 0) return '$0';
  return `$${value.toFixed(value < 0.01 ? 4 : value >= 1 && value % 1 === 0 ? 0 : 2)}`;
}

export function budgetChartData(
  snapshot: AvailableBudgetProgress,
): [number[], ...(number | null)[][]] {
  return [
    [
      ...snapshot.points.map((p) => Date.parse(p.at) / 1000),
      Date.parse(snapshot.period.end) / 1000,
    ],
    [...snapshot.points.map((p) => p.spentMicros / 1000000), null],
    Array.from({ length: snapshot.points.length + 1 }, () => snapshot.amountMicros / 1000000),
  ];
}

export function BudgetChart(props: { snapshot: AvailableBudgetProgress }) {
  return (
    <div class="budget-chart" aria-hidden="true">
      <Chart
        data={budgetChartData(props.snapshot)}
        height={150}
        xExtent={[
          Date.parse(props.snapshot.period.start) / 1000,
          Date.parse(props.snapshot.period.end) / 1000,
        ]}
        yExtent={[
          0,
          Math.max(
            0.01,
            props.snapshot.amountMicros / 1000000,
            props.snapshot.spentMicros / 1000000,
          ) * 1.15,
        ]}
        yFormat={budgetAxisMoney}
        utc
        series={[{ label: 'Recorded spend' }, { label: 'Budget ceiling', dash: [5, 4] }]}
      />
    </div>
  );
}
