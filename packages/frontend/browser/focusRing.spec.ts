/** The focus ring's geometry, measured (adopt-design-tokens-v2 task 6.3; design.md D8;
 * dashboard-core "The focus ring never merges with a filled control").
 *
 * One ring — 2px of the accent, drawn as an outline, never as a box-shadow — in three places:
 *
 * - outside a FILLED control (the primary, rested and hovered; an on and an off switch; a
 *   selected segment) with at least 2px of offset, so the ring only touches surface colours;
 * - inset (−2px) on a FLUSH row (a request row, and a selected one, where the ring replaces
 *   the 1px selected outline);
 * - never cut off by a clipping ancestor: every control in a tier card, whose panel is
 *   `overflow: hidden`, keeps its whole ring inside the clip.
 *
 * "Inside the clip" is measured, not inferred: the ring's outer box is the element's border
 * box grown by `outline-offset + outline-width` (an inset ring stays inside the element), and
 * it must lie within the padding box of EVERY ancestor whose overflow is not `visible` — the
 * box an overflow clip cuts at. Each control is focused from the keyboard path, and the spec
 * asserts `:focus-visible` actually matched, so a ring that never showed cannot pass.
 *
 * Offsets and the ring's width are lock values (CSS literals), not text layout, so they are
 * asserted EXACT; the containment check is a structural bound with half a pixel of float
 * slack (ci-pipeline "Browser geometry assertions are typed").
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

/** `#4f5dff`, the same in both themes. */
const ACCENT = 'rgb(79, 93, 255)';
/** Float noise allowed on the containment bound, in px. */
const SLACK = 0.5;

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForSelector('html[data-harness-ready="true"]');
  await page.waitForSelector('[data-pane="sidebar"]');
}

async function store(page: Page, fn: string, ...args: unknown[]): Promise<void> {
  await page.evaluate(
    ([f, a]) => {
      const s = (globalThis as unknown as { __harnessStore?: Record<string, unknown> })
        .__harnessStore;
      if (!s) throw new Error('harness store missing');
      const call = s[f];
      if (typeof call !== 'function') throw new Error(`store.${f} is not a function`);
      (call as (...p: unknown[]) => unknown)(...a);
    },
    [fn, args] as [string, unknown[]],
  );
  await page.waitForTimeout(60);
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((t) => {
    const s = (
      globalThis as unknown as {
        __harnessStore: { state: { theme: string }; toggleTheme: () => void };
      }
    ).__harnessStore;
    if (s.state.theme !== t) s.toggleTheme();
  }, theme);
  // The app mounts in the system preference (adopt-design-tokens-v2 D9), and Playwright's is
  // light; the attribute is set on mount, so `?? 'light'` only covers a document read early.
  const attr = await page.evaluate(() => document.documentElement.dataset['theme'] ?? 'light');
  expect(attr, 'the document is in the theme under test').toBe(theme);
}

interface Ring {
  focusVisible: boolean;
  style: string;
  width: number;
  offset: number;
  color: string;
  shadow: string;
  /** Every clipping ancestor the ring's outer box escapes, by how much. */
  clipped: string[];
  /** How many clipping ancestors were checked. */
  clips: number;
}

/** Focuses `target` along the keyboard path and reads its ring. A programmatic focus counts as
 * keyboard modality until the pointer clicks; if it did not match `:focus-visible`, focus is
 * moved off and back with the keyboard. */
