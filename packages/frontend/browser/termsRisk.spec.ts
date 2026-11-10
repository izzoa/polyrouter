/** The Terms-risk notice's dismiss, laid out in a real browser (add-dismissible-terms-risk tasks
 * 3.1 and 4.4; dashboard-core "Notices share one anatomy and four tones" and "A subscription
 * provider's Terms-risk notice can be dismissed once per provider").
 *
 * happy-dom performs no layout, so `notices.view.test.tsx` can only prove the stylesheet's
 * arithmetic. Here it is measured at 1440x900, 390x844 and 320x568 on the `?usage=1` fixture,
 * whose subscription cards carry the notice (two to a row below `narrow`, about 110-150px wide):
 * the `×` sits inside the notice at its top-right, the title, body and action never sit under
 * it, the body keeps the notice's full width, it is 24px at desktop and the 44px comfort target
 * below `narrow`, and nothing makes the page scroll sideways.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900, size: 24 },
  { name: '390x844', width: 390, height: 844, size: 44 },
  { name: '320x568', width: 320, height: 568, size: 44 },
] as const;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
async function boxOf(l: Locator): Promise<Box> {
  const b = await l.boundingBox();
  expect(b, 'the element has a box').not.toBeNull();
  return b!;
}
const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width - 0.5 &&
  b.x < a.x + a.width - 0.5 &&
  a.y < b.y + b.height - 0.5 &&
  b.y < a.y + a.height - 0.5;

async function open(page: Page): Promise<void> {
  await page.goto('/browser-harness.html?usage=1#/providers');
  await page.waitForSelector('html[data-harness-ready="true"]');
  await page.waitForSelector('.notice-dismiss');
}

for (const vp of VIEWPORTS) {
  test(`the dismiss sits in the notice's corner, clear of its text, at ${vp.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await open(page);
    const notices = page.locator('.notice.notice--dismissible');
    const count = await notices.count();
    expect(count, 'the fixture shows dismissible notices').toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      const n = notices.nth(i);
      await n.scrollIntoViewIfNeeded();
      await expect(n.locator('.notice-title')).toHaveText('Terms risk');
      const box = await boxOf(n);
      const x = await boxOf(n.locator('.notice-dismiss'));
      // Inside the notice, in its top-right corner.
      expect(x.x + x.width, 'right edge inside').toBeLessThanOrEqual(box.x + box.width + 0.5);
      expect(x.y, 'top edge inside').toBeGreaterThanOrEqual(box.y - 0.5);
      expect(box.x + box.width - (x.x + x.width), 'at the right').toBeLessThanOrEqual(12);
      expect(x.y - box.y, 'at the top').toBeLessThanOrEqual(12);
      // The small family member at desktop, the comfort target below narrow, in both axes.
      expect(Math.round(x.width)).toBe(vp.size);
      expect(Math.round(x.height)).toBe(vp.size);
      // Nothing the notice says, and not its action, sits under the ×.
      for (const part of ['.notice-title', '.notice-body', '.notice-action']) {
        const b = await boxOf(n.locator(part));
        expect(overlaps(b, x), `${part} under the dismiss`).toBe(false);
      }
      // The body is not narrowed by the ×: it spans the notice's content width (12px padding).
      const body = await boxOf(n.locator('.notice-body'));
      expect(body.width, 'the body keeps the full width').toBeGreaterThanOrEqual(
        box.width - 24 - 1,
      );
    }
    const o = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(o.scrollWidth, 'the page scrolls sideways').toBeLessThanOrEqual(o.clientWidth);
  });
}

test('the dismiss takes the shared focus ring', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const x = page.locator('.notice-dismiss').first();
  await x.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(x).toBeFocused();
  const outline = await x.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
  });
  expect(outline.style).not.toBe('none');
  expect(outline.width).toBeGreaterThan(0);
});

/** The `×` is a non-text control: WCAG 1.4.11 asks 3:1 against the amber wash it sits on, in
 * both themes (design Risks: Ink 3 at rest, Ink 2 if Ink 3 falls short). Colours are resolved
 * through a canvas so any colour syntax the tokens use reads as sRGB. */
for (const theme of ['light', 'dark'] as const) {
  test(`the dismiss meets 3:1 against the caution wash in the ${theme} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    await page.evaluate((t) => {
      const s = (
        globalThis as unknown as {
          __harnessStore: { state: { theme: string }; toggleTheme: () => void };
        }
      ).__harnessStore;
      if (s.state.theme !== t) s.toggleTheme();
    }, theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const ratio = await page
      .locator('.notice-dismiss')
      .first()
      .evaluate((el) => {
        const rgb = (css: string): [number, number, number] => {
          const c = document.createElement('canvas');
          c.width = 1;
          c.height = 1;
          const g = c.getContext('2d')!;
          g.fillStyle = css;
          g.fillRect(0, 0, 1, 1);
          const d = g.getImageData(0, 0, 1, 1).data;
          return [d[0]!, d[1]!, d[2]!];
        };
        const lum = ([r, g, b]: [number, number, number]): number => {
          const f = (v: number): number => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const fg = lum(rgb(getComputedStyle(el).color));
        const bg = lum(rgb(getComputedStyle(el.closest('.notice')!).backgroundColor));
        return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      });
    expect(ratio, `${theme}: the × against the wash`).toBeGreaterThanOrEqual(3);
  });
}
