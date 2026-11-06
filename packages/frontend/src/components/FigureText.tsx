import { For, type JSX } from 'solid-js';
import type { FigurePart, FigureTone } from '../data/figures';

/** Each tone's colour. `slot` has none of its own: an amount, or the `$0` before `free`,
 * inherits the ink of the slot it sits in (Ink in a table cell, Ink 3 on a price line, Deep
 * Ink on a picker's active option). */
const TONE_COLOR: Record<FigureTone, string | null> = {
  slot: null,
  ink2: 'var(--text2)',
  ink3: 'var(--text3)',
  green: 'var(--green-text)',
};

/** Renders a figure's parts (adopt-figure-states design D1, "Figure parts and their
 * tones"). Each part is one no-wrap unit, so a figure wraps only between parts, never
 * inside `· est.`, `· est. usage` or `not billed`; parts are separated by single spaces, so
 * the rendered text is exactly the figure's string form. Colour only repeats the words. */
export function FigureText(props: { parts: readonly FigurePart[] }): JSX.Element {
  return (
    <For each={props.parts}>
      {(p, i) => {
        const color = TONE_COLOR[p.tone];
        return (
          <>
            {i() > 0 ? ' ' : null}
            <span style={{ 'white-space': 'nowrap', ...(color === null ? {} : { color }) }}>
              {p.text}
            </span>
          </>
        );
      }}
    </For>
  );
}
