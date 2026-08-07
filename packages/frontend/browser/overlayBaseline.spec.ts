/** Desktop overlay parity (phase2-responsive-overlays, task 1.1 / 9.7).
 *
 * Phase 1 pinned page geometry against v0.11.0, but it only ever WALKS pages — it never
 * opens an overlay. So "desktop overlay geometry is unchanged" was unmeasurable, and a
 * baseline captured after the sheets were written would only have proved the new code
 * equals itself. These numbers were therefore captured BEFORE any sheet CSS existed, from
 * the tree at `4f3d039`; provenance is in the change's `measurements.md`.
 *
 * Pinned as numbers rather than re-derived per run, for the same reason phase 1 pins its
 * baseline: a build-and-diff per run is slow, and the pre-change tree is a fixed point.
 *
 * These numbers are LAYOUT, not text metrics. `styles.css` asks for `'Geist', sans-serif`
 * and the app ships no `@font-face`, so the generic fallback resolves per platform —
 * Helvetica here, DejaVu on the Linux runner — and an overlay sized by its own text differs
 * accordingly. Re-running this matrix under two deliberately different faces (a wider
 * Verdana and a serif Georgia), applied at page load, measured exactly which axes that
 * moves — and one thing held on ALL THIRTEEN surfaces under BOTH: the horizontal CENTRE
 * never moved. So the centre is asserted exactly, every CSS-pinned axis is asserted exactly,
 * and only the measured text-sized axes carry slack. Nothing is weakened by this: a sheet
 * leaking into desktop moves an overlay by hundreds of pixels — a full-width bottom sheet
 * is 1440 wide and bottom-anchored — not by a wrapped line.
 *
 * The face must be applied BEFORE the surface opens to measure this honestly. Applying it
 * after only re-lays-out the overlay itself, which hid that the picker is anchored to a
 * control and therefore follows the text layout of the page above it too.
 *
 * What this gives up, stated rather than implied: a change that alters ONLY a soft axis by
 * less than its slack — 8px of extra padding on a dialog, say — no longer fails here. The
 * leak this suite exists to catch is categorical (a sheet is full-width and bottom-anchored,
 * so it fails on `x`, `w` and the centre, all still exact), and verified as such: forcing
 * `.modal-card` into a bottom sheet fails all six modal surfaces. Subtle spacing is the
 * design gate's job, not this one's.
 */
import { expect, test, type Page } from '@playwright/test';
import { SURFACES, boxOf } from './overlays';

type Axis = 'x' | 'y' | 'w' | 'h';
const AXES: readonly Axis[] = ['x', 'y', 'w', 'h'];

/** Axes each surface sizes from its own TEXT, measured rather than guessed: the matrix was
 * re-run with a different face forced on every element from page load, under two faces, and
 * the boxes diffed. Anything absent here is CSS-pinned and stays an exact assertion. */
const TEXT_SIZED: Record<string, readonly Axis[]> = {
  drawer: [], // fixed width, full viewport height
  'nav:expanded': [], // fixed width, full viewport height
  // Fixed width, content-driven height — and vertically centred, so `y` follows `h`.
  'modal:newAgent': ['y', 'h'],
  'modal:newProvider': ['y', 'h'],
  'modal:editProvider': ['y', 'h'],
  'modal:newLimit': ['y', 'h'],
  'modal:channel': ['y', 'h'],
  'modal:keyReveal': ['y', 'h'],
  // Both confirms pin x/y/width; only the copy's wrap height moves.
  'confirm:bodyCapture': ['h'],
  'confirm:disableCapture': ['h'],
  accountMenu: ['y', 'h'], // bottom-anchored, so `y` follows `h`
  // Anchored to a control, so `y` tracks the text layout of the page above it, not just
  // the picker's own content.
  picker: ['y', 'h'],
  toast: ['x', 'y', 'w', 'h'], // shrink-wrapped around one sentence, in both axes
};

