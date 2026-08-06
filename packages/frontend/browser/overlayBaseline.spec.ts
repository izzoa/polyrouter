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
 */
import { expect, test, type Page } from '@playwright/test';
import { SURFACES, boxOf } from './overlays';

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
      expect(await boxOf(page, s.sel), `${s.name} moved or resized`).toEqual(expected);
    });
  });
}

test('every surface in the matrix has a pinned baseline', () => {
  // Guards the enumeration itself: adding a surface without pinning it would otherwise
  // leave it silently unverified, which is exactly how the overlays escaped phase 1.
  expect(SURFACES.map((s) => s.name).filter((n) => !(n in BASELINE))).toEqual([]);
});
