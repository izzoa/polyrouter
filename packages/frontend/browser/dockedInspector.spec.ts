/** The docked Request Inspector, rendered (add-docked-inspector task 2.2; dashboard-analytics
 * "At wide viewports the inspector docks beside the request list", scenarios "Opening a row
 * docks the inspector beside a live list" and "The docked panel appears in place and scrolls
 * within itself").
 *
 * The view suite (`src/dockedInspector.view.test.tsx`) proves the structure — the classes, the
 * role, the layer kind, focus — but happy-dom applies no stylesheet and performs no layout, so
 * whether the panel really sits beside the list, without a shadow, scrolling within itself,
 * and whether every control beside it can still be reached, is measured here at 1440×900, the
 * verification matrix's dock-threshold viewport.
 *
 * The default harness has 30 request rows against a page size of 25, so "Load more" renders,
 * and an `in_progress` batch job, so a live band row renders. Every default fixture row is
 * synchronous, and row 0 is an `explicit` row, so it stays listed under the Sync mode and the
 * Explicit filter.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

test.use({ viewport: { width: 1440, height: 900 } });

/** The Requests page with its list loaded. */
async function openRequests(page: Page): Promise<void> {
  await page.goto('/browser-harness.html#/requests');
  await page.waitForSelector('html[data-harness-ready="true"]');
  await page.waitForSelector('.rs-table-requests button.req-row');
}

const rows = (page: Page): Locator => page.locator('.rs-table-requests button.req-row');
const panel = (page: Page): Locator => page.locator('#inspector-drawer');

/** Opens row 0 by pointer; returns the id of the request it shows. */
async function dockRow0(page: Page): Promise<string> {
  const row = rows(page).first();
  const id = await row.getAttribute('data-request-id');
  expect(id, 'the row carries its request id').not.toBeNull();
  await row.click();
  await page.waitForSelector('#inspector-drawer.rs-inspector-docked');
  await expectDockedOn(page, id!);
  return id!;
}

/** The panel is docked, open on `id`, and the content pane still gives up its width. */
async function expectDockedOn(page: Page, id: string): Promise<void> {
  await expect(panel(page)).toHaveClass(/(?:^|\s)rs-inspector-docked(?:\s|$)/);
  await expect(panel(page)).toHaveAttribute('role', 'complementary');
  expect(
    await panel(page).getAttribute('aria-modal'),
    'a docked panel claims aria-modal',
  ).toBeNull();
  await expect(panel(page).locator('[data-testid="inspector-id"]')).toHaveText(id);
  await expect(page.locator('[data-pane="content"]')).toHaveClass(/(?:^|\s)rs-docked(?:\s|$)/);
  expect(await page.locator('.overlay').count(), 'a scrim is rendered while docked').toBe(0);
}

/** Marks the current list so a reload — a new `requestList` — can be told from none. */
async function markList(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = globalThis as unknown as {
      __harnessStore: { state: { requestList: unknown } };
      __listMark?: unknown;
    };
    g.__listMark = g.__harnessStore.state.requestList;
  });
}
async function listReloaded(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const g = globalThis as unknown as {
      __harnessStore: { state: { requestList: unknown; requestListLoading: boolean } };
      __listMark?: unknown;
    };
    return (
      g.__harnessStore.state.requestList !== g.__listMark &&
      !g.__harnessStore.state.requestListLoading
    );
  });
}

const isFocused = (l: Locator): Promise<boolean> =>
  l.evaluate((el) => el === document.activeElement);
const focusInPanel = (page: Page): Promise<boolean> =>
  page.evaluate(
    () => document.getElementById('inspector-drawer')?.contains(document.activeElement) ?? false,
  );

