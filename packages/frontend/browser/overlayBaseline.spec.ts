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
 * WHY SOME AXES CARRY SLACK — and what the earlier explanation here got wrong.
 *
 * This comment used to say the app "ships no `@font-face`", so each platform fell back to its
 * own sans-serif. That is false: Geist is vendored under `public/fonts/` and linked from both
 * entry points, and `browserHarness.tsx:156` gates readiness on `document.fonts.ready`, so
 * every measurement here is taken with the real font loaded. A later version blamed whole-pixel
 * glyph-advance quantisation on Linux; that was contradicted by the recorded Linux values,
 * which include fractions (14.5, 178.375). Both stories were plausible and load-bearing, and
 * both sent people to the wrong place. This one claims less.
 *
 * What is actually measured: the SAME loaded fonts produce platform-dependent TEXT LAYOUT.
 * Across macOS, Ubuntu 22.04 and Ubuntu 24.04 — same harness, same Chromium, fonts verified
 * loaded, three cold runs per environment hashing identically — eight of the thirteen surfaces
 * and all three pinned controls are byte-identical, five of them reproducing sub-pixel values
 * (704.5, 173.7813) exactly. Two measurements differ: this toast's shrink-wrapped width, and
 * `confirm:bodyCapture`'s height, where the copy wraps to one more line. No mechanism beyond
 * that is claimed; establishing one would need controlled text-run measurement.
 *
 * `boxOf` rounds every rectangle before comparison, so "exact" here means integer-rounded
 * equality — which is why a 0.3px width difference passes and a 24px one does not.
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
  // Shrink-wrapped around one sentence, so `x` and `w` move. `y` and `h` do NOT: the runner
  // printed `[442, 843, 557, 35]` against macOS's `[454, 843, 533, 35]`, so both are
  // runner-confirmed and identical.
  toast: ['x', 'w'],
};

/** DEFAULT allowances, for soft axes whose cross-platform variance has not been measured.
 *
 * These were sized against forced fallback-face swaps (Verdana, Georgia) — an accurate
 * measurement of a mechanism that does not occur, since Geist always loads. They are kept, not
 * derived: eleven surfaces still rely on them, and CI has never disclosed their values on the
 * runner. CI reports only the measurements that FAIL, so the ones that pass do so *inside*
 * these allowances — a pass is not a measurement, and narrowing them would be inference.
 *
 * Retiring them needs a capture-only CI run that logs every surface rather than only failures.
 * Until then they stay wide, and that is a known, recorded gap rather than a claim. */
const LINE_SLACK = 40;
const WIDTH_SLACK = 0.15;

/** MEASURED allowances, overriding the defaults for the axes whose cross-platform spread is
 * actually known. An override table rather than narrower defaults: this leaves every unmeasured
 * surface untouched *by construction*, instead of by a refactor that has to be audited.
 *
 * Both entries are bounded by the runner's own printed numbers, not by inference — CI's
 * `toEqual` diff prints the full received box, with the unchanged elements as context. */
const MEASURED_SLACK: Record<string, Partial<Record<Axis, number>>> = {
  toast: {
    // macOS 533, Ubuntu 24.04 and the CI runner both 557 → spread 24px. 32 leaves 8px for an
    // environment this has not seen.
    w: 32,
    // The box recentres as the width changes, so `x` moves by exactly half the width spread:
    // 454 → 442. 16px, same 8px margin. The centre assertion below pins it further.
    x: 16,
  },
  'confirm:bodyCapture': {
    // macOS 160, runner 178 → 18px, one wrapped line of copy. 26 leaves the same 8px.
    h: 26,
  },
};

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
        // A measured override where the cross-platform spread is known; otherwise the wide
        // default, which is an unretired gap rather than a derived number.
        const measured = MEASURED_SLACK[s.name]?.[axis];
        const slack =
          measured ?? (axis === 'w' ? Math.round(expected![i]! * WIDTH_SLACK) : LINE_SLACK);
        expect(
          Math.abs(actual[i]! - expected![i]!),
          `${s.name} changed ${axis} by more than platform text layout explains ` +
            `(${expected![i]} → ${actual[i]}, allowed ${slack}` +
            `${measured === undefined ? ', unmeasured default' : ', measured'})`,
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
