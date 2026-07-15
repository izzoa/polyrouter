interface ToggleProps {
  on: boolean;
  size?: 'sm' | 'md';
  locked?: boolean;
  onToggle: () => void;
}

/** The prototype's switch control (small = layers/channels, medium = settings). */
export function Toggle(props: ToggleProps) {
  const dims = () =>
    props.size === 'md'
      ? { w: 34, h: 19, knob: 15, onLeft: 17 }
      : { w: 30, h: 17, knob: 13, onLeft: 15 };
  return (
    <div
      class="toggle"
      style={{
        width: `${String(dims().w)}px`,
        height: `${String(dims().h)}px`,
        background: props.on ? 'var(--accent)' : 'var(--faint)',
        cursor: props.locked === true ? 'not-allowed' : 'pointer',
      }}
      onClick={() => props.onToggle()}
    >
      <div
        class="toggle-knob"
        style={{
          width: `${String(dims().knob)}px`,
          height: `${String(dims().knob)}px`,
          left: props.on ? `${String(dims().onLeft)}px` : '2px',
        }}
      />
    </div>
  );
}