test.describe('the docked panel, rendered (task 2.2)', () => {
  test('is the 480px panel at the right edge, full height, fixed, and the content column gives up its width', async ({
    page,
  }) => {
    await openRequests(page);
    await dockRow0(page);
    const box = await panel(page).boundingBox();
    expect(box, 'the docked box').toEqual({ x: 960, y: 0, width: 480, height: 900 });
    const cs = await panel(page).evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        position: s.position,
        animation: s.animationName,
        borderLeft: `${s.borderLeftWidth} ${s.borderLeftStyle}`,
      };
    });
    expect(cs.position, 'still an out-of-flow surface').toBe('fixed');
    expect(cs.animation, 'no entrance when docked').toBe('none');
    expect(cs.borderLeft, 'the Hairline leading edge').toBe('1px solid');
    const paneRight = await page
      .locator('[data-pane="content"]')
      .evaluate((el) => el.getBoundingClientRect().right);
    expect(paneRight, 'the content column, top bar included, ends where the panel begins').toBe(
      960,
    );
    const topbarRight = await page
      .locator('[data-pane="content"] > :first-child')
      .evaluate((el) => el.getBoundingClientRect().right);
    expect(topbarRight).toBeLessThanOrEqual(960);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`draws no shadow in the ${theme} theme, and its body scrolls within it`, async ({
      page,
    }) => {
      await openRequests(page);
      await page.evaluate((t) => {
        const s = (
          globalThis as unknown as {
            __harnessStore: { state: { theme: string }; toggleTheme: () => void };
          }
        ).__harnessStore;
        if (s.state.theme !== t) s.toggleTheme();
      }, theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await dockRow0(page);
      expect(
        await panel(page).evaluate((el) => getComputedStyle(el).boxShadow),
        `${theme}: the docked panel's box-shadow`,
      ).toBe('none');
      expect(
        await panel(page)
          .locator('.drawer-body')
          .evaluate((el) => {
            const s = getComputedStyle(el);
            return `${s.overflowY} ${s.overscrollBehaviorY}`;
          }),
        'the body scrolls within the panel without chaining to the page',
      ).toBe('auto contain');
    });
  }

  test('below the threshold the same element is the modal drawer: a shadow, a scrim, uncontained body', async ({
    page,
  }) => {
    // The contrast that keeps the docked look from being the drawer's own: at 1025×768 nothing
    // above applies (the docked rules sit inside the 1440 prelude).
    await page.setViewportSize({ width: 1025, height: 768 });
    await openRequests(page);
    await rows(page).first().click();
    await page.waitForSelector('#inspector-drawer[aria-modal="true"]');
    // The modal drawer keeps its `slidein` entrance (collapsed, not removed, by reduced
    // motion): measure once it has finished, or a loaded machine reads it mid-slide.
    await panel(page).evaluate((el) =>
      Promise.all(el.getAnimations().map((a) => a.finished)).then(() => undefined),
    );
    expect(await panel(page).getAttribute('class')).toBe('drawer');
    expect(await page.locator('.overlay').count(), 'the modal drawer keeps its scrim').toBe(1);
    expect(await panel(page).boundingBox()).toEqual({ x: 585, y: 0, width: 440, height: 768 });
    expect(await panel(page).evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');
    expect(
      await page.locator('[data-pane="content"]').evaluate((el) => el.className),
      'no width reserved for a modal drawer',
    ).toBe('');
  });
});

