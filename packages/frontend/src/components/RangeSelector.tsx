import { For } from 'solid-js';
import { useApp } from '../state/context';
import type { Range } from '../types';

const RANGES: Range[] = ['24h', '7d', '30d'];

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
  return (
    <div style="display:flex;background:var(--panel);border:1px solid var(--border);border-radius:7px;padding:2px">
      <For each={RANGES}>
        {(rg) => (
          <button
            type="button"
            aria-pressed={current() === rg}
            style={{
              padding: '4px 12px',
              font: `${current() === rg ? '500' : '400'} 12px 'Geist',sans-serif`,
              color: current() === rg ? 'var(--text)' : 'var(--text3)',
              background: current() === rg ? 'var(--chip)' : 'transparent',
              'border-radius': '5px',
              cursor: 'pointer',
            }}
            onClick={() => set(rg)}
          >
            {rg}
          </button>
        )}
      </For>
    </div>
  );
}
