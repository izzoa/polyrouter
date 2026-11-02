interface ToggleProps {
  on: boolean;
  size?: 'sm' | 'md';
  /** "Do not toggle" — an in-flight write elsewhere (busy). Keeps the on/off look. */
  locked?: boolean;
  /** The instance cannot enable this switch at all (split-auto-routing-readout-setup
   * D7): drawn distinct from off AND from busy — a transparent track with a dashed
   * border — announced as disabled, and inert on click. The caller also states
   * "Unavailable" in text, so the drawing is never the only signal. */
  unavailable?: boolean;
  onToggle: () => void;
  /** Accessible name for the switch (icon-only control). */
  label: string;
  /** Id of an element describing the switch — announced with it, so the
   * consequences of flipping it are available to a screen reader and not only to a
   * sighted reader who hovers (add-batch-mode-help). */
  describedBy?: string | undefined;
}

/** The prototype's switch control (small = layers/channels, medium = settings). The
 * track colour lives in classes (`toggle--on` / `toggle--off` / `toggle--unavailable`),
 * not inline, so the unavailable presentation can override it. */
export function Toggle(props: ToggleProps) {
  const dims = () =>
    props.size === 'md'
      ? { w: 34, h: 19, knob: 15, onLeft: 17 }
      : { w: 30, h: 17, knob: 13, onLeft: 15 };
  const inert = (): boolean => props.locked === true || props.unavailable === true;
  const stateClass = (): string =>
    props.unavailable === true ? 'toggle--unavailable' : props.on ? 'toggle--on' : 'toggle--off';
  return (
    <button
      type="button"
      class={`toggle ${stateClass()}`}
      role="switch"
      aria-checked={props.on}
      aria-disabled={inert() ? true : undefined}
      aria-label={props.label}
      aria-describedby={props.describedBy}
      style={{
        width: `${String(dims().w)}px`,
        height: `${String(dims().h)}px`,
        cursor: inert() ? 'not-allowed' : 'pointer',
      }}
      onClick={() => {
        if (inert()) return;
        props.onToggle();
      }}
    >
      <span
        class="toggle-knob"
        style={{
          width: `${String(dims().knob)}px`,
          height: `${String(dims().knob)}px`,
          left: props.on && props.unavailable !== true ? `${String(dims().onLeft)}px` : '2px',
        }}
      />
    </button>
  );
}
