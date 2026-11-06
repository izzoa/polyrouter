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
import { Match, Show, Switch, type JSX } from 'solid-js';
import { BarRows } from './BarRows';
import { FigureSkeleton } from './FigureSkeleton';
import { breakdownToSpend, breakdownToTokens } from '../data/analytics';
import type { FigureLoad } from '../data/figureLoad';
import { fmtTokensCompact } from '../data/figures';
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
  metric: BreakdownMetric;
  /** The bars' figure load (adopt-figure-states D5), from `createFigureLoad` over the
   * breakdown slice, with `loaded` false while the rows on screen belong to a DIFFERENT metric
   * or range than the one selected. Such rows are not merely old, they are labelled wrongly, so
   * they are never shown: dollar values never appear under a "tokens" heading. `loading`
   * renders the shared skeleton, `failed` renders no figure under the page's notice (never the
   * previous bars as current, and never a skeleton that pulses on), and `ready` the bars. */
  load: FigureLoad;
  /** What the bars are, as the skeleton's hidden text finishes it: `spend by model` reads
   * `Loading spend by model`. */
  what: string;
  /** Rendered beside the title. The metric selector goes here on surfaces that offer one. */
  action?: JSX.Element;
}) {
  const tokens = (): boolean => props.metric === 'tokens';
  const data = () => (tokens() ? breakdownToTokens(props.rows) : breakdownToSpend(props.rows));
  return (
    <div class="panel card">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:16px">
        <div class="section-title" style="margin-bottom:0">
          {props.title}
        </div>
        {props.action}
      </div>
      <Switch>
        <Match when={props.load === 'loading'}>
          <FigureSkeleton what={props.what} size="line" />
        </Match>
        <Match when={props.load === 'ready'}>
          <Show
            when={props.rows.length > 0}
            fallback={
              <div class="t-dense" style="color:var(--text3)">
                {tokens() ? 'No usage in this range' : 'No spend in this range'}
              </div>
            }
          >
            <BarRows data={data()} {...(tokens() ? { format: fmtTokensCompact } : {})} />
          </Show>
        </Match>
      </Switch>
    </div>
  );
}