/** A wrapped line is ~18px at this UI's sizes. The largest drift measured across both probe
 * faces was 28px (a provider form's stack of labels) and the largest `y` shift 16px; the
 * runner's confirm dialog moved 18px. 40 covers all of it with margin while staying well
 * under the shortest overlay (219px) and orders of magnitude under a real regression. */
const LINE_SLACK = 40;
/** A shrink-wrapped width scales with the face itself rather than by whole lines: the toast
 * measured +7.5% and -5.3% across the two probe faces, and +4.5% on the runner. */
const WIDTH_SLACK = 0.15;

/** [x, y, width, height] at 1440x900, except the nav which exists as an overlay only
 * below the threshold and is therefore pinned at 390x844. */
const BASELINE: Record<string, [number, number, number, number]> = {
  drawer: [1000, 0, 440, 900],
  'modal:newAgent': [480, 324, 480, 252],
  'modal:newProvider': [480, 98, 480, 705],
  'modal:editProvider': [480, 98, 480, 705],
  'modal:newLimit': [480, 174, 480, 552],
  'modal:channel': [480, 166, 480, 568],
  'modal:keyReveal': [480, 341, 480, 219],
  'confirm:bodyCapture': [500, 270, 440, 160],
  'confirm:disableCapture': [500, 270, 440, 141],
  'nav:expanded': [0, 0, 208, 844],
  accountMenu: [18, 661, 171, 139],
  picker: [253, 266, 320, 76],
  toast: [454, 843, 533, 35],
};

async function open(page: Page): Promise<void> {
  await page.goto('/browser-harness.html');
  await page.waitForSelector('html[data-harness-ready="true"]');
  await page.waitForSelector('[data-pane="sidebar"]');
}

for (const s of SURFACES) {
  const vp = s.narrowOnly ? { width: 390, height: 844 } : { width: 1440, height: 900 };
  test.describe(`${s.name} keeps its pre-change geometry @${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp });

    test('unchanged', async ({ page }) => {
      await open(page);
      await s.open(page);
      // Entrance animations are transforms; measuring mid-flight reports a shifted box.
      await page.waitForTimeout(400);
      const expected = BASELINE[s.name];
      expect(expected, `no baseline pinned for ${s.name}`).toBeDefined();
      const actual = await boxOf(page, s.sel);
      const soft = new Set(TEXT_SIZED[s.name] ?? []);

      // The anchoring the CSS actually controls, and the one thing no font swap moved.
      // Each edge is rounded independently, so the centre can wobble by a pixel.
      const centre = (b: readonly number[]): number => b[0]! + b[2]! / 2;
      expect(
        Math.abs(centre(actual) - centre(expected!)),
        `${s.name} is no longer centred where it was (${centre(expected!)} → ${centre(actual)})`,
      ).toBeLessThanOrEqual(1);

      AXES.forEach((axis, i) => {
        if (!soft.has(axis)) {
          expect(actual[i], `${s.name} moved or resized on ${axis}, a CSS-pinned axis`).toBe(
            expected![i],
          );
          return;
        }
        const slack = axis === 'w' ? Math.round(expected![i]! * WIDTH_SLACK) : LINE_SLACK;
        expect(
          Math.abs(actual[i]! - expected![i]!),
          `${s.name} changed ${axis} by more than a fallback font can explain ` +
            `(${expected![i]} → ${actual[i]}, slack ${slack})`,
        ).toBeLessThanOrEqual(slack);
      });
    });
  });
}

test('every surface in the matrix has a pinned baseline', () => {
  // Guards the enumeration itself: adding a surface without pinning it would otherwise
  // leave it silently unverified, which is exactly how the overlays escaped phase 1.
  expect(SURFACES.map((s) => s.name).filter((n) => !(n in BASELINE))).toEqual([]);
});

test('every surface declares which of its axes are text-sized', () => {
  // Omission must not read as "fully CSS-pinned" by accident: a missing entry silently
  // makes every axis exact, which is the assertion most likely to be platform-dependent.
  expect(SURFACES.map((s) => s.name).filter((n) => !(n in TEXT_SIZED))).toEqual([]);
});
