/** A tall dialog keeps every row reachable at desktop width (fix: the Edit provider dialog could
 * not be scrolled).
 *
 * Below `narrow` a modal is a bottom sheet that scrolls itself (`overlaySheets.spec.ts`). At
 * desktop width the card sat in a fixed, centred backdrop with no height limit and no overflow,
 * so a form taller than the window ran off its bottom edge — the Edit provider dialog of a
 * subscription plan (connection summary, timeouts, the two switches) put Save past the bottom of
 * a 1280x720 window, with no scroll anywhere that could reach it. Measured here on the real Edit,
 * opened the way a user does, and on the add-provider form and the subscription picker (Z.ai,
 * its tallest detail).
 */
import { expect, test, type Page } from '@playwright/test';

const SHORT = [
  { width: 1280, height: 720 },
  { width: 1440, height: 760 },
  { width: 1024, height: 640 },
] as const;

async function open(page: Page, query = ''): Promise<void> {
  await page.goto(`/browser-harness.html${query}#/providers`);
  await page.waitForSelector('html[data-harness-ready="true"]');
}

/** Opens the Edit dialog of the first card whose name matches, through its own Edit button. */
async function openEdit(page: Page, name: string): Promise<void> {
  await page
    .locator('.panel.card')
    .filter({ hasText: name })
    .first()
    .locator('button.btn-ghost', { hasText: /^Edit$/ })
    .click();
  await page.waitForSelector('.modal-card');
}

async function storeCall(page: Page, method: string, arg?: unknown): Promise<void> {
  await page.evaluate(
    ([m, a]) => {
      const s = (globalThis as unknown as { __harnessStore: Record<string, (x?: unknown) => void> })
        .__harnessStore;
      s[m as string]!(a);
    },
    [method, arg] as const,
  );
}

/** The card fits the window, and scrolling it to the end brings its last row into view. `last`
 * names that row when it is not the card's last child (the picker's footer band, whose card holds
 * one `.sp` wrapper). */
async function expectReachable(page: Page, what: string, last?: string): Promise<void> {
  await page.waitForTimeout(250);
  const r = await page.evaluate((sel) => {
    const c = document.querySelector<HTMLElement>('.modal-card')!;
    const before = c.getBoundingClientRect();
    c.scrollTop = c.scrollHeight;
    const card = c.getBoundingClientRect();
    const row = (sel === undefined ? c.lastElementChild : c.querySelector(sel))!;
    const lastBox = row.getBoundingClientRect();
    return {
      top: before.top,
      bottom: before.bottom,
      vh: window.innerHeight,
      overflowY: getComputedStyle(c).overflowY,
      overflows: c.scrollHeight > c.clientHeight + 1,
      lastInside: lastBox.bottom <= card.bottom + 1 && lastBox.top >= card.top - 1,
    };
  }, last);
  expect(r.top, `${what}: the card's top is on screen`).toBeGreaterThanOrEqual(0);
  expect(r.bottom, `${what}: the card's bottom is on screen`).toBeLessThanOrEqual(r.vh + 0.5);
  if (r.overflows) expect(r.overflowY, `${what}: the overflow scrolls`).toBe('auto');
  expect(r.lastInside, `${what}: the last row is reachable`).toBe(true);
}

for (const vp of SHORT) {
  test.describe(`dialogs fit ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp });

    test('Edit provider on a subscription plan reaches Save', async ({ page }) => {
      await open(page, '?usage=1');
      await openEdit(page, 'Claude Max');
      await expectReachable(page, 'Edit Claude Max');
      // Save itself, scrolled to, is inside the card and can be clicked.
      const save = page.locator('.modal-card button', { hasText: /^Save/ }).first();
      await save.scrollIntoViewIfNeeded();
      await expect(save).toBeInViewport();
    });

    test('the subscription picker on Z.ai, the tallest detail, reaches its footer', async ({
      page,
    }) => {
      await open(page);
      await page.evaluate(async () => {
        const s = (
          globalThis as unknown as {
            __harnessStore: {
              openModal: (k: string) => void;
              setState: (...a: unknown[]) => void;
            };
          }
        ).__harnessStore;
        s.openModal('newProvider');
        s.setState('np', 'kind', 'sub');
        await Promise.resolve();
      });
      await page.waitForSelector('.modal-card--picker .sp-entry[data-plan="zai-coding-plan"]');
      await storeCall(page, 'choosePlan', 'zai-coding-plan');
      await page.waitForSelector('.modal-card--picker [data-key-preset-form]');
      await expectReachable(page, 'Subscription picker', '.sp-foot');
    });

    test('Add provider reaches its last row', async ({ page }) => {
      await open(page);
      await storeCall(page, 'openModal', 'newProvider');
      await page.waitForSelector('.modal-card');
      await expectReachable(page, 'Add provider');
    });
  });
}
