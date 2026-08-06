import { useApp } from '../state/context';
import { Segmented } from './Segmented';
import type { Range } from '../types';

const RANGE_OPTIONS = [
  { id: '24h' as Range, label: '24h' },
  { id: '7d' as Range, label: '7d' },
  { id: '30d' as Range, label: '30d' },
];

/** The `24h`/`7d`/`30d` segmented control. Uncontrolled (no props) it drives the
 * global Observe range (`setRange`) exactly as before; controlled via
 * `value`/`onChange` it is a LOCAL instance (add-auto-performance-view) — the
 * Routing page's auto section keeps its own 7d default without touching the
 * Observe pages' state. */
export function RangeSelector(props: { value?: Range; onChange?: (r: Range) => void } = {}) {
  const app = useApp();
  const { state } = app;
  const current = (): Range => props.value ?? state.range;
  const set = (rg: Range): void => {
    if (props.onChange) props.onChange(rg);
    else app.setRange(rg);
  };
  return <Segmented options={RANGE_OPTIONS} value={current()} onChange={set} />;
}