test.describe('the list beside the dock stays operable (task 2.2)', () => {
  test('nothing beside the panel is covered or inert', async ({ page }) => {
    await openRequests(page);
    // The harness mounts with `live={false}`, so no poller reads the batch partition: read it
    // once, as the page's own poller would, so the `in_progress` job's live row renders.
    await page.evaluate(() =>
      (
        globalThis as unknown as { __harnessStore: { loadBatchBand: () => Promise<void> } }
      ).__harnessStore.loadBatchBand(),
    );
    await page.waitForSelector('.rs-table-requests [data-batch-row]');
    await dockRow0(page);
    const targets: [string, Locator][] = [
      ...(await page.locator('[data-testid="requests-filter-row"] .filter-chip').all()).map(
        (l, i) => [`filter chip ${String(i)}`, l] as [string, Locator],
      ),
      ['the Agent filter', page.locator('#req-agent')],
      ['Load more', page.locator('button', { hasText: 'Load more' })],
      ['the endpoint chip', page.getByRole('button', { name: 'Copy endpoint URL' })],
      ['the live band row', page.locator('.rs-table-requests [data-batch-row]').first()],
    ];
    // 5 routing chips + 3 Mode chips.
    expect(targets.length, 'every control beside the panel is checked').toBe(12);
    for (const [name, target] of targets) {
      await expect(target, `${name} renders`).toHaveCount(1);
      await target.scrollIntoViewIfNeeded();
      const hit = await target.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const drawer = document.getElementById('inspector-drawer');
        const blocked: string[] = [];
        for (let a: Element | null = el; a; a = a.parentElement) {
          if (a.hasAttribute('inert')) blocked.push(`${a.tagName} inert`);
          if (a.getAttribute('aria-hidden') === 'true') blocked.push(`${a.tagName} aria-hidden`);
        }
        return {
          reaches: at !== null && (at === el || el.contains(at)),
          underPanel: at !== null && (drawer?.contains(at) ?? false),
          blocked,
        };
      });
      expect(hit.underPanel, `${name} lies under the docked panel`).toBe(false);
      expect(hit.reaches, `${name} is covered at its centre`).toBe(true);
      expect(hit.blocked, `${name} sits in inert or hidden content`).toEqual([]);
    }
    expect(await panel(page).getAttribute('aria-modal')).toBeNull();
  });

  test('pointer: the Sync mode chip filters the list beside the panel, which stays open on its request', async ({
    page,
  }) => {
    await openRequests(page);
    const id = await dockRow0(page);
    await markList(page);
    const sync = page.locator('[role="group"][aria-labelledby="req-mode-label"] .filter-chip', {
      hasText: 'Sync',
    });
    await sync.click();
    await expect(sync).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => listReloaded(page), 'the list reloaded').toBe(true);
    expect(await isFocused(sync), 'focus is on the chip').toBe(true);
    await expectDockedOn(page, id);
  });

  test('keyboard: Space on the All mode chip and Enter on the Explicit chip each reload the list, focus stays on the control', async ({
    page,
  }) => {
    await openRequests(page);
    const id = await dockRow0(page);
    const all = page.locator('[role="group"][aria-labelledby="req-mode-label"] .filter-chip', {
      hasText: 'All',
    });
    const explicit = page.locator('[data-testid="requests-filter-row"] > .rs-wrap .filter-chip', {
      hasText: 'Explicit',
    });
    for (const [control, key] of [
      [all, 'Space'],
      [explicit, 'Enter'],
    ] as const) {
      await markList(page);
      await control.focus();
      await page.keyboard.press(key);
      await expect(control).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => listReloaded(page), `${key}: the list reloaded`).toBe(true);
      expect(await isFocused(control), `${key}: focus stays on the control`).toBe(true);
      await expectDockedOn(page, id);
    }
  });

  for (const how of ['pointer', 'Enter'] as const) {
    test(`Load more by ${how} grows the list beside the panel, which stays docked and open`, async ({
      page,
    }) => {
      await openRequests(page);
      expect(await rows(page).count()).toBe(25);
      const id = await dockRow0(page);
      const more = page.locator('button', { hasText: 'Load more' });
      if (how === 'pointer') await more.click();
      else {
        await more.focus();
        await page.keyboard.press('Enter');
      }
      await expect(rows(page)).toHaveCount(30);
      await expectDockedOn(page, id);
      // The second page is the last, so the button unmounts. Where focus goes then is today's
      // behaviour, which this change leaves alone — only never into the panel.
      expect(await focusInPanel(page), 'focus moved into the panel').toBe(false);
    });
  }
});

/** The content pane's scroll offset, and whether `el` lies inside its visible box. */
async function mainScrollTop(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('main')?.scrollTop ?? -1);
}
async function inMainView(l: Locator): Promise<boolean> {
  return l.evaluate((el) => {
    const main = document.querySelector('main');
    if (main === null) return false;
    const r = el.getBoundingClientRect();
    const m = main.getBoundingClientRect();
    return r.top >= m.top - 0.5 && r.bottom <= m.bottom + 0.5;
  });
}

