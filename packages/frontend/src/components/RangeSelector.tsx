import { For } from 'solid-js';
import { useApp } from '../state/context';
import type { Range } from '../types';

const RANGES: Range[] = ['24h', '7d', '30d'];

/** The `24h`/`7d`/`30d` segmented control, shared by Overview and Costs. Driving
 * it calls `setRange`, which reloads the active aggregate page. */
export function RangeSelector() {
  const app = useApp();
  const { state } = app;
  return (
    <div style="display:flex;background:var(--panel);border:1px solid var(--border);border-radius:7px;padding:2px">
      <For each={RANGES}>
        {(rg) => (
          <button
            type="button"
            aria-pressed={state.range === rg}
            style={{
              padding: '4px 12px',
              font: `${state.range === rg ? '500' : '400'} 12px 'Geist',sans-serif`,
              color: state.range === rg ? 'var(--text)' : 'var(--text3)',
              background: state.range === rg ? 'var(--chip)' : 'transparent',
              'border-radius': '5px',
              cursor: 'pointer',
            }}
            onClick={() => app.setRange(rg)}
          >
            {rg}
          </button>
        )}
      </For>
    </div>
  );
}
