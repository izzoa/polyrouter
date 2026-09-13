/**
 * The browser suite's geometry contract (assert-browser-geometry-structurally).
 *
 * This file INVENTS NOTHING. It lifts the rule `overlayBaseline.spec.ts` already
 * follows out of that one file so the rest of the suite can follow it too, and
 * so the next person adding a geometric assertion has somewhere to look before
 * choosing between an exact number and a bound.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 *
 * Rendered geometry is not a property of the code alone. It is a property of the
 * code AND the machine that rendered it. Developers run macOS; CI runs
 * `ubuntu-latest`. Fonts are not the variable — Geist is vendored, linked from
 * both entry points, and `browserHarness.tsx` gates readiness on
 * `document.fonts.ready`, so every measurement is taken with the real font
 * loaded. The SAME loaded font still produces platform-dependent TEXT LAYOUT.
 *
 * So every geometric assertion is one of two kinds, and must know which:
 *
 *   EXACT       — the stylesheet and layout engine decide it alone. Viewport
 *                 anchoring, fixed widths, centre position, layer order, fixed
 *                 sizes. These are byte-identical across platforms and are the
 *                 coverage that catches a real regression. Do not soften them.
 *
 *   STRUCTURAL  — text layout decides it. Wrap-driven heights, shrink-wrapped
 *                 widths, line counts. Assert RELATIONSHIPS and BOUNDS: present,
 *                 on screen, inside its parent, above a target floor, under a
 *                 ceiling, ordered, scrollable when it overflows. Never a pixel.
 *
 * ── HOW TO CLASSIFY ──────────────────────────────────────────────────────────
 *
 * `overlayBaseline.spec.ts` classified its surfaces by MEASUREMENT, not
 * intuition: it re-ran the matrix with a different face forced on every element
 * from page load, under two faces, and diffed the boxes. Whatever moved is
 * text-sized; whatever did not is CSS-pinned. Copy that method rather than
 * guessing — a guess here is how an exact assertion ends up on a soft axis and
 * fails CI for a change that was correct.
 *
 * ── ON TOLERANCES ────────────────────────────────────────────────────────────
 *
 * `overlayBaseline.spec.ts` resolves its soft axes with slack around a pinned
 * number rather than a structural bound. That is a deliberate trade, not an
 * oversight: its `MEASURED_SLACK` values are the observed cross-platform spread
 * plus a documented 8px margin, bounded by the runner's own printed numbers, and
 * they buy a CEILING on axes that would otherwise have none.
 *
 * The cost is real and worth stating: the allowance is asymmetric. On
 * `confirm:bodyCapture` a developer on macOS has 26px of room while CI has
 * roughly 8px left, so a change authored and passing locally can fail CI for no
 * reason visible on the developer's machine. Prefer a structural bound for NEW
 * soft-axis assertions; leave the existing measured slack alone unless the
 * capture run gives a reason to change it.
 *
 * Its DEFAULT allowances (`LINE_SLACK`, `WIDTH_SLACK`) are a different thing
 * again — an explicitly recorded gap. Eleven surfaces pass inside them and have
 * never been measured on Linux, and the file is emphatic that **a pass is not a
 * measurement**. Narrowing them without the capture run would be inference.
 */
import { expect, type Page } from '@playwright/test';

/** Which kind an assertion is. Naming it at the call site is the point: a test
 * that cannot say which kind it is does not know what it is protecting. */
export type AssertionKind = 'exact' | 'structural';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Read one element's rect, or null when it is absent. */
export async function rectOf(page: Page, sel: string): Promise<Rect | null> {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, sel);
}

/** STRUCTURAL: the element is rendered and has non-zero area. The floor under
 * every other structural check — an element with zero size satisfies "inside its
 * parent" and "under its ceiling" vacuously. */
export async function assertVisible(page: Page, sel: string, label = sel): Promise<Rect> {
  const r = await rectOf(page, sel);
  expect(r, `${label} is not in the DOM`).not.toBeNull();
  expect(r!.width > 0 && r!.height > 0, `${label} has zero area (${r!.width}x${r!.height})`).toBe(
    true,
  );
  return r!;
}