test.describe('stepping in a real browser (tasks 4.2, 4.3)', () => {
  // happy-dom scrolls nothing, so whether a handled arrow key also scrolls the pane, and whether
  // the row stepped to is really brought into view, is measured here.
  test('ArrowDown on a focused row steps the docked panel, never also scrolling the pane, and keeps the row in view', async ({
    page,
  }) => {
    await openRequests(page);
    await dockRow0(page);
    const first = rows(page).first();
    expect(await isFocused(first), 'opening the docked panel moved focus').toBe(true);
    const top = await mainScrollTop(page);
    // Read after every handler has run (window is the last stop of a bubbling keydown), so the
    // check does not depend on whether the browser animates a keyboard scroll.
    await page.evaluate(() => {
      const g = globalThis as unknown as { __arrowPrevented?: boolean[] };
      g.__arrowPrevented = [];
      window.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp')
          g.__arrowPrevented?.push(e.defaultPrevented);
      });
    });

    await page.keyboard.press('ArrowDown');
    await expectDockedOn(page, 'req-001');
    const second = rows(page).nth(1);
    expect(await isFocused(second), 'focus moves to the row stepped to').toBe(true);
    expect(
      await page.evaluate(
        () => (globalThis as unknown as { __arrowPrevented?: boolean[] }).__arrowPrevented,
      ),
      'the handled key kept its default (the pane would scroll too)',
    ).toEqual([true]);
    await page.waitForTimeout(300); // past any smooth-scroll animation
    expect(await mainScrollTop(page), 'the key also scrolled the pane').toBe(top);

    for (let i = 0; i < 19; i += 1) await page.keyboard.press('ArrowDown');
    await expectDockedOn(page, 'req-020');
    const far = page.locator('button.req-row[data-request-id="req-020"]');
    expect(await isFocused(far)).toBe(true);
    expect(await inMainView(far), 'the row stepped to is out of view').toBe(true);

    await page.keyboard.press('ArrowUp');
    await expectDockedOn(page, 'req-019');
  });

  test('Previous / Next step in the docked panel, focus stays on the control, and a bound keeps it', async ({
    page,
  }) => {
    await openRequests(page);
    await dockRow0(page);
    const prev = panel(page).getByRole('button', { name: 'Previous request' });
    const next = panel(page).getByRole('button', { name: 'Next request' });
    await expect(prev).toHaveAttribute('aria-disabled', 'true');
    await next.click();
    await expectDockedOn(page, 'req-001');
    expect(await isFocused(next)).toBe(true);
    await page.keyboard.press('ArrowDown');
    await expectDockedOn(page, 'req-002');
    await prev.focus();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp'); // a bound: nothing changes, focus stays
    await expectDockedOn(page, 'req-000');
    expect(await isFocused(prev), 'a bound dropped focus').toBe(true);
    await expect(prev).toHaveAttribute('aria-disabled', 'true');
  });
});

/* ---- the docked compact list's state marks and the row's name (add-docked-inspector 6.1) ----
 *
 * Which copy of a completed row's state marks is rendered — the Decided-by cell's, or the
 * status cell's `.rs-docked-marks` — is the stylesheet's call, so the exactly-once check reads
 * the row's accessible name as Chromium computes it, here. `?marks=1` heads the list with a
 * served row that is both escalated and a settled batch item. */

/** The accessible name of the completed row for `id`, from its ARIA snapshot. */
async function rowName(page: Page, id: string): Promise<string> {
  const snap = await page.locator(`button.req-row[data-request-id="${id}"]`).ariaSnapshot();
  const m = /^- button "((?:[^"\\]|\\.)*)"/.exec(snap);
  expect(m, `no button name in ${snap}`).not.toBeNull();
  return m![1]!.replace(/\\"/g, '"');
}
const count = (name: string, word: string): number =>
  (name.match(new RegExp(`\\b${word}\\b`, 'g')) ?? []).length;

const MARKED = 'marks-batch-escalated';

/** The docked inspector shows the marks fixture's batch item: the job id, the job's wall time
 * (the outcome node's latency, `2h 7m`) and the batch-rate provenance of the cost (the receipt's
 * "Batch rate, recorded at submission." caption and its `batch · bundled` source row). */
async function expectBatchInspector(page: Page): Promise<void> {
  const drawer = page.locator('#inspector-drawer');
  await expect(drawer.locator('[data-testid="inspector-id"]')).toHaveText(MARKED);
  await expect(drawer.locator('[data-batch-id]')).toHaveText('bj-marks');
  await expect(drawer.locator('[data-testid="rt-latency"]').last()).toHaveText('2h 7m');
  await expect(drawer.locator('[data-testid="receipt-source"]')).toHaveText('batch · bundled');
  await expect(drawer.locator('[data-testid="receipt-caption"]')).toHaveText(
    'Batch rate, recorded at submission.',
  );
}

