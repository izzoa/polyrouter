import type { JSX } from 'solid-js';

/** Two labels stacked in ONE grid cell, the inactive one `visibility: hidden`
 * (adopt-design-tokens-v2 D14 / D19).
 *
 * The cell is always as wide as the wider label, so a control that swaps its label —
 * `Save budget` → `Saving…`, `/v1` → `Copied` — keeps its width with no measuring and no
 * layout shift, and nothing beside it moves. Measuring `offsetWidth` at the swap was
 * rejected: it is wrong after a resize or a font swap.
 *
 * A `visibility: hidden` label is also out of the accessibility tree, so a button's name is
 * the label that is showing. */
export function StackedLabel(props: {
  /** True shows `alt`; false shows `rest`. */
  alt: boolean;
  rest: JSX.Element;
  altLabel: JSX.Element;
}) {
  return (
    <span class="stacked-label">
      <span class="stacked-label-item" data-shown={props.alt ? 'false' : 'true'}>
        {props.rest}
      </span>
      <span class="stacked-label-item" data-shown={props.alt ? 'true' : 'false'}>
        {props.altLabel}
      </span>
    </span>
  );
}
