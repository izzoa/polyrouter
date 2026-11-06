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

/** The switch (small = layers/channels, medium = settings).
 *
 * Every drawn value lives in `styles.css`, not inline (adopt-design-tokens-v2 D3): the
 * size pair is `toggle--md` (36 × 20) / `toggle--sm` (32 × 18), and the track colour is
 * `toggle--on` (Ink) / `toggle--off` (Control Edge) / `toggle--unavailable`, so the lock,
 * the geometry suite and the contrast suite all read the same rules.
 *
 * Busy (`locked`) and unavailable stay `aria-disabled` with activation ignored — never
 * native `disabled`, which would drop the focus a drawer's own controls must keep. */
export function Toggle(props: ToggleProps) {
  const inert = (): boolean => props.locked === true || props.unavailable === true;
  const stateClass = (): string =>
    props.unavailable === true ? 'toggle--unavailable' : props.on ? 'toggle--on' : 'toggle--off';
  return (
    <button
      type="button"
      class={`toggle ${props.size === 'md' ? 'toggle--md' : 'toggle--sm'} ${stateClass()}`}
      role="switch"
      aria-checked={props.on}
      aria-disabled={inert() ? true : undefined}
      aria-label={props.label}
      aria-describedby={props.describedBy}
      onClick={() => {
        if (inert()) return;
        props.onToggle();
      }}
    >
      <span class="toggle-knob" />
    </button>
  );
}