test.describe('state marks and names in every form (task 6.1)', () => {
  test('an escalated batch item names "escalated" and "batch" exactly once in the one-line form, both narrowed forms and the docked list; the name is the same in the three width forms', async ({
    page,
  }) => {
    await page.goto('/browser-harness.html?marks=1#/requests');
    await page.waitForSelector('html[data-harness-ready="true"]');
    await page.waitForSelector(`button.req-row[data-request-id="${MARKED}"]`);
    const names: Record<string, string> = {};
    // One-line (1440, undocked: a 1182px container), form one (1025×768: 767px), form two (a
    // 640px container: 730px at narrow).
    for (const [form, vp] of [
      ['one-line', { width: 1440, height: 900 }],
      ['form one', { width: 1025, height: 768 }],
      ['form two', { width: 730, height: 900 }],
    ] as const) {
      await page.setViewportSize(vp);
      await page.waitForTimeout(50);
      const name = await rowName(page, MARKED);
      expect(count(name, 'escalated'), `${form}: "escalated" in ${name}`).toBe(1);
      expect(count(name, 'batch'), `${form}: "batch" in ${name}`).toBe(1);
      names[form] = name;
    }
    const container = await page.locator('.rs-table-requests').evaluate((el) => el.clientWidth);
    expect(container, 'form two is a 640px container here').toBe(640);
    expect(names['form one'], 'the name changed between forms').toBe(names['one-line']);
    expect(names['form two'], 'the name changed between forms').toBe(names['one-line']);

    // Docked: the P1 cells and the marks, each mark once, in the status cell after its word.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator(`button.req-row[data-request-id="${MARKED}"]`).click();
    await page.waitForSelector('#inspector-drawer.rs-inspector-docked');
    const docked = await rowName(page, MARKED);
    expect(count(docked, 'escalated'), `docked: "escalated" in ${docked}`).toBe(1);
    expect(count(docked, 'batch'), `docked: "batch" in ${docked}`).toBe(1);
    const cells = await page
      .locator(`button.req-row[data-request-id="${MARKED}"]`)
      .evaluate((row) => {
        const text = (col: string): string => {
          const v = row.querySelector<HTMLElement>(`.rs-col-${col} > :not(.rs-cell-label)`)!;
          return (v.innerText ?? '').replace(/\s+/g, ' ').trim();
        };
        return {
          time: text('time'),
          model: text('model'),
          status: text('status'),
          cost: text('cost'),
        };
      });
    for (const part of [cells.time, cells.model, cells.cost]) {
      expect(docked, `the docked name lost "${part}"`).toContain(part);
    }
    expect(docked).toMatch(/\bOK\b/);
    // The marks follow the status word, in the status cell.
    expect(cells.status).toMatch(/^OK\b.*\bbatch\b/);
  });

  test('closing the docked panel moves the marks back to the Decided-by cell and shows the hours-formatted latency again', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/browser-harness.html?marks=1#/requests');
    await page.waitForSelector('html[data-harness-ready="true"]');
    const row = page.locator(`button.req-row[data-request-id="${MARKED}"]`);
    const shown = (): Promise<{ docked: boolean; decided: boolean; latency: string | null }> =>
      row.evaluate((r) => {
        const visible = (el: Element | null): boolean =>
          el !== null && (el as HTMLElement).getClientRects().length > 0;
        const latency = r.querySelector<HTMLElement>('.rs-col-latency > :not(.rs-cell-label)');
        return {
          docked: visible(r.querySelector('.rs-col-status .rs-docked-marks')),
          decided: visible(r.querySelector('.rs-col-decided > :not(.rs-cell-label)')),
          latency: visible(latency) ? (latency!.textContent ?? '').trim() : null,
        };
      });
    expect(await shown()).toEqual({ docked: false, decided: true, latency: '2h 7m' });
    await row.click();
    await page.waitForSelector('#inspector-drawer.rs-inspector-docked');
    expect(await shown()).toEqual({ docked: true, decided: false, latency: null });
    // The inspector names the job, the wall time and the batch-rate provenance.
    await expectBatchInspector(page);
    await page.locator('#inspector-drawer button[aria-label="Close inspector"]').click();
    await expect(page.locator('#inspector-drawer')).toHaveCount(0);
    expect(await shown()).toEqual({ docked: false, decided: true, latency: '2h 7m' });
    expect(count(await rowName(page, MARKED), 'batch')).toBe(1);
  });

  test('stepping to the batch item, by ArrowUp from the row below and by Previous, shows the same batch id, wall time and provenance', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/browser-harness.html?marks=1#/requests');
    await page.waitForSelector('html[data-harness-ready="true"]');
    await page.waitForSelector(`button.req-row[data-request-id="${MARKED}"]`);
    await page.locator('button.req-row').nth(1).click();
    await page.waitForSelector('#inspector-drawer.rs-inspector-docked');
    await expect(page.locator('#inspector-drawer [data-batch-id]')).toHaveCount(0);
    await page.keyboard.press('ArrowUp');
    await expectBatchInspector(page);
    // Down to the next row and back with the panel's own controls.
    await page.locator('#inspector-drawer button[aria-label="Next request"]').click();
    await expect(page.locator('#inspector-drawer [data-batch-id]')).toHaveCount(0);
    await page.locator('#inspector-drawer button[aria-label="Previous request"]').click();
    await expectBatchInspector(page);
  });
});

