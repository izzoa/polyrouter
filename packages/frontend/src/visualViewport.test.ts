/** The visual-viewport seam (phase2-responsive-overlays, task 4.6).
 *
 * The arithmetic here is load-bearing and was derived by measurement, not from a spec, so
 * it is tested against the numbers actually observed in Chrome at 390x844 — recorded in the
 * change's design as: pinch 2x → vv.height 422, 3x → 281.33, and the continuous sweep
 * 1.37 → 616.058, 1.5 → 562.667, 2.25 → 375.111, 2.5 → 337.6.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cssVars, installViewportPublisher, occludedBottom } from './visualViewport';

const LAYOUT = 844;

/** Installs a fake `visualViewport` and returns a handle to drive it. */
function fakeViewport(init: {
  width?: number;
  height: number;
  scale?: number;
  offsetTop?: number;
  offsetLeft?: number;
}) {
  const listeners = new Map<string, Set<() => void>>();
  const vv = {
    width: init.width ?? 390,
    height: init.height,
    scale: init.scale ?? 1,
    offsetTop: init.offsetTop ?? 0,
    offsetLeft: init.offsetLeft ?? 0,
    addEventListener: (t: string, fn: () => void) => {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t)?.add(fn);
    },
    removeEventListener: (t: string, fn: () => void) => listeners.get(t)?.delete(fn),
  };
  Object.defineProperty(globalThis, 'visualViewport', {
    value: vv,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(document.documentElement, 'clientHeight', {
    value: LAYOUT,
    configurable: true,
  });
  return {
    vv,
    fire: (t: string) => listeners.get(t)?.forEach((f) => { f(); }),
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'visualViewport');
  document.documentElement.removeAttribute('style');
  vi.restoreAllMocks();
});

describe('occludedBottom', () => {
  it('is zero when nothing is covering the viewport', () => {
    expect(occludedBottom(LAYOUT, LAYOUT, 1)).toBe(0);
  });

  it('reports the keyboard at scale 1', () => {
    expect(occludedBottom(LAYOUT, LAYOUT - 300, 1)).toBe(300);
  });

  it('is ZERO at every measured pinch-zoom level — zoom is not a keyboard', () => {
    // Without the `* scale` correction these would report 422 and 563 (measured), sending
    // a sheet two-thirds up the screen for a user who merely pinched to read a value.
    for (const [scale, height] of [
      [1.37, 616.058],
      [1.5, 562.667],
      [2, 422],
      [2.25, 375.111],
      [2.5, 337.6],
      [3, 281.333],
    ] as const) {
      expect(occludedBottom(LAYOUT, height, scale), `scale ${String(scale)}`).toBe(0);
    }
  });

  it('reports the keyboard correctly while ALSO zoomed', () => {
    // The case a `scale === 1` guard silently fails: a zoomed-in user taps a field.
    // The lift is a CSS length, so it is the keyboard's screen height divided by scale —
    // 150 layout px renders as the 300 screen px wanted.
    for (const [scale, expected] of [
      [1, 300],
      [1.5, 200],
      [2, 150],
      [2.5, 120],
      [3, 100],
    ] as const) {
      const height = (LAYOUT - 300) / scale;
      expect(occludedBottom(LAYOUT, height, scale), `scale ${String(scale)}`).toBeCloseTo(
        expected,
        6,
      );
    }
  });

  it('ignores sub-pixel residuals rather than publishing a phantom lift', () => {
    expect(occludedBottom(LAYOUT, LAYOUT - 0.004, 1)).toBe(0);
  });

  it('never returns a negative lift', () => {
    expect(occludedBottom(LAYOUT, LAYOUT + 200, 1)).toBe(0);
  });

  it('degrades to no lift on a nonsensical scale', () => {
    expect(occludedBottom(LAYOUT, 400, 0)).toBe(0);
    expect(occludedBottom(LAYOUT, 400, Number.NaN)).toBe(0);
  });
});

describe('the publisher', () => {
  it('publishes the snapshot as CSS custom properties', () => {
    fakeViewport({ height: LAYOUT - 300 });
    const p = installViewportPublisher();
    expect(document.documentElement.style.getPropertyValue('--vv-occluded-bottom')).toBe('300px');
    expect(document.documentElement.style.getPropertyValue('--vv-height')).toBe('544px');
    p.dispose();
  });

  it('republishes when the visual viewport resizes', () => {
    const h = fakeViewport({ height: LAYOUT });
    const p = installViewportPublisher();
    expect(document.documentElement.style.getPropertyValue('--vv-occluded-bottom')).toBe('0px');
    h.vv.height = LAYOUT - 320;
    h.fire('resize');
    expect(document.documentElement.style.getPropertyValue('--vv-occluded-bottom')).toBe('320px');
    p.dispose();
  });

  it('listens for scroll too — panning a zoomed viewport fires only that', () => {
    const h = fakeViewport({ height: LAYOUT });
    const p = installViewportPublisher();
    const seen: number[] = [];
    h.vv.height = LAYOUT - 100;
    h.fire('scroll');
    seen.push(Number.parseFloat(
      document.documentElement.style.getPropertyValue('--vv-occluded-bottom'),
    ));
    expect(seen).toEqual([100]);
    p.dispose();
  });

  it('falls back to the layout viewport when the API is absent', () => {
    // The degradation that matters: no API means exactly today's behaviour, not an
    // approximation of it.
    Reflect.deleteProperty(globalThis, 'visualViewport');
    Object.defineProperty(document.documentElement, 'clientHeight', {
      value: LAYOUT,
      configurable: true,
    });
    const p = installViewportPublisher();
    const s = p.get();
    expect(s.height).toBe(LAYOUT);
    expect(s.scale).toBe(1);
    expect(s.occludedBottom).toBe(0);
    p.dispose();
  });

  it('removes its listeners and its custom properties on dispose', () => {
    const h = fakeViewport({ height: LAYOUT });
    const p = installViewportPublisher();
    expect(h.listenerCount()).toBeGreaterThan(0);
    p.dispose();
    expect(h.listenerCount()).toBe(0);
    expect(document.documentElement.style.getPropertyValue('--vv-occluded-bottom')).toBe('');
  });

  it('notifies its subscriber on change', () => {
    const h = fakeViewport({ height: LAYOUT });
    const seen: number[] = [];
    const p = installViewportPublisher((s) => seen.push(s.occludedBottom));
    h.vv.height = LAYOUT - 250;
    h.fire('resize');
    expect(seen).toEqual([250]);
    p.dispose();
  });
});

describe('cssVars', () => {
  it('names exactly the properties the stylesheet consumes', () => {
    // A rename here silently breaks every sheet rule, with no test failing anywhere near
    // the stylesheet — so the contract is asserted explicitly.
    expect(
      Object.keys(cssVars({
        width: 1,
        height: 2,
        offsetLeft: 0,
        offsetTop: 0,
        scale: 1,
        occludedBottom: 3,
      })).sort(),
    ).toEqual(['--vv-height', '--vv-occluded-bottom', '--vv-width']);
  });
});
