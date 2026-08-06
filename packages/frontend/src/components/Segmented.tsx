import { For } from 'solid-js';

/** The segmented control, as one source of styling.
 *
 * Extracted when a second one arrived (the Costs metric switch). Two copies of this markup
 * would have to agree on the track, the pressed treatment and the target floors by
 * inspection — and they sit inches apart on the same screen, so any drift is immediately
 * visible as two controls that do the same job and do not match.
 *
 * `.rs-seg` carries the locked target floors from the responsive work; keep it. */
export function Segmented<T extends string>(props: {
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div style="display:flex;background:var(--panel);border:1px solid var(--border);border-radius:7px;padding:2px">
      <For each={props.options}>
        {(o) => (
          <button
            type="button"
            class="rs-seg"
            aria-pressed={props.value === o.id}
            style={{
              font: `${props.value === o.id ? '500' : '400'} 12px 'Geist',sans-serif`,
              color: props.value === o.id ? 'var(--text)' : 'var(--text3)',
              background: props.value === o.id ? 'var(--chip)' : 'transparent',
              'border-radius': '5px',
              cursor: 'pointer',
            }}
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