/** STRUCTURAL: the element lies within the viewport, with a small tolerance for
 * sub-pixel rounding. Catches the categorical failure this suite exists for — a
 * surface that escapes the screen — on any rasteriser. */
export async function assertOnScreen(page: Page, sel: string, label = sel): Promise<void> {
  const r = await assertVisible(page, sel, label);
  const vp = page.viewportSize();
  expect(vp, 'no viewport size').not.toBeNull();
  const slack = 1;
  expect(
    r.x >= -slack &&
      r.y >= -slack &&
      r.x + r.width <= vp!.width + slack &&
      r.y + r.height <= vp!.height + slack,
    `${label} is off screen at ${JSON.stringify(r)} in ${vp!.width}x${vp!.height}`,
  ).toBe(true);
}

/** STRUCTURAL: the child is contained by the parent. Independent of both boxes'
 * absolute sizes, so it holds wherever text layout puts them. */
export async function assertWithin(
  page: Page,
  childSel: string,
  parentSel: string,
  label = `${childSel} within ${parentSel}`,
): Promise<void> {
  const c = await assertVisible(page, childSel, childSel);
  const p = await assertVisible(page, parentSel, parentSel);
  const slack = 1;
  expect(
    c.x >= p.x - slack &&
      c.y >= p.y - slack &&
      c.x + c.width <= p.x + p.width + slack &&
      c.y + c.height <= p.y + p.height + slack,
    `${label}: child ${JSON.stringify(c)} escapes parent ${JSON.stringify(p)}`,
  ).toBe(true);
}

/** STRUCTURAL: a dimension sits inside [min, max].
 *
 * A CEILING is the half most easily forgotten, and forgetting it is a live bug
 * in this suite: `.endpoint-chip` kept its 24px floor when it left the exact
 * parity set, so a height blow-out now passes silently. Both bounds or neither. */
export function assertBetween(
  actual: number,
  min: number,
  max: number,
  label: string,
): void {
  expect(
    actual >= min && actual <= max,
    `${label} is ${actual}, outside [${min}, ${max}]`,
  ).toBe(true);
}

/** STRUCTURAL: every matching element clears a minimum size on both axes. */
export async function assertTargetFloor(
  page: Page,
  sel: string,
  floor: number,
  label = sel,
): Promise<void> {
  const small = await page.evaluate(
    ({ s, f }) =>
      [...document.querySelectorAll(s)]
        .map((e) => e.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
        .filter((r) => r.width < f || r.height < f)
        .map((r) => `${Math.round(r.width)}x${Math.round(r.height)}`),
    { s: sel, f: floor },
  );
  expect(small, `${label} below the ${String(floor)}px floor`).toEqual([]);
}

/** STRUCTURAL: content that overflows its box has a way to be scrolled.
 * Overflowing is legitimate; overflowing with no scroller is a trap, and it is
 * the same categorical class as escaping the viewport. */
export async function assertScrollableIfOverflowing(
  page: Page,
  sel: string,
  label = sel,
): Promise<void> {
  const state = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const style = getComputedStyle(el);
    return {
      overflows: el.scrollHeight > el.clientHeight + 1,
      scrollable: /auto|scroll/.test(`${style.overflowY} ${style.overflow}`),
    };
  }, sel);
  expect(state, `${label} is not in the DOM`).not.toBeNull();
  if (!state!.overflows) return;
  expect(state!.scrollable, `${label} overflows with no way to scroll it`).toBe(true);
}

/** STRUCTURAL: elements appear in the given document order. Ordering is a
 * relationship, so it survives any amount of text-layout variation. */
export async function assertOrder(page: Page, sels: readonly string[]): Promise<void> {
  const ys = await Promise.all(sels.map((s) => rectOf(page, s)));
  ys.forEach((r, i) => expect(r, `${sels[i]!} is not in the DOM`).not.toBeNull());
  for (let i = 1; i < ys.length; i += 1) {
    expect(
      ys[i]!.y >= ys[i - 1]!.y - 1,
      `${sels[i]!} (y=${ys[i]!.y}) is above ${sels[i - 1]!} (y=${ys[i - 1]!.y})`,
    ).toBe(true);
  }
}