async function ringOf(page: Page, target: Locator): Promise<Ring> {
  await target.scrollIntoViewIfNeeded();
  await target.focus();
  if (!(await target.evaluate((el) => el.matches(':focus-visible')))) {
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
  }
  // The reduced-motion block gives EVERY element `transition-duration: 0.01ms` over the
  // initial `transition-property: all`, so the outline transitions from its initial value
  // (3px, offset 0, currentColor) for a moment after focus lands: read it once that is over.
  await page.waitForTimeout(50);
  return target.evaluate((el, slack) => {
    const cs = getComputedStyle(el);
    const width = parseFloat(cs.outlineWidth);
    const offset = parseFloat(cs.outlineOffset);
    const r = el.getBoundingClientRect();
    const grow = Math.max(0, offset + width);
    const ring = { l: r.left - grow, t: r.top - grow, r: r.right + grow, b: r.bottom + grow };
    const clipped: string[] = [];
    let clips = 0;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const acs = getComputedStyle(a);
      if (acs.overflowX === 'visible' && acs.overflowY === 'visible') continue;
      clips += 1;
      const ar = a.getBoundingClientRect();
      const box = {
        l: ar.left + a.clientLeft,
        t: ar.top + a.clientTop,
        r: ar.left + a.clientLeft + a.clientWidth,
        b: ar.top + a.clientTop + a.clientHeight,
      };
      const out = [
        ['left', box.l - ring.l],
        ['top', box.t - ring.t],
        ['right', ring.r - box.r],
        ['bottom', ring.b - box.b],
      ].filter(([, d]) => (d as number) > slack);
      if (out.length > 0) {
        const cls = (a.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean);
        const who = `${a.tagName.toLowerCase()}${cls.length ? '.' + cls.join('.') : ''}`;
        clipped.push(
          `${who} (overflow ${acs.overflowX}/${acs.overflowY}) cuts ${out
            .map(([side, d]) => `${String(side)} by ${(d as number).toFixed(2)}px`)
            .join(', ')}`,
        );
      }
    }
    return {
      focusVisible: el.matches(':focus-visible'),
      style: cs.outlineStyle,
      width,
      offset,
      color: cs.outlineColor,
      shadow: cs.boxShadow,
      clipped,
      clips,
    };
  }, SLACK);
}

/** The ring every control shares: visible, 2px solid accent, never a shadow, never clipped. */
function expectTheRing(ring: Ring, what: string): void {
  expect(ring.focusVisible, `${what}: :focus-visible matched`).toBe(true);
  expect(ring.style, `${what}: outline style`).toBe('solid');
  expect(ring.width, `${what}: outline width`).toBe(2);
  expect(ring.color, `${what}: outline colour`).toBe(ACCENT);
  expect(ring.shadow, `${what}: no box-shadow ring`).toBe('none');
  expect(ring.clipped, `${what}: the ring is cut off`).toEqual([]);
}

/** A filled control: the ring stands at least 2px off the fill. */
function expectOutside(ring: Ring, what: string): void {
  expectTheRing(ring, what);
  expect(ring.offset, `${what}: outline-offset`).toBeGreaterThanOrEqual(2);
}

