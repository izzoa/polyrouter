/** A breakdown panel that follows the selected metric.
 *
 * Extracted from `Costs` so the Overview's model breakdown can use it too. The archived
 * requirement is written for both — *"The dashboard's Overview and Costs pages SHALL…"*, and
 * within it *"Breakdown panels SHALL offer a metric"* whose *"heading, empty state and units
 * SHALL follow the selected metric, so a token chart is never captioned as spend."* Overview
 * had an inline copy that rendered spend unconditionally, so it met neither half.
 *
 * Props are Solid getters, so the panel re-renders as the breakdown slice loads and as the
 * range or metric changes.
 */
import { Show, type JSX } from 'solid-js';
import { BarRows } from './BarRows';
import { breakdownToSpend, breakdownToTokens, fmtTokens } from '../data/analytics';
import type { BreakdownMetric, BreakdownRow } from '../data/api';

/** The metric selector's options. Shared so Overview and Costs cannot drift apart on the
 * labels or the order. */
export const METRIC_OPTIONS = [
  { id: 'spend' as BreakdownMetric, label: 'spend' },
  { id: 'tokens' as BreakdownMetric, label: 'tokens' },
];

export function BreakdownPanel(props: {
  title: string;
  rows: BreakdownRow[];
  loading: boolean;
  metric: BreakdownMetric;
  /** True while the rows on screen belong to a DIFFERENT metric or range than the one
   * selected. They are not merely old — they are labelled wrongly, and blanking them is what
   * stops dollar values appearing under a "tokens" heading until the refetch lands. */
  stale: boolean;
  /** Rendered beside the title. The metric selector goes here on surfaces that offer one. */
  action?: JSX.Element;
}) {
  const tokens = (): boolean => props.metric === 'tokens';
  const data = () => (tokens() ? breakdownToTokens(props.rows) : breakdownToSpend(props.rows));
  return (
    <div class="panel card">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px">
        <div class="section-title" style="margin-bottom:0">
          {props.title}
        </div>
        {props.action}
      </div>
      <Show
        when={props.rows.length > 0 && !props.stale}
        fallback={
          <div style="font:400 12px 'Geist',sans-serif;color:var(--text3)">
            {props.loading || props.stale
              ? 'Loading…'
              : tokens()
                ? 'No usage in this range'
                : 'No spend in this range'}
          </div>
        }
      >
        <BarRows data={data()} {...(tokens() ? { format: fmtTokens } : {})} />
      </Show>
    </div>
  );
}