test.describe('the sheet head fits its controls (task 4.3)', () => {
  // Previous / Next add 104px to the head's right-hand cluster under a coarse pointer or below
  // narrow. A single non-wrapping row squeezed the title to a sliver and pushed Close past the
  // sheet's edge for a verbatim (free-form) status word, so the head wraps instead.
  for (const vp of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
  ]) {
    for (const word of ['OK · served', 'Cancelled · client', 'rate_limited_upstream_exceeded']) {
      test(`${String(vp.width)}px, badge "${word}": every head control lies inside the sheet's content box`, async ({
        page,
      }) => {
        await page.setViewportSize(vp);
        await page.goto('/browser-harness.html#/requests');
        await page.waitForSelector('html[data-harness-ready="true"]');
        await page.waitForSelector('.rs-table-requests button.req-row');
        await rows(page).first().click();
        await panel(page).locator('.rs-inspector-step').first().waitFor({ state: 'visible' });
        await page.evaluate(() =>
          Promise.all(
            (document.getElementById('inspector-drawer')?.getAnimations() ?? []).map(
              (a) => a.finished,
            ),
          ),
        );
        // The badge word is the one free-form input of the head: set it to the case under test.
        await page.evaluate((w) => {
          const badge = document.querySelector('#inspector-drawer .drawer-head .chip');
          if (badge) badge.textContent = w;
          // And the title: a long dated model id, the shape real rows carry.
          const title = document.querySelector('#inspector-drawer .drawer-head .mono');
          if (title) title.textContent = 'claude-sonnet-4-5-20250929';
        }, word);
        const m = await page.evaluate(() => {
          const head = document.querySelector<HTMLElement>('#inspector-drawer .drawer-head')!;
          const cs = getComputedStyle(head);
          const hr = head.getBoundingClientRect();
          const box = {
            left: hr.left + parseFloat(cs.paddingLeft),
            right: hr.right - parseFloat(cs.paddingRight),
          };
          const controls = [
            '.chip',
            '.rs-inspector-step[aria-label="Previous request"]',
            '.rs-inspector-step[aria-label="Next request"]',
            '.drawer-close',
          ].map((sel) => {
            const r = head.querySelector(sel)!.getBoundingClientRect();
            return { sel, left: r.left, right: r.right };
          });
          const title = head.firstElementChild!.getBoundingClientRect();
          return { box, controls, titleWidth: title.width };
        });
        for (const c of m.controls) {
          expect(c.left, `${c.sel} starts before the head's content box`).toBeGreaterThanOrEqual(
            m.box.left - 0.5,
          );
          expect(c.right, `${c.sel} ends past the head's content box`).toBeLessThanOrEqual(
            m.box.right + 0.5,
          );
        }
        // The title keeps its column: the head wraps rather than squeezing it to a sliver.
        // (Unwrapped, the same head measured 83-171px; wrapped, the title's whole 230px.)
        expect(m.titleWidth, 'the title was squeezed').toBeGreaterThan(200);
      });
    }
  }
});
