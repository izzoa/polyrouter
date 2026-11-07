/** The plan-usage line and Refresh usage, laid out in a real browser (add-subscription-quota-display
 * task 7.4; dashboard-core "A subscription provider card states its plan usage in one neutral
 * line" and "Refresh usage is offered where a usage endpoint exists").
 *
 * The view suites (`src/Providers.planUsage*.view.test.tsx`) prove the text, the roles and the
 * timers, but happy-dom performs no layout, so whether the line wraps inside its card, whether the
 * button falls under it at a phone's width, and whether anything makes the page scroll sideways is
 * measured here at 1440x900, 390x844 and 320x568. The fixture (`?usage=1`) is adversarial: a
 * Claude line of five windows, a scoped one, the billing phrase and a 26-character bucket name;
 * a Kimi Code plan with an unlabelled window; and a card whose refresh is cooling down.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '390x844', width: 390, height: 844 },
  { name: '320x568', width: 320, height: 568 },
] as const;

async function open(page: Page): Promise<void> {
  await page.goto('/browser-harness.html?usage=1#/providers');
  await page.waitForSelector('html[data-harness-ready="true"]');
  await page.waitForSelector('[data-usage-line]');
}

const card = (page: Page, name: string): Locator =>
  page.locator('.panel.card').filter({ hasText: name });

async function noSidewaysScroll(page: Page, what: string): Promise<void> {
  const o = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(o.scrollWidth, `${what}: the page scrolls sideways`).toBeLessThanOrEqual(o.clientWidth);
}

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
/** `inner` lies inside `outer`, to half a pixel. */
function within(inner: Box, outer: Box, what: string): void {
  expect(inner.x, `${what}: left edge`).toBeGreaterThanOrEqual(outer.x - 0.5);
  expect(inner.x + inner.width, `${what}: right edge`).toBeLessThanOrEqual(
    outer.x + outer.width + 0.5,
  );
}
function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width - 0.5 &&
    b.x < a.x + a.width - 0.5 &&
    a.y < b.y + b.height - 0.5 &&
    b.y < a.y + a.height - 0.5
  );
}

for (const vp of VIEWPORTS) {
  test.describe(`at ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('the usage line stays inside its card and the page never scrolls sideways', async ({
      page,
    }) => {
      await open(page);
      await noSidewaysScroll(page, 'the providers page');
      for (const name of ['Claude Max', 'Kimi Code', 'Z.ai GLM Coding Plan']) {
        const c = card(page, name);
        const cardBox = await boxOf(c);
        within(await boxOf(c.locator('[data-usage-line]')), cardBox, `${name} usage line`);
        within(await boxOf(c.locator('[data-usage]')), cardBox, `${name} usage row`);
      }
    });

    test('an open model-limits disclosure stays inside the card', async ({ page }) => {
      await open(page);
      const c = card(page, 'Claude Max');
      await c.locator('details[data-usage-buckets] > summary').click();
      await expect(c.locator('details[data-usage-buckets]')).toHaveJSProperty('open', true);
      within(await boxOf(c.locator('details[data-usage-buckets]')), await boxOf(c), 'the list');
      await noSidewaysScroll(page, 'the open disclosure');
    });

    test('Refresh usage is a 24px ghost button that never overlaps the line', async ({ page }) => {
      await open(page);
      const c = card(page, 'Kimi Code');
      const button = c.locator('[data-usage] button');
      await expect(button).toHaveText(/Refresh usage/);
      const b = await boxOf(button);
      expect(b.height, 'the ghost button box').toBeGreaterThanOrEqual(24);
      within(b, await boxOf(c), 'the button');
      expect(overlaps(b, await boxOf(c.locator('[data-usage-line]'))), 'button over the line').toBe(
        false,
      );
    });

    test('a refresh states its cooldown beside the button without overflow', async ({ page }) => {
      await open(page);
      const c = card(page, 'Kimi Code');
      await c.locator('[data-usage] button').click();
      await expect(c.locator('[data-usage-refresh-status]')).toHaveText(/^Usage refreshed/);
      await expect(c.locator('[data-usage] button')).toBeDisabled();
      await expect(c.locator('[data-usage]')).toContainText('next refresh');
      // Focus went to the outcome text, not the page.
      await expect(c.locator('[data-usage-refresh-status]')).toBeFocused();
      within(await boxOf(c.locator('[data-usage]')), await boxOf(c), 'the refresh row');
      await noSidewaysScroll(page, 'after a refresh');
    });

    test('a cooling card shows its availability text and a disabled button', async ({ page }) => {
      await open(page);
      const c = card(page, 'Z.ai GLM Coding Plan');
      await expect(c.locator('[data-usage] button')).toBeDisabled();
      await expect(c.locator('[data-usage]')).toContainText('next refresh');
      within(await boxOf(c.locator('[data-usage]')), await boxOf(c), 'the cooling row');
      await noSidewaysScroll(page, 'a cooling card');
    });
  });
}
