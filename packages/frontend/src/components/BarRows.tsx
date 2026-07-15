import { For } from 'solid-js';
import type { SpendDatum } from '../types';

/** Horizontal spend bars used on Overview and Costs, ported from the prototype. */
export function BarRows(props: { data: SpendDatum[] }) {
  const max = () => Math.max(...props.data.map((d) => d.v || 0.0001));
  const pct = (d: SpendDatum) =>
    `${String(Math.round((((d.free ?? false) ? (d.fv ?? 0) : d.v) / max()) * 100))}%`;
  return (
    <div style="display:flex;flex-direction:column;gap:11px">
      <For each={props.data}>
        {(d) => (
          <div>
            <div style="display:flex;justify-content:space-between;font:400 11.5px 'Geist Mono',monospace;color:var(--text2);margin-bottom:4px">
              <span>{d.n}</span>
              <span style={{ color: (d.free ?? false) ? 'var(--green)' : 'var(--text)' }}>
                {(d.free ?? false) ? 'free' : `$${d.v.toFixed(2)}`}
              </span>
            </div>
            <div class="bar-track">
              <div
                class="bar-fill"
                style={{
                  width: pct(d),
                  background: (d.free ?? false) ? 'var(--faint)' : 'var(--accent)',
                }}
              />
            </div>
          </div>
        )}
      </For>
    </div>
  );
}
