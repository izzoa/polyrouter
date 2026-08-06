import { For } from 'solid-js';
import type { SpendDatum } from '../types';

/** Horizontal bars used on Overview and Costs, ported from the prototype.
 *
 * `format` is passed in rather than assumed: the same component now renders money and
 * token counts. One component, not two — two would have to agree on bar geometry, the
 * empty case and the free-tier treatment by inspection.
 *
 * `free` stays CURRENCY-only and is simply absent for a token metric. Free means a *price*
 * of zero, not an absence of work: a free provider still burns tokens, so a token bar
 * rendered grey and labelled "free" would state something untrue. */
export function BarRows(props: { data: SpendDatum[]; format?: (v: number) => string }) {
  const max = () => Math.max(...props.data.map((d) => d.v || 0.0001));
  const pct = (d: SpendDatum) =>
    `${String(Math.round((((d.free ?? false) ? (d.fv ?? 0) : d.v) / max()) * 100))}%`;
  const label = (d: SpendDatum): string =>
    props.format ? props.format(d.v) : `$${d.v.toFixed(2)}`;
  return (
    <div style="display:flex;flex-direction:column;gap:11px">
      <For each={props.data}>
        {(d) => (
          <div>
            <div style="display:flex;justify-content:space-between;font:400 11.5px 'Geist Mono',monospace;color:var(--text2);margin-bottom:4px">
              <span>{d.n}</span>
              <span style={{ color: (d.free ?? false) ? 'var(--green-text)' : 'var(--text)' }}>
                {(d.free ?? false) ? 'free' : label(d)}
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