/** A flush row: the ring is drawn inset, on the row's own fill. */
function expectInset(ring: Ring, what: string): void {
  expectTheRing(ring, what);
  expect(ring.offset, `${what}: outline-offset`).toBe(-2);
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`the focus ring never merges with a filled control (${theme}, 1440x900)`, () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('the primary button, at rest and hovered', async ({ page }) => {
      await open(page, '/browser-harness.html#/agents');
      await setTheme(page, theme);
      const primary = page.locator('main .btn-primary, [data-pane="main"] .btn-primary').first();
      await expect(primary).toBeVisible();
      expectOutside(await ringOf(page, primary), 'the primary button at rest');
      await primary.hover();
      const hovered = await ringOf(page, primary);
      // The hover fill is what the ring stands off; prove the hover really applied.
      expect(
        await primary.evaluate((el) => getComputedStyle(el).backgroundColor),
        'the primary is showing its hover fill',
      ).not.toBe(ACCENT);
      expectOutside(hovered, 'the primary button hovered');
    });

    test('an on and an off switch', async ({ page }) => {
      await open(page, '/browser-harness.html#/routing');
      await setTheme(page, theme);
      await store(page, 'setRoutingSection', 'auto');
      await page.waitForSelector('[data-testid="pipeline-stage"]');
      for (const on of ['true', 'false']) {
        const sw = page.locator(`[role="switch"][aria-checked="${on}"]:visible`).first();
        await expect(sw, `an ${on === 'true' ? 'on' : 'off'} switch is on screen`).toBeVisible();
        expectOutside(await ringOf(page, sw), `a switch with aria-checked=${on}`);
      }
    });

    test('a selected segment', async ({ page }) => {
      await open(page, '/browser-harness.html#/overview');
      await setTheme(page, theme);
      const seg = page.locator('.seg-track .rs-seg[aria-pressed="true"]').first();
      expectOutside(await ringOf(page, seg), 'the selected range segment');
    });

    test('a request row, and a selected one, draw the ring inset', async ({ page }) => {
      await open(page, '/browser-harness.html#/requests');
      await setTheme(page, theme);
      const row = page.locator('.rs-table-requests button.req-row').first();
      expectInset(await ringOf(page, row), 'a request row');
      // The selected row, its state set by hand: the cascade is what is under test here — the
      // focus ring replaces the 1px selected outline — on a row nothing else has touched. The
      // case below opens the inspector for real, which at 1440×900 docks it beside the list
      // (add-docked-inspector) and leaves the row focused; below the dock threshold the
      // modal drawer would make the page inert, so a selected row could not hold focus there.
      const second = page.locator('.rs-table-requests button.req-row').nth(1);
      await second.evaluate((el) => el.setAttribute('aria-expanded', 'true'));
      await page.mouse.move(0, 0);
      await page.waitForTimeout(50); // past the reduced-motion transition (see ringOf)
      const resting = await second.evaluate((el) => {
        const cs = getComputedStyle(el);
        return `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineOffset}`;
      });
      expect(resting, 'the selected row rests on its 1px inset edge').toBe('1px solid -1px');
      expectInset(await ringOf(page, second), 'a selected request row');
    });

    test('docked: clicking a row opens the inspector beside it and leaves the row focused, its ring inset (add-docked-inspector 2.4)', async ({
      page,
    }) => {
      await open(page, '/browser-harness.html#/requests');
      await setTheme(page, theme);
      const row = page.locator('.rs-table-requests button.req-row').nth(1);
      await row.click();
      // Docked, not modal: the same element as a named complementary landmark, no scrim.
      const panel = page.locator('#inspector-drawer.rs-inspector-docked');
      await expect(panel).toHaveAttribute('role', 'complementary');
      expect(await panel.getAttribute('aria-modal'), 'a docked panel claims aria-modal').toBeNull();
      expect(await page.locator('.overlay').count(), 'a scrim over the list').toBe(0);
      expect(
        await row.evaluate((el) => el === document.activeElement),
        'opening the docked panel moved focus off the row',
      ).toBe(true);
      await expect(row).toHaveAttribute('aria-expanded', 'true');
      expectInset(await ringOf(page, row), 'a selected request row beside the docked inspector');
      expect(
        await row.evaluate((el) => el === document.activeElement),
        'the row still holds focus after the keyboard round trip',
      ).toBe(true);
      await expect(row).toHaveAttribute('aria-expanded', 'true');
    });

    test('every control in a tier card keeps its ring inside the clipped panel', async ({
      page,
    }) => {
      // Two fixtures between them reach every kind of tier-card control: `?chain=1` gives the
      // default tier its chain — grips, batch-reservation switches, help triggers, Make
      // primary, the remove ×, the add-model input — and `?targets=1` adds tiers that are not
      // the default, whose heads carry a Delete.
      const kinds = { switch: 0, headDelete: 0, input: 0 };
      for (const query of ['?chain=1', '?targets=1']) {
        await open(page, `/browser-harness.html${query}#/routing`);
        await setTheme(page, theme);
        await store(page, 'setRoutingSection', 'tiers');
        const cards = page.locator('[data-tier-id]');
        expect(await cards.count(), `${query}: tier cards rendered`).toBeGreaterThan(0);
        const controls = cards.locator(
          'button:visible, input:visible, select:visible, [role="switch"]:visible, [tabindex="0"]:visible',
        );
        const n = await controls.count();
        expect(n, `${query}: tier-card controls found`).toBeGreaterThan(3);
        for (let i = 0; i < n; i += 1) {
          const c = controls.nth(i);
          const tag = await c.evaluate((el) => el.tagName.toLowerCase());
          const label =
            (await c.getAttribute('aria-label')) ?? (await c.textContent())?.trim() ?? '';
          const name = `${query} ${tag} "${label.slice(0, 40)}"`;
          const ring = await ringOf(page, c);
          expect(ring.clips, `${name} sits inside the clipped tier card`).toBeGreaterThan(0);
          expectTheRing(ring, `tier-card ${name}`);
          if ((await c.getAttribute('role')) === 'switch') kinds.switch += 1;
          if (label.startsWith('Delete tier')) kinds.headDelete += 1;
          if (tag === 'input') kinds.input += 1;
          // A picker opened by focus must not cover the next control.
          await page.keyboard.press('Escape');
        }
      }
      expect(kinds.switch, 'a switch in a tier card was checked').toBeGreaterThan(0);
      expect(kinds.headDelete, "a tier head's Delete was checked").toBeGreaterThan(0);
      expect(kinds.input, 'an add-model input was checked').toBeGreaterThan(0);
    });
  });
}
