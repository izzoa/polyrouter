import { For } from 'solid-js';
import { microsOfUsd, money, priceLabelParts } from '../data/figures';
import type { SpendDatum } from '../types';
import { FigureText } from './FigureText';

/** A free bar's label: `$0 free`, with only `free` green (adopt-figure-states D1, D4). */
const FREE_PARTS = priceLabelParts({ kind: 'free', estimated: false });

/** Horizontal bars used on Overview and Costs, ported from the prototype.
 *
 * `format` is passed in rather than assumed: the same component now renders money and
 * token counts. One component, not two — two would have to agree on bar geometry, the
 * empty case and the free-tier treatment by inspection.
 *
 * `free` stays CURRENCY-only and is simply absent for a token metric. Free means a *price*
 * of zero, not an absence of work: a free provider still burns tokens, so a token bar
 * rendered grey and labelled "free" would state something untrue. A free bar reads `$0 free`:
 * the `$0` keeps the row's Ink and only `free` is green, so the word, not the colour, names it.
 * Money defaults to cents (adopt-figure-states D2), so a sub-cent bar reads `<$0.01`.
 *
 * The bars are NEUTRAL — Ink 3, a free bar Faint — and never indigo: on Overview and Costs
 * they sit beside the view's focal series (the requests chart, the request mix), and the
 * Indigo Budget allows a view one indigo series (adopt-design-tokens-v2 D11). Ink 3 keeps them
 * quieter than the focal series while clearing 3:1 on the bar track. */
export function BarRows(props: { data: SpendDatum[]; format?: (v: number) => string }) {
  const max = () => Math.max(...props.data.map((d) => d.v || 0.0001));
  const pct = (d: SpendDatum) =>
    `${String(Math.round((((d.free ?? false) ? (d.fv ?? 0) : d.v) / max()) * 100))}%`;
  const label = (d: SpendDatum): string =>
    props.format ? props.format(d.v) : money(microsOfUsd(d.v), 'cents');
  return (
    <div data-series="neutral" style="display:flex;flex-direction:column;gap:12px">
      <For each={props.data}>
        {(d) => (
          <div>
            {/* The name is an identifier (a model, provider or agent): Mono. The value is a
                figure: Geist with tabular numerals (adopt-design-tokens-v2 task 9.1). */}
            <div
              class="t-dense"
              style="display:flex;justify-content:space-between;color:var(--text2);margin-bottom:4px"
            >
              <span class="mono">{d.n}</span>
              <span class="figure" style="color:var(--text)">
                {(d.free ?? false) ? <FigureText parts={FREE_PARTS} /> : label(d)}
              </span>
            </div>
            <div class="bar-track">
              <div
                class="bar-fill"
                style={{
                  width: pct(d),
                  background: (d.free ?? false) ? 'var(--faint)' : 'var(--text3)',
                }}
              />
            </div>
          </div>
        )}
      </For>
    </div>
  );
}
