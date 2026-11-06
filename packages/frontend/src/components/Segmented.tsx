import { For } from 'solid-js';

/** The segmented control, as one source of styling.
 *
 * Extracted when a second one arrived (the Costs metric switch). Two copies of this markup
 * would have to agree on the track, the pressed treatment and the target floors by
 * inspection — and they sit inches apart on the same screen, so any drift is immediately
 * visible as two controls that do the same job and do not match.
 *
 * `.rs-seg` carries the option's whole presentation — the height family's 26px box, the
 * target floors from the responsive work, and the hover, pressed and selected states — so
 * nothing is drawn inline, where it would outrank `:hover` (adopt-design-tokens-v2 D19).
 * `data-label` repeats the label for `.rs-seg::after`, which holds the option at its selected
 * weight's width, so moving the selection moves nothing (D8). */
export function Segmented<T extends string>(props: {
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div class="seg-track" style="background:var(--panel)">
      <For each={props.options}>
        {(o) => (
          <button
            type="button"
            class="rs-seg"
            data-label={o.label}
            aria-pressed={props.value === o.id}
            onClick={() => {
              props.onChange(o.id);
            }}
          >
            {o.label}
          </button>
        )}
      </For>
    </div>
  );
}
