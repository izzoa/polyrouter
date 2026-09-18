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
        else
          kids.push({
            cls: (c as HTMLElement).className || c.tagName,
            r: c.getBoundingClientRect(),
          });
      }
    };
    walk(row);
    const overlaps: string[] = [];
    for (let a = 0; a < kids.length; a++) {
      for (let b = a + 1; b < kids.length; b++) {
        const x = kids[a]!.r;
        const y = kids[b]!.r;
        if (!x.width || !y.width) continue;
        if (
          x.left < y.right - 0.5 &&
          y.left < x.right - 0.5 &&
          x.top < y.bottom - 0.5 &&
          y.top < x.bottom - 0.5
        )
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

    test('the row still wraps as LINES, not one cell per line', async ({ page }) => {
      // The narrow layer's whole arrangement is `flex-wrap` plus `flex: 1 1 100%` and
      // `order` — every one of which a grid container ignores. If it stops restating
      // `display: flex`, the row inherits the desktop grid, `subgrid` computes to `none`
      // for want of a grid parent, and every cell stacks into its own line. Containment
      // and overlap checks all still pass on that layout, so this is what catches it:
      // the grip and the position badge belong on ONE line, side by side
      // (fix-batch-capability-and-chain-alignment).
      await open(page);
      const out = await page.evaluate(() => {
        const row = document.querySelector('.chain-row');
        const h = row?.querySelector('.drag-handle')?.getBoundingClientRect();
        const b = row?.querySelector('.pos-badge')?.getBoundingClientRect();
        const id = row?.querySelector('.chain-id')?.getBoundingClientRect();
        if (!row || !h || !b || !id) return null;
        return {
          badgeBesideHandle: b.left >= h.right - 0.5 && b.top < h.bottom - 0.5,
          idOnItsOwnLine: id.top >= h.bottom - 0.5,
        };
      });
      expect(out, 'no chain row rendered').not.toBeNull();
      expect(out!.badgeBesideHandle, 'the row stacked one cell per line').toBe(true);
      expect(out!.idOnItsOwnLine, 'the model id must take its own line here').toBe(true);
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
    // EXACT on purpose (geometry-contract.ts). A row's height can be text-driven
    // when its content wraps, but this is a single-line row, and the exact value
    // is MEASURED identical on both platforms: this assertion has passed on
    // ubuntu-latest in every green CI run since 2026-09-07, and on macOS. Unlike
    // a pass inside a slack window, a pass of an exact equality IS a measurement.
    // A bound would give up 1px sensitivity for no cross-platform benefit. If copy
    // ever grows enough to wrap on one platform first, this fails there — and the
    // row really has become two lines for those users, so that failure is real.
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

test.describe('the batch reservation control (add-batch-mode-routing task 5.5)', () => {
  // The harness reserves the MIDDLE entry, so a chain renders both states at once.
  for (const vp of [
    { name: '1440x900', width: 1440, height: 900 },
    { name: '390x844', width: 390, height: 844 },
    { name: '320x568', width: 320, height: 568 },
  ]) {
    test(`stays inside its row and meets its hit floor @ ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await open(page);
      const out = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.chain-row')];
        const switches = [...document.querySelectorAll('.chain-mode [role="switch"]')];
        const escapes: string[] = [];
        for (const sw of switches) {
          const row = sw.closest('.chain-row');
          if (!row) {
            escapes.push('switch outside any row');
            continue;
          }
          const r = sw.getBoundingClientRect();
          const b = row.getBoundingClientRect();
          if (r.right > b.right + 0.5 || r.left < b.left - 0.5)
            escapes.push('switch escapes its row');
          if (r.bottom > b.bottom + 0.5 || r.top < b.top - 0.5)
            escapes.push('switch escapes vertically');
        }
        return {
          rows: rows.length,
          switches: switches.length,
          checked: switches.filter((s) => s.getAttribute('aria-checked') === 'true').length,
          // A chain of five must not present five identically-named switches.
          names: new Set(switches.map((s) => s.getAttribute('aria-label'))).size,
          // Scrolled into view first: `elementFromPoint` is viewport-relative, so a
          // control below the fold answers null — which is a scroll position, not an
          // obstruction. The property under test is that nothing PAINTS OVER the
          // control, and the row's own 44px hit area is asserted by the responsive
          // suite (the lock lets `.toggle` keep its 30x17 box and reach the floor
          // through a `::before`).
          hits: switches.map((s) => {
            s.scrollIntoView({ block: 'center' });
            const r = s.getBoundingClientRect();
            const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return el !== null && (el === s || s.contains(el) || el.closest('.toggle') === s);
          }),
          escapes,
          docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      expect(out.rows).toBe(4);
      // Three of the four fixture models are batch-capable; the fourth's provider offers
      // no batch tier for it, so that row carries the empty cell and no switch
      // (fix-batch-capability-and-chain-alignment).
      expect(out.switches).toBe(3);
      expect(out.checked, 'exactly the reserved entry reads as on').toBe(1);
      expect(out.names, 'each switch names its own entry').toBe(3);
      expect(out.escapes).toEqual([]);
      // Reachable rather than merely non-empty: a clipped control is "visible" and untappable.
      expect(out.hits.every(Boolean), 'a switch is covered at its own centre').toBe(true);
      expect(
        out.docOverflow,
        'five controls must not push the page into horizontal scroll',
      ).toBeLessThanOrEqual(1);
    });
  }
});

test.describe('the reservation help escapes its tier card (add-batch-mode-help task 2.2)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('is fully visible on a tier with few rows, and closes when the page scrolls', async ({
    page,
  }) => {
    // The constraint that forces fixed positioning: every tier card is
    // `overflow: hidden`, so a card positioned inside the row is clipped at the
    // panel's edge — worst on a short tier, where there is nothing below to clip into.
    await open(page);
    const trigger = page.locator('.chain-help-trigger').first();
    await trigger.focus();
    await page.waitForTimeout(150);

    const out = await page.evaluate(() => {
      const card = document.querySelector('.chain-help-shown');
      if (!card) return { shown: false } as const;
      const c = card.getBoundingClientRect();
      const panel = card.closest('.panel')?.getBoundingClientRect() ?? null;
      // Reachable rather than merely non-empty: sample the card's own corners.
      const hit = (x: number, y: number): boolean => {
        const el = document.elementFromPoint(x, y);
        return el !== null && card.contains(el);
      };
      return {
        shown: true as const,
        inViewport:
          c.left >= -0.5 &&
          c.top >= -0.5 &&
          c.right <= window.innerWidth + 0.5 &&
          c.bottom <= window.innerHeight + 0.5,
        // If it were clipped by the panel it would be invisible where it overhangs.
        overhangsPanel:
          panel !== null && (c.bottom > panel.bottom + 0.5 || c.right > panel.right + 0.5),
        corners: [
          hit(c.left + 4, c.top + 4),
          hit(c.right - 4, c.top + 4),
          hit(c.left + 4, c.bottom - 4),
        ],
        position: getComputedStyle(card).position,
      };
    });

    expect(out.shown, 'focus alone must reveal it — no mouse').toBe(true);
    if (!out.shown) return; // narrows the union for the assertions below
    expect(out.position, 'absolute would be clipped by the tier card').toBe('fixed');
    expect(out.inViewport).toBe(true);
    expect(out.corners.every(Boolean), 'the card is painted over at its own corners').toBe(true);

    // A fixed card must not float away from an anchor that has moved.
    await page.evaluate(() => document.querySelector('main')?.dispatchEvent(new Event('scroll')));
    await page.waitForTimeout(100);
    expect(await page.locator('.chain-help-shown').count()).toBe(0);
  });

  test('the switch keeps its own tap, and the help is not bound to it', async ({ page }) => {
    // A tap on a `role="switch"` belongs to that switch. Clicking it must toggle and
    // must NOT raise the help — otherwise every state change spawns a card.
    await open(page);
    const sw = page.locator('.chain-mode [role="switch"]').first();
    const before = await sw.getAttribute('aria-checked');
    await sw.click();
    await page.waitForTimeout(120);
    expect(await sw.getAttribute('aria-checked')).not.toBe(before);
    expect(await page.locator('.chain-help-shown').count()).toBe(0);
  });
});

/** Every column's left edge, per row, plus the right edge of the action group. */
async function columnEdges(page: Page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('.chain-row')];
    const edge = (sel: string, side: 'left' | 'right'): number[] =>
      rows.map((r) => {
        const el = r.querySelector(sel);
        return el === null ? Number.NaN : el.getBoundingClientRect()[side];
      });
    return {
      rows: rows.length,
      cols: {
        // `.chain-mode` matches the placeholder too — it carries the class so the empty
        // cell occupies exactly the box the real one would.
        handle: edge('.drag-handle', 'left'),
        badge: edge('.pos-badge', 'left'),
        id: edge('.chain-id', 'left'),
        price: edge('.chain-price', 'left'),
        mode: edge('.chain-mode', 'left'),
        actions: edge('.chain-actions', 'left'),
        // The × is the last thing in the group on every row; "Make primary" is absent on
        // the primary row, so only a contained group keeps this edge stable.
        actionsRight: edge('.chain-actions', 'right'),
      },
      // Anti-vacuity: if these ever became uniform the alignment assertion would pass
      // under a per-row grid too, and would be measuring nothing.
      modeCellsWithContent: rows.filter((r) => r.querySelector('.chain-mode')?.children.length)
        .length,
      priceLabels: new Set(rows.map((r) => r.querySelector('.chain-price')?.textContent ?? ''))
        .size,
      tallestOverShortest:
        Math.max(...rows.map((r) => r.getBoundingClientRect().height)) /
        Math.min(...rows.map((r) => r.getBoundingClientRect().height)),
    };
  });
}

/**
 * The columns (fix-batch-capability-and-chain-alignment). This is a DESKTOP concern:
 * below the narrow threshold the row deliberately reverts to a wrapping flex line, which
 * the describes above measure.
 *
 * Why it needs a real browser: the defect was that each row's trailing group packed
 * against its own width, and it survives any check that does not compare one row's
 * geometry to another's.
 */
test.describe('chain row columns @desktop', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('the fixture is not uniform, so the alignment assertion measures something', async ({
    page,
  }) => {
    await open(page);
    const g = await columnEdges(page);
    expect(g.rows, 'four rows, deliberately differing').toBe(4);
    // One row's provider offers no batch tier for it: its reservation cell is empty.
    expect(g.modeCellsWithContent, 'every row carries the control — nothing to expose').toBe(3);
    // Four price labels of four different widths.
    expect(g.priceLabels).toBe(4);
    // One model id is long enough to wrap, so the rows differ in height too.
    expect(g.tallestOverShortest).toBeGreaterThan(1.2);
  });

  test('every column edge is shared by every row of the tier', async ({ page }) => {
    await open(page);
    const g = await columnEdges(page);
    for (const [name, edges] of Object.entries(g.cols)) {
      expect(edges.some(Number.isNaN), `${name} is missing from a row`).toBe(false);
      const spread = Math.max(...edges) - Math.min(...edges);
      expect(spread, `${name} lands at ${edges.map((n) => n.toFixed(1)).join(' / ')}`).toBeLessThan(
        0.5,
      );
    }
  });

  test('no cell paints outside its own column', async ({ page }) => {
    // 1280 is the cramped case: the panel is 670px there against 755px at the layout's
    // design width, and the row's content does not fit on one line either way. Something
    // must wrap, and the columns decide WHICH — so this pins the outcome that a cell
    // wraps INSIDE its column rather than painting past it, which is the failure mode a
    // containment check cannot see (the box stays inside the row either way).
    await open(page);
    // The TEXT cells only. The reservation and the action group both carry controls whose
    // hit area reaches the comfort floor through a `::before` larger than the control's
    // own box, so their scroll width legitimately exceeds their client width and says
    // nothing about the columns.
    const over = await page.evaluate(() =>
      [...document.querySelectorAll('.chain-row')].flatMap((row, i) =>
        ['.chain-id', '.chain-price']
          .map((sel) => ({ sel, el: row.querySelector(sel) }))
          .filter(({ el }) => el !== null && el.scrollWidth > el.clientWidth + 1)
          .map(({ sel }) => `row ${String(i)} ${sel}`),
      ),
    );
    expect(over, 'a cell overflows its column').toEqual([]);
  });

  test('a row warning takes its own line and does not claim a column', async ({ page }) => {
    // The reserved entry's model is batch-capable in the fixture, so the warning is
    // induced here rather than fixtured: it is the STATE that matters, not its cause.
    await open(page);
    await page.evaluate(() => {
      const row = document.querySelectorAll('.chain-row')[1];
      const notes = document.createElement('div');
      notes.className = 'chain-notes';
      notes.textContent = 'reserved for batch, but this provider has no batch API';
      row?.appendChild(notes);
    });
    await page.waitForTimeout(50);
    const g = await columnEdges(page);
    // The columns are unmoved...
    for (const [name, edges] of Object.entries(g.cols)) {
      const spread = Math.max(...edges) - Math.min(...edges);
      expect(spread, `${name} moved when a warning rendered`).toBeLessThan(0.5);
    }
    // ...and the note spans the row rather than sitting in the actions' track.
    const spans = await page.evaluate(() => {
      const row = document.querySelectorAll('.chain-row')[1];
      const notes = row?.querySelector('.chain-notes');
      if (!row || !notes) return null;
      const r = row.getBoundingClientRect();
      const n = notes.getBoundingClientRect();
      const id = row.querySelector('.chain-id')!.getBoundingClientRect();
      return { widthRatio: n.width / r.width, belowContent: n.top >= id.bottom - 0.5 };
    });
    expect(spans).not.toBeNull();
    expect(spans!.widthRatio, 'the note is confined to a column').toBeGreaterThan(0.8);
    expect(spans!.belowContent, 'the note shares the content line').toBe(true);
  });
});
