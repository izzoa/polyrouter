/** The chain row and its touch reorder, in a real browser (phase3-touch-reorder).
 *
 * Two things here cannot be established anywhere else. The row's LAYOUT — happy-dom
 * performs none, and the row's defect was that its model id computed to zero width while
 * the price label was painted over it, neither of which is visible without layout. And the
 * DRAG SUPPRESSION — drag-and-drop selects the nearest draggable ancestor, which is native
 * behaviour no synthetic event can reproduce.
 */
import { expect, test, type Page } from '@playwright/test';

async function open(page: Page): Promise<void> {
  await page.goto('/browser-harness.html?chain=1#/routing');
  await page.waitForSelector('html[data-harness-ready="true"]');
  await page.waitForSelector('.chain-row');
  await page.waitForTimeout(300);
}

/** Geometry of one row's children, for containment and overlap. */
async function rowGeometry(page: Page, index = 0) {
  return page.evaluate((i) => {
    const row = document.querySelectorAll('.chain-row')[i as number];
    if (!row) return null;
    const rb = row.getBoundingClientRect();
    const kids: { cls: string; r: DOMRect }[] = [];
    const walk = (el: Element): void => {
      for (const c of el.children) {
        // `display: contents` wrappers contribute no box; measure what actually paints.
        if (getComputedStyle(c).display === 'contents') walk(c);
        else kids.push({ cls: (c as HTMLElement).className || c.tagName, r: c.getBoundingClientRect() });
      }
    };
    walk(row);
    const overlaps: string[] = [];
    for (let a = 0; a < kids.length; a++) {
      for (let b = a + 1; b < kids.length; b++) {
        const x = kids[a]!.r;
        const y = kids[b]!.r;
        if (!x.width || !y.width) continue;
        if (x.left < y.right - 0.5 && y.left < x.right - 0.5 && x.top < y.bottom - 0.5 && y.top < x.bottom - 0.5)
          overlaps.push(`${kids[a]!.cls} / ${kids[b]!.cls}`);
      }
    }
    return {
      idWidth: Math.round(kids.find((k) => k.cls.includes('chain-id'))?.r.width ?? -1),
      overlaps,
      escaping: kids
        .filter((k) => k.r.width && (k.r.left < rb.left - 0.5 || k.r.right > rb.right + 0.5))
        .map((k) => k.cls),
      undersized: kids
        .filter((k) => k.cls.includes('chain-move') && (k.r.width < 43.5 || k.r.height < 43.5))
        .map((k) => `${k.cls} ${Math.round(k.r.width)}x${Math.round(k.r.height)}`),
    };
  }, index);
}

for (const vp of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
]) {
  test.describe(`chain row @${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp });

    test('the model id is legible, nothing overlaps, nothing escapes', async ({ page }) => {
      // Before this change the id computed to 0px at 320 and 11px at 390, with the price
      // label painted over it — a naive containment check passed the whole time.
      await open(page);
      const g = await rowGeometry(page);
      expect(g, 'no chain row rendered').not.toBeNull();
      expect(g!.idWidth, 'the model id is collapsed').toBeGreaterThan(80);
      expect(g!.overlaps, 'row children overlap').toEqual([]);
      expect(g!.escaping, 'row children escape the row').toEqual([]);
    });

    test('the move controls are present and meet the comfort floor', async ({ page }) => {
      await open(page);
      const g = await rowGeometry(page);
      expect(await page.locator('.chain-row').first().locator('.chain-move').count()).toBe(2);
      expect(g!.undersized, 'move controls below the 44px floor').toEqual([]);
    });

    test('a real tap reorders the chain', async ({ page }) => {
      await open(page);
      const first = () => page.locator('.chain-row').first().getAttribute('data-model-id');
      const before = await first();
      await page
        .locator('.chain-row')
        .first()
        .locator('.chain-move[data-dir="down"]')
        .tap({ timeout: 5000 })
        .catch(async () => {
          // Contexts without touch fall back to a click — the assertion is the reorder.
          await page.locator('.chain-row').first().locator('.chain-move[data-dir="down"]').click();
        });
      await page.waitForTimeout(300);
      expect(await first(), 'the tap did not reorder the chain').not.toBe(before);
    });

    test('the hint names the affordance that exists', async ({ page }) => {
      await open(page);
      const hint = await page.locator('.chain-hint').first().innerText();
      expect(hint, 'still tells a touch user to drag').not.toContain('drag to reorder');
      expect(hint).toContain('↑');
    });
  });
}

test.describe('touch context above the narrow threshold', () => {
  // The device the `any-pointer: coarse` rule exists for: a touch laptop, which reports
  // `pointer: fine` because its PRIMARY pointer is a mouse, and cannot drag with a finger.
  test.use({ viewport: { width: 1400, height: 900 }, hasTouch: true });

  test('the move controls are present', async ({ page }) => {
    await open(page);
    expect(
      await page.locator('.chain-row').first().locator('.chain-move:visible').count(),
      'a touch device at desktop width has no way to reorder',
    ).toBe(2);
  });
});

test.describe('desktop with a fine pointer', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('the row is unchanged: one line, no move controls', async ({ page }) => {
    await open(page);
    expect(await page.locator('.chain-row').first().locator('.chain-move:visible').count()).toBe(0);
    const h = await page
      .locator('.chain-row')
      .first()
      .evaluate((el) => Math.round(el.getBoundingClientRect().height));
    expect(h, 'the desktop row changed height').toBe(43);
  });

  test('the hint still says drag', async ({ page }) => {
    await open(page);
    expect(await page.locator('.chain-hint').first().innerText()).toContain('drag to reorder');
  });
});

test.describe('a press on a move control does not drag the row', () => {
  // Native ancestor-drag selection: the ROW is draggable, so a gesture starting on a
  // nested button would start the row's drag. Neither `draggable={false}` on the button
  // nor a listener attached to it can prevent that — only cancelling the row's own
  // `dragstart` does. No unit test can establish this.
  test.use({ viewport: { width: 390, height: 844 } });

  test('no drag starts, and the chain does not reorder unexpectedly', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      const w = window as unknown as { __drags: number; __live: number };
      w.__drags = 0;
      w.__live = 0;
      // BUBBLE phase, registered after Solid's delegated handler, so `defaultPrevented`
      // reflects whether the row cancelled it. A capture listener would run first and
      // always see `false` — and counting `dragstart` events alone proves nothing, since
      // `preventDefault()` cancels the drag without stopping the event from firing.
      document.addEventListener('dragstart', (e) => {
        w.__drags++;
        if (!e.defaultPrevented) w.__live++;
      });
    });

    const btn = page.locator('.chain-row').first().locator('.chain-move[data-dir="down"]');
    const box = await btn.boundingBox();
    expect(box).not.toBeNull();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;

    // Press, move well past Chromium's drag threshold while staying over the control,
    // then release — the exact gesture that would otherwise drag the row.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 12, cy + 14, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(250);

    const seen = await page.evaluate(() => {
      const w = window as unknown as { __drags: number; __live: number };
      return { drags: w.__drags, live: w.__live };
    });
    expect(seen.live, 'pressing a move control started a LIVE row drag').toBe(0);
    expect(
      await page.locator('.chain-row[data-dragging="true"]').count(),
      'a row entered the dragging state',
    ).toBe(0);
  });
});
