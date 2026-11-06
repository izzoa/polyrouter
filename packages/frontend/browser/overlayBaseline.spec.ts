/** Desktop overlay parity (phase2-responsive-overlays, task 1.1 / 9.7).
 *
 * Phase 1 pinned page geometry against v0.11.0, but it only ever WALKS pages — it never
 * opens an overlay. So "desktop overlay geometry is unchanged" was unmeasurable, and a
 * baseline captured after the sheets were written would only have proved the new code
 * equals itself. These numbers were therefore captured BEFORE any sheet CSS existed, from
 * the tree at `4f3d039`; provenance is in the change's `measurements.md`.
 *
 * RE-PINNED 2026-11-02 by adopt-design-tokens-v2 (task 14.3), a RECORDED desktop change
 * (STYLESEED.md "Desktop geometry changes only through a recorded change"): the height
 * family, the type and spacing scales, the 24px gutter and the 32px toast moved every
 * overlay at once, so the baseline is now this change's tree, captured on macOS with
 * `npm run test:browser:capture` and classified under forced faces (Verdana, Georgia,
 * Courier New): every axis that stayed exact here is unchanged under all three, and every
 * axis that moved is already in TEXT_SIZED. Which axes are soft did not change. The CI
 * runner's capture of these values is PENDING (it needs a push): until it is read, the
 * tolerances below carry the cross-platform spreads measured on 2026-09-18.
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
import { SURFACES, boxOf, harnessUrl, type Surface } from './overlays';

type Axis = 'x' | 'y' | 'w' | 'h';
const AXES: readonly Axis[] = ['x', 'y', 'w', 'h'];

/** Axes each surface sizes from its own TEXT, measured rather than guessed: the matrix was
 * re-run with a different face forced on every element from page load, under two faces, and
 * the boxes diffed. Anything absent here is CSS-pinned and stays an exact assertion. */
const TEXT_SIZED: Record<string, readonly Axis[]> = {
  drawer: [], // fixed width, full viewport height
  // split-auto-routing-readout-setup D8: the tuning drawers ARE the Inspector's `.drawer`
  // (same class, same `useModalSurface` wiring), so the same box: fixed width, full height.
  'drawer:selfCalibration': [],
  'drawer:semanticLearning': [],
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
  'confirm:cancelBatch': ['h'],
  // The shared destructive confirmation (adopt-red-destructive-actions task 6.1) sits on the
  // same `.confirm-card`, which shrinks to its content up to 440px. Its one-line title and
  // one-line body never reach 440 at desktop, so the WIDTH is text-sized and `x` follows it
  // (the card is centred): Geist 327, Verdana 346, Georgia 308, Courier New 385. `y` and `h`
  // did not move under any forced face (270 and 122: nothing wraps), so both stay exact.
  'confirm:destructive': ['x', 'w'],
  accountMenu: ['y', 'h'], // bottom-anchored, so `y` follows `h`
  // Anchored to a control, so `y` tracks the text layout of the page above it, not just
  // the picker's own content.
  picker: ['y', 'h'],
  // Shrink-wrapped around one sentence, so `x` and `w` move. `y` and `h` do NOT: the runner
  // printed `[442, 843, 557, 35]` against macOS's `[454, 843, 533, 35]`, so both were
  // runner-confirmed and identical. Since adopt-design-tokens-v2 the bar is the height
  // family's 32px, 24px from the bottom (`toast-offset`): both are declared, and identical
  // under every forced face (2026-11-02); the runner's re-confirmation is pending.
  toast: ['x', 'w'],
};

/** DEFAULT allowances — now ONLY for a surface added after 2026-09-18.
 *
 * These were sized against forced fallback-face swaps (Verdana, Georgia) — an accurate
 * measurement of a mechanism that does not occur, since Geist always loads. Until 2026-09-18
 * nine surfaces relied on them and CI had never disclosed their values, and a pass inside a
 * 40px window is not a measurement.
 *
 * `geometryCapture.spec.ts` closed that gap: it runs in CI, logs every surface on every run,
 * and on 2026-09-18 captured all thirteen on macOS and ubuntu-latest. Every current surface now
 * has a MEASURED entry below, so nothing in the matrix reads these any more. They stay as the
 * allowance for a surface added in future, which the capture will measure on its first push.
 *
 * What the 40px was hiding, recorded so the width of a default is never mistaken for safety:
 * three modals had grown 27–31px in `e8f0c66` (the batch epic) and passed silently. */
