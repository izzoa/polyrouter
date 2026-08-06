/** The visual-viewport seam (phase2-responsive-overlays, group 4).
 *
 * One accessor, two consumers with different needs:
 *
 *  - **CSS** cannot read a JS value, so this publishes custom properties on the document
 *    element. Custom properties are illegal in a `@media` prelude but perfectly legal in a
 *    declaration, which is exactly the split needed here — thresholds stay literal in the
 *    stylesheet, measurements arrive as variables.
 *  - **`ModelPicker`** reads the snapshot directly to position its panel, which is why the
 *    snapshot carries both axes and both offsets rather than just a height.
 *
 * Where `visualViewport` is absent, everything falls back to the layout viewport and the
 * derived inset computes to 0 — so every consumer degrades to exactly the behaviour that
 * shipped before this module existed.
 */

export interface ViewportSnapshot {
  /** Visible width in CSS pixels. */
  readonly width: number;
  /** Visible height in CSS pixels. */
  readonly height: number;
  readonly offsetLeft: number;
  readonly offsetTop: number;
  /** Pinch-zoom factor. 1 when not zoomed. */
  readonly scale: number;
  /**
   * How far a bottom-anchored fixed element must be lifted, **as a CSS length**, to clear
   * an on-screen keyboard. See `occludedBottom` for why this is not simply the height
   * difference.
   */
  readonly occludedBottom: number;
}

/** Residuals below this are rounding noise from the division, not a real inset.
 * Measured at ~4e-4px at fractional zoom levels; a bare `> 0` test would publish those. */
const EPSILON = 0.01;

/**
 * The amount a `position: fixed` bottom-anchored surface must be lifted to sit above the
 * on-screen keyboard, expressed in the layout CSS pixels that `bottom` is measured in.
 *
 * Two things make this less obvious than it looks.
 *
 * **Zoom shrinks the visual viewport exactly as a keyboard does.** `layoutH - vv.height`
 * cannot tell them apart: measured in Chrome at 390x844, pinching to 2x reports 422px of
 * "occlusion" and 3x reports 563px, with no keyboard anywhere. Since the visible layout
 * height is `(layoutH - keyboard) / scale`, multiplying back by `scale` recovers the
 * keyboard alone — and keeps working when both happen at once, which a `scale === 1` guard
 * would not: it would simply stop lifting the sheet for a zoomed-in user who taps a field.
 *
 * **`bottom` is a layout inset, and the screen magnifies it.** Lifting by the keyboard's
 * screen height would over-lift by exactly the zoom factor, so the result is divided by
 * scale. `(layoutH - vv.height * scale) / scale` simplifies to the expression below.
 *
 * `offsetTop` is deliberately not used. Including it would pin the surface to the bottom of
 * the *visible region*, which makes it chase the user's pan — and it is why elastic
 * overscroll's negative offsets cannot affect this at all.
 */
export function occludedBottom(layoutHeight: number, height: number, scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 0;
  const lift = layoutHeight / scale - height;
  return lift > EPSILON ? lift : 0;
}

/**
 * Reads the visible region on demand. A handful of property reads, so callers that need a
 * value at one moment — a popup deciding where to open — can just call this rather than
 * subscribing.
 *
 * The bounds are in **layout** coordinates, which is what `getBoundingClientRect()` and a
 * `position: fixed` inset both speak, so callers can compare the two directly.
 */
export function readViewport(): ViewportSnapshot {
  return read();
}

/** The visible region in layout coordinates: what a fixed-position surface must fit. */
export function visibleBounds(s: ViewportSnapshot = read()): {
  top: number;
  bottom: number;
  left: number;
  right: number;
} {
  return {
    top: s.offsetTop,
    bottom: s.offsetTop + s.height,
    left: s.offsetLeft,
    right: s.offsetLeft + s.width,
  };
}

function read(): ViewportSnapshot {
  const layoutHeight = document.documentElement.clientHeight;
  const vv = globalThis.visualViewport;
  if (!vv) {
    // No API: report the layout viewport and no occlusion, which is precisely today's
    // behaviour rather than a degraded approximation of it.
    return {
      width: document.documentElement.clientWidth,
      height: layoutHeight,
      offsetLeft: 0,
      offsetTop: 0,
      scale: 1,
      occludedBottom: 0,
    };
  }
  return {
    width: vv.width,
    height: vv.height,
    offsetLeft: vv.offsetLeft,
    offsetTop: vv.offsetTop,
    scale: vv.scale,
    occludedBottom: occludedBottom(layoutHeight, vv.height, vv.scale),
  };
}

/** The custom properties CSS consumes. Names are part of the stylesheet's contract. */
export function cssVars(s: ViewportSnapshot): Record<string, string> {
  return {
    '--vv-height': `${String(s.height)}px`,
    '--vv-width': `${String(s.width)}px`,
    '--vv-occluded-bottom': `${String(s.occludedBottom)}px`,
  };
}

/**
 * Starts publishing, and returns a snapshot getter plus a teardown.
 *
 * The getter is a plain function rather than a signal so this module stays usable from
 * non-reactive code; callers that need reactivity wrap it (see `createViewport`).
 */
export function installViewportPublisher(onChange?: (s: ViewportSnapshot) => void): {
  get: () => ViewportSnapshot;
  dispose: () => void;
} {
  let snapshot = read();

  const publish = (): void => {
    const el = document.documentElement;
    for (const [k, v] of Object.entries(cssVars(snapshot))) el.style.setProperty(k, v);
  };

  const update = (): void => {
    snapshot = read();
    publish();
    onChange?.(snapshot);
  };

  publish();

  const vv = globalThis.visualViewport;
  // `scroll` as well as `resize`: panning a zoomed viewport fires only the former, and a
  // consumer positioning against the visible region needs to hear about it.
  vv?.addEventListener('resize', update);
  vv?.addEventListener('scroll', update);
  // The layout viewport can change without the visual one firing (rotation, a desktop
  // window resize), and `occludedBottom` is relative to it.
  globalThis.addEventListener('resize', update);

  return {
    get: () => snapshot,
    dispose: () => {
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
      globalThis.removeEventListener('resize', update);
      const el = document.documentElement;
      for (const k of Object.keys(cssVars(snapshot))) el.style.removeProperty(k);
    },
  };
}
