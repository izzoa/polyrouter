import { expect, test } from '@playwright/test';

const matrix = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1025, height: 768 },
  { width: 1440, height: 900 },
  { width: 1025, height: 768, coarse: true },
];
for (const theme of ['light', 'dark'])
  for (const viewport of matrix) {
    test.describe(`budget progress ${theme} ${viewport.width}×${viewport.height}${viewport.coarse ? ' coarse' : ''}`, () => {
      test.use({ viewport, hasTouch: viewport.coarse ?? false });
      test('contains charts, complete text and comfort targets without overflow or overlap', async ({
        page,
      }) => {
        await page.addInitScript((t) => localStorage.setItem('polyrouter:theme', t), theme);
        await page.goto('/browser-harness.html?budget=progress#/limits');
        await page.waitForSelector('html[data-harness-ready="true"]');
        await expect(page.locator('.budget-figure')).toHaveCount(5);
        // Apply the actual store theme, using the fixture's documented seam.
        await page.evaluate((t) => {
          const s = (
            globalThis as unknown as {
              __harnessStore: { state: { theme: string }; toggleTheme: () => void };
            }
          ).__harnessStore;
          if (s.state.theme !== t) s.toggleTheme();
        }, theme);
        await expect(page.locator('.budget-figure .uplot')).toHaveCount(5);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
        ).toBeLessThanOrEqual(1);
        const problems = await page.evaluate(() => {
          const out: string[] = [];
          for (const card of document.querySelectorAll('.budget-card')) {
            const c = card.getBoundingClientRect();
            for (const child of card.querySelectorAll('h2,p,figcaption,.uplot,button')) {
              const r = child.getBoundingClientRect();
              if (r.left < c.left - 1 || r.right > c.right + 1)
                out.push(`outside card: ${child.tagName}`);
            }
            const plot = card.querySelector('.uplot')!.getBoundingClientRect();
            const caption = card.querySelector('figcaption')!.getBoundingClientRect();
            if (plot.bottom > caption.top + 1) out.push('chart overlaps caption');
            const floor = matchMedia('(pointer:coarse)').matches || innerWidth <= 768 ? 44 : 24;
            for (const btn of card.querySelectorAll('button')) {
              const r = btn.getBoundingClientRect();
              if (r.width < 23 || r.height < floor - 1) out.push(`target below ${floor}`);
            }
            const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              if (!node.textContent?.trim()) continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              for (const r of range.getClientRects())
                if (r.right > c.right + 1 || r.left < c.left - 1) out.push('text escapes card');
            }
          }
          return out;
        });
        expect(problems).toEqual([]);
        await expect(page.locator('.budget-card').first()).toContainText('$12.40');
        await expect(page.locator('.budget-card').first()).toContainText('49.6%');
        await expect(page.locator('.budget-card').first()).toContainText('$9.60');
        await expect(page.locator('.budget-card').nth(3)).toContainText('unpriced');
        // adopt-figure-states 5.4: a disabled budget over its amount reads `$1.50 over budget` in
        // red status text beside `106%`, and names its disabled state on the same line, never
        // `blocked`; a sub-cent amount reads `<$0.01`, on the card's configured line too.
        const disabled = page.locator('.budget-card').nth(2);
        await expect(disabled).toContainText('106%');
        await expect(disabled.locator('.budget-allowance')).toHaveText(
          '$1.50 over budget · Budget disabled',
        );
        await expect(disabled).not.toContainText('blocked');
        const red = await disabled.locator('[data-testid="budget-over"]').evaluate((el) => {
          const probe = document.createElement('span');
          probe.style.color = 'var(--red-text)';
          document.body.append(probe);
          const want = getComputedStyle(probe).color;
          probe.remove();
          return { got: getComputedStyle(el).color, want };
        });
        expect(red.got).toBe(red.want);
        const tiny = page.locator('.budget-card').nth(3);
        await expect(tiny.locator('[data-testid="budget-config"]')).toHaveText(
          'Budget <$0.01 / day',
        );
        await expect(tiny.locator('.budget-progress-headline')).toContainText('<$0.01');
        // One stale state with one caption: the retired suffixes never render.
        for (const retired of ['Refresh failed', 'Stale recorded progress', 'Period ended'])
          await expect(page.locator('.budget-card', { hasText: retired })).toHaveCount(0);
        await expect(page.locator('.budget-card').nth(4)).toContainText('No metered activity');
        expect(await page.locator('.budget-figure[aria-live]').count()).toBe(0);
        await page.screenshot({
          path: `test-results/budget-progress-${theme}-${viewport.width}${viewport.coarse ? '-coarse' : ''}.png`,
          fullPage: true,
        });
        await page.evaluate(() => {
          (
            globalThis as unknown as { __harnessStore: { go: (p: string) => void } }
          ).__harnessStore.go('agents');
        });
        await expect(page.locator('.budget-figure,.budget-card .uplot')).toHaveCount(0);
      });
    });
  }
test('keyboard editing and failure leave management usable, then request charts still render', async ({
  page,
}) => {
  await page.goto('/browser-harness.html?budget=unavailable#/limits');
  await page.waitForSelector('html[data-harness-ready="true"]');
  await expect(page.getByRole('button', { name: 'Retry progress' })).toHaveCount(5);
  // A failed read with no retained snapshot names the failure (adopt-figure-states 5.4; U+2019).
  await expect(page.getByText('Budget progress couldn’t be loaded.', { exact: true })).toHaveCount(
    5,
  );
  const edit = page.getByRole('button', { name: 'Edit', exact: true }).first();
  await edit.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goto('/browser-harness.html#/overview');
  await page.waitForSelector('html[data-harness-ready="true"]');
  await expect(page.locator('.uplot').first()).toBeVisible();
  await expect(page.getByText('Requests · 24h', { exact: true })).toBeVisible();
});
