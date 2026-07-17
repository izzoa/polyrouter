interface ToggleProps {
  on: boolean;
  size?: 'sm' | 'md';
  locked?: boolean;
  onToggle: () => void;
  /** Accessible name for the switch (icon-only control). */
  label: string;
}

/** The prototype's switch control (small = layers/channels, medium = settings). */
export function Toggle(props: ToggleProps) {
  const dims = () =>
    props.size === 'md'
      ? { w: 34, h: 19, knob: 15, onLeft: 17 }
      : { w: 30, h: 17, knob: 13, onLeft: 15 };
  return (
    <button
      type="button"
      class="toggle"
      role="switch"
      aria-checked={props.on}
      aria-disabled={props.locked === true ? true : undefined}
      aria-label={props.label}
      style={{
        width: `${String(dims().w)}px`,
        height: `${String(dims().h)}px`,
        background: props.on ? 'var(--accent)' : 'var(--text3)',
        cursor: props.locked === true ? 'not-allowed' : 'pointer',
      }}
      onClick={() => {
        if (props.locked === true) return;
        props.onToggle();
      }}
    >
      <span
        class="toggle-knob"
        style={{
          width: `${String(dims().knob)}px`,
          height: `${String(dims().knob)}px`,
          left: props.on ? `${String(dims().onLeft)}px` : '2px',
        }}
      />
    </button>
  );
}