const LINE_SLACK = 40;
const WIDTH_SLACK = 0.15;

/** MEASURED allowances, overriding the defaults for the axes whose cross-platform spread is
 * actually known. An override table rather than narrower defaults: this leaves every unmeasured
 * surface untouched *by construction*, instead of by a refactor that has to be audited.
 *
 * Both entries are bounded by the runner's own printed numbers, not by inference — CI's
 * `toEqual` diff prints the full received box, with the unchanged elements as context. */
const MEASURED_SLACK: Record<string, Partial<Record<Axis, number>>> = {
  // ZERO cross-platform spread, captured 2026-09-18: byte-identical on macOS and ubuntu-latest
  // (HeadlessChrome 151). Same convention as the two entries below — observed spread plus 8px
  // for an environment this has not seen — which here is 0 + 8. `y` follows `h` on a centred
  // modal, so both axes carry the same bound.
  //
  // Why a narrow tolerance rather than a structural bound on these: the capture proved the
  // tolerance catches what a bound admits. The provider modal grew 31px and still fitted a
  // 900px viewport, so "on screen" and "within the viewport" both passed it; an 8px window does
  // not. Where the spread is zero the window is symmetric, so the asymmetry that makes wide
  // tolerances dangerous cannot arise.
  //
  // Re-capture after 2026-10-19, when ubuntu-latest moves to Ubuntu 26: an OS image change is
  // exactly what can move text layout, and the 8px margin is the only headroom for it.
  'modal:newAgent': { y: 8, h: 8 },
  'modal:newProvider': { y: 8, h: 8 },
  'modal:editProvider': { y: 8, h: 8 },
  'modal:newLimit': { y: 8, h: 8 },
  'modal:channel': { y: 8, h: 8 },
  'modal:keyReveal': { y: 8, h: 8 },
  'confirm:disableCapture': { h: 8 },
  accountMenu: { y: 8, h: 8 },
  picker: { y: 8, h: 8 },
  toast: {
    // macOS 533, Ubuntu 24.04 and the CI runner both 557 → spread 24px. 32 leaves 8px for an
    // environment this has not seen. Carried to the 2026-11-02 re-pin (macOS 549): same copy,
    // so the same spread is expected, pending the runner's capture.
    w: 32,
    // The box recentres as the width changes, so `x` moves by exactly half the width spread:
    // 454 → 442. 16px, same 8px margin. The centre assertion below pins it further.
    x: 16,
  },
  'confirm:bodyCapture': {
    // macOS 160, runner 178 → 18px, one wrapped line of copy. 26 leaves the same 8px.
    // Carried to the 2026-11-02 re-pin (macOS 154; one more line under Verdana is 170).
    h: 26,
  },
};

/** [x, y, width, height] at 1440x900, except the nav which exists as an overlay only
 * below the threshold and is therefore pinned at 390x844.
 *
 * RE-PINNED 2026-11-02 (adopt-design-tokens-v2 task 14.3) wherever the recorded change moved
 * a box; the drawers and the nav did not move. Each re-pinned entry keeps its earlier value
 * beside it, so the move is reviewable. macOS capture: `notes/lane-g9-capture-macos-*.txt`
 * in that change. */
const BASELINE: Record<string, [number, number, number, number]> = {
  drawer: [1000, 0, 440, 900],
  // ADDED 2026-11-01 (split-auto-routing-readout-setup task 3.3). Not a pre-change capture:
  // these surfaces did not exist before the change. They reuse the `.drawer` box above, and
  // the pin is that box — fixed width, right-anchored, full viewport height, every axis
  // CSS-pinned — so a tuning drawer that drifts from the Inspector's geometry fails here.
  'drawer:selfCalibration': [1000, 0, 440, 900],
  'drawer:semanticLearning': [1000, 0, 440, 900],
  // RE-PINNED 2026-11-02 (was [480, 324, 480, 252]), and every modal below it: the recorded
  // change's height family, type scale, spacing and field help/message slots (tasks 2–4, 8).
  'modal:newAgent': [480, 323, 480, 254],
  // RE-PINNED 2026-09-18 (was [480, 98, 480, 705]). `e8f0c66`, the batch epic, added fields to
  // the provider form — a deliberate feature change, not rendering drift. The new value is
  // byte-identical on macOS and ubuntu-latest, so re-pinning restores a regression guard; it
  // does not re-create the v0.12.0 failure, which came from pinning a value the two platforms
  // disagreed on.
  // RE-PINNED 2026-11-02 (was [480, 82, 480, 736]): 10px taller.
  'modal:newProvider': [480, 77, 480, 746],
  'modal:editProvider': [480, 77, 480, 746],
  // RE-PINNED 2026-11-02 (was [480, 174, 480, 552]).
  'modal:newLimit': [480, 170, 480, 561],
  // RE-PINNED 2026-09-18 (was [480, 166, 480, 568]), same cause and same evidence as above.
  // RE-PINNED 2026-11-02 (was [480, 153, 480, 595]): 20px taller.
  'modal:channel': [480, 143, 480, 615],
  // RE-PINNED 2026-11-02 (was [480, 341, 480, 219]).
  'modal:keyReveal': [480, 336, 480, 228],
  // RE-PINNED 2026-11-02 (was [500, 270, 440, 160] and [500, 270, 440, 141]): x, y and the
  // width did not move; only the text-sized height did (6px and 3px shorter).
  'confirm:bodyCapture': [500, 270, 440, 154],
  'confirm:disableCapture': [500, 270, 440, 138],
  // ADDED 2026-11-02 (adopt-design-tokens-v2 review fix): the Batches cancel dialog joined the
  // matrix so the height-family and Indigo Budget sweeps open it. Not a pre-change capture: the
  // macOS `@capture` value on this change's tree. The same `.confirm-card` box as the two
  // confirms above (x, y and the width CSS-pinned); its height is its copy's, so it takes the
  // unmeasured default until the runner's capture on the first push.
  'confirm:cancelBatch': [500, 270, 440, 154],
  // ADDED 2026-11-03 (adopt-red-destructive-actions task 6.1): the shared destructive
  // confirmation, opened from the harness's first agent's Delete (`Delete agent
  // "claude-code-production-worker"?`). Not a pre-change capture: the surface is new. The macOS
  // `@capture` value on this change's tree (HeadlessChrome 151), classified under forced faces
  // (Verdana, Georgia, Courier New; the change's `notes/lane-d-faces/`): `y` 270 and `h` 122
  // are identical under every face and stay exact; `x` and the width are the shrink-wrapped
  // title's. Those two take the default allowance for a surface added after 2026-09-18 until
  // the runner's capture on the first push (`geometryCapture.spec.ts` prints it); then size
  // them in MEASURED_SLACK from both platforms' values. The centre stays exact either way.
  'confirm:destructive': [557, 270, 327, 122],
  'nav:expanded': [0, 0, 208, 844],
  // RE-PINNED 2026-11-02 (was [18, 661, 171, 139]): the menu spans the sidebar footer's
  // content box (`left: 0; right: 0`), which the spacing sweep moved to x 16 and 175px wide.
  // x and the width stay exact: unchanged under every forced face.
  accountMenu: [16, 664, 175, 138],
  // RE-PINNED 2026-10-30 (was [253, 266, 320, 76]). redesign-auto-routing-pipeline put the
  // page-level tab control (a 30px `Segmented` plus the page's 14px gap) above the tier
  // chains (D1/D3), so the first chain's input — the picker's anchor — sits exactly 44px
  // lower. A deliberate layout change, not rendering drift: x, width and height are
  // unchanged, and the shift is the control's box, not text.
  // RE-PINNED 2026-11-02 (was [253, 310, 320, 76]): the recorded change moves its anchor
  // 4px left and 17px down, and the picker is 7px taller. x and the width stay exact:
  // unchanged under every forced face.
  picker: [249, 327, 320, 83],
  // RE-PINNED 2026-11-02 (was [454, 843, 533, 35]): the 32px bar 24px from the bottom
  // (`toast-offset`, the height family); the shrink-wrapped width is 16px wider and
  // re-centred.
  toast: [446, 844, 549, 32],
};

/** Opens the harness — on the query a surface needs, when it needs one. */
async function open(page: Page, surface: Pick<Surface, 'query'> = {}): Promise<void> {
  await page.goto(harnessUrl(surface));
  await page.waitForSelector('html[data-harness-ready="true"]');
  await page.waitForSelector('[data-pane="sidebar"]');
}

for (const s of SURFACES) {
  const vp = s.narrowOnly ? { width: 390, height: 844 } : { width: 1440, height: 900 };
  test.describe(`${s.name} keeps its recorded geometry @${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp });

    test('unchanged', async ({ page }) => {
      await open(page, s);
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
