/** Responsive layout, measured in a real browser (group 8).
 *
 * The unit suites assert DECLARATIONS because happy-dom performs no layout. These assert
 * the actual rendered result: that no page overflows its root at any locked viewport, that
 * in-flow content stays inside its pane, that hit targets meet their floor, and that every
 * destination stays reachable at phone width.
 *
 * The fixture (`src/browserHarness.tsx`) mounts the real App against `FakeApiClient` with
 * adversarial content — a 26-character model id, a 50-character email — because short
 * placeholder data would make every overflow assertion pass for the wrong reason.
 */
import { assertBetween, assertWithin } from './geometry-contract';
import { expect, test, type Page } from '@playwright/test';

/** The locked verification matrix (STYLESEED.md § Responsive). Dimensions, not widths:
 * a short viewport is what proves the account menu stays reachable. */
const MATRIX = [
  { name: '320x568', width: 320, height: 568 }, // WCAG 2.2 reflow reference width
  { name: '390x844', width: 390, height: 844 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '1025x768', width: 1025, height: 768 },
  { name: '1440x900', width: 1440, height: 900 },
] as const;

const PAGES = [
  'overview',
  'requests',
  // The widest table in the app (ten columns). It joins the all-page sweeps rather than
  // getting a bespoke overflow test, because the sweeps are the ones that would actually
  // catch a tenth column shipping without a reflow.
  'batches',
  'costs',
  'agents',
  'providers',
  'routing',
  'limits',
  'settings',
  'users',
  'setup',
] as const;

async function open(page: Page, hash = '', query = ''): Promise<void> {
  await page.goto(`/browser-harness.html${query}${hash}`);
  await page.waitForSelector('html[data-harness-ready="true"]');
  await page.waitForSelector('[data-pane="sidebar"]');
}

/** The Routing page's two tabs (redesign-auto-routing-pipeline D1–D3), in the order the
 * tab control offers them. */
const ROUTING_TABS = ['Tiers & headers', 'Auto routing'] as const;
type RoutingTab = (typeof ROUTING_TABS)[number];

/** The five stages with a detail — every stage except Confident band, which links to the
 * Targets matrix instead (D8). */
const EXPANDABLE_STAGES = ['Classify', 'Workload claim', 'Semantic', 'Cascade', 'Default'] as const;
type StageName = (typeof EXPANDABLE_STAGES)[number];

/** Switch the Routing page to a tab. Each tab MOUNTS AND UNMOUNTS with the switch (D4),
 * so a test asserting on Auto routing content must switch first — otherwise it fails as
 * a `waitForSelector` TIMEOUT on an element that is simply not in the DOM, which reads
 * like flake and is not. Scoped to the tab control's own group, so it can never hit the
 * range selector, which is the same `Segmented` control. */
async function openRoutingSection(page: Page, label: RoutingTab): Promise<void> {
  const seg = page
    .locator('[data-testid="routing-sections"] .rs-seg')
    .filter({ hasText: new RegExp(`^${label}$`) });
  await seg.waitFor({ state: 'visible' });
  await seg.click();
  await expect(seg, `Routing tab "${label}" did not become active`).toHaveAttribute(
    'aria-pressed',
    'true',
  );
}

/** Open one stage's detail on the Auto routing tab and wait for it to render. Stages
 * start collapsed and their details mount only when opened, so a test reading a
 * detail's content must expand it first. */
async function expandStage(page: Page, name: StageName): Promise<void> {
  const btn = page.locator(`button.ar-expander[aria-label="${name} details"]`);
  await btn.waitFor({ state: 'visible' });
  if ((await btn.getAttribute('aria-expanded')) !== 'true') await btn.click();
  await expect(btn, `stage "${name}" did not expand`).toHaveAttribute('aria-expanded', 'true');
  const id = await btn.getAttribute('aria-controls');
  expect(id, `stage "${name}" names no detail`).not.toBeNull();
  await page.locator(`[id="${id ?? ''}"]`).waitFor({ state: 'visible' });
}

/** Open every stage's detail, asserting there are EXACTLY five expanders. The count is
 * the point: the sweeps only measure rendered DOM, so a stage that lost its expander —
 * or a sweep that quietly stopped expanding — would otherwise shrink the measured
 * surface and still report green. */
async function expandAllStages(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="pipeline-stage"]');
  const expanders = page.locator('button.ar-expander');
  await expect(
    expanders,
    'Auto routing must offer exactly five stage expanders — the sweep would otherwise measure a collapsed tab',
  ).toHaveCount(EXPANDABLE_STAGES.length);
  for (const name of EXPANDABLE_STAGES) await expandStage(page, name);
  await expect(page.locator('[data-testid="stage-detail"]')).toHaveCount(EXPANDABLE_STAGES.length);
  // Measure settled figures, not the loading placeholders a detail shows first.
  await expect(page.locator('[data-testid="detail-loading"]')).toHaveCount(0);
}

/** Every distinct rendered state of a page that the all-page sweeps must measure.
 * Only `routing` has more than one: its tabs (redesign-auto-routing-pipeline) unmount
 * whichever one is not shown, and Auto routing's stage details mount only when opened.
 * A sweep that measured only what `goto` paints would silently shrink to Tiers &
 * headers — no pipeline, no stage detail, no Targets matrix — which is exactly the
 * failure the comfort-target sweep exists to prevent. So every tab is visited, and on
 * Auto routing every stage is expanded. Yields a label per state, with the page
 * already switched to it. */
async function* pageStates(page: Page, name: string): AsyncGenerator<string> {
  // Routing runs on `?semantic=1` (split-auto-routing-readout-setup): the semantic layer
  // effective, so its Semantic learning drawer can open and be measured too.
  await page.goto(`/browser-harness.html${name === 'routing' ? '?semantic=1' : ''}#/${name}`);
  await page.waitForSelector('html[data-harness-ready="true"]');
  const sections: string[] = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="routing-sections"] .rs-seg')].map((b) =>
      (b.textContent ?? '').trim(),
    ),
  );
  if (name !== 'routing') {
    expect(sections, `${name} unexpectedly renders the Routing tab control`).toEqual([]);
    yield name;
    return;
  }
  // Not a silent fallback: if the tab control's testid or labels change, the sweeps
  // would quietly go back to measuring the landing tab alone and still report green —
  // the exact vacuous pass this generator exists to prevent.
  expect(sections, 'the Routing tab control does not offer both tabs').toEqual([...ROUTING_TABS]);
  for (const label of ROUTING_TABS) {
    await openRoutingSection(page, label);
    if (label === 'Auto routing') await expandAllStages(page);
    yield `${name}/${label}`;
    if (label !== 'Auto routing') continue;
    // The tuning drawers mount only when opened — measure each, then close it.
    for (const drawer of ['calibration', 'learning'] as const) {
      await page.locator(`[data-testid="tuning-entry"][data-tuning="${drawer}"]`).click();
      await page
        .locator(`[data-testid="tuning-drawer"][data-tuning="${drawer}"]`)
        .waitFor({ state: 'visible' });
      await page.waitForTimeout(250); // the entrance transform, as the overlay suites wait
      yield `${name}/${label}/drawer:${drawer}`;
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-testid="tuning-drawer"]')).toHaveCount(0);
    }
  }
}

for (const vp of MATRIX) {
  test.describe(`viewport ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('no page overflows the document horizontally', async ({ page }) => {
      await open(page);
      for (const name of PAGES) {
        for await (const state of pageStates(page, name)) {
          const overflow = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
          }));
          expect(
            overflow.scrollWidth,
            `${state} overflows at ${vp.name} (${String(overflow.scrollWidth)} > ${String(overflow.clientWidth)})`,
          ).toBeLessThanOrEqual(overflow.clientWidth + 1);
        }
      }
    });

    test('in-flow content stays inside its pane, on every page', async ({ page }) => {
      for (const name of PAGES) {
        for await (const state of pageStates(page, name)) {
          const escapes = await page.evaluate(() => {
            const pane = document.querySelector('[data-pane="content"]');
            if (!pane) return ['no content pane'];
            const bounds = pane.getBoundingClientRect();
            const out: string[] = [];
            for (const el of pane.querySelectorAll('*')) {
              const s = getComputedStyle(el);
              if (s.position === 'fixed' || s.position === 'absolute') continue;
              const r = el.getBoundingClientRect();
              if (r.width === 0) continue;
              if (r.right > bounds.right + 1) {
                const cls = el.className.toString().trim();
                const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 30);
                out.push(
                  `${el.tagName}${cls ? '.' + cls.split(/\s+/).join('.') : ''}` +
                    ` over=${String(Math.round(r.right - bounds.right))}px text="${text}"`,
                );
              }
            }
            return out.slice(0, 5);
          });
          expect(escapes, `content escaping its pane on ${state} at ${vp.name}`).toEqual([]);
        }
      }
    });
  });
}

test.describe('phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('every destination is reachable in one of the two rail states', async ({ page }) => {
    await open(page);
    const toggle = page.locator('.rs-nav-toggle');
    await expect(toggle).toBeVisible();

    // `toBeVisible()` is not enough, and this is not hypothetical: the toggle once
    // rendered at x=47..71 inside a rail ending at 56 — a non-empty box, so "visible",
    // but clipped and untappable, which made the expanded nav (and with it the account
    // menu) unreachable. Containment is the property that actually matters.
    const fits = await page.evaluate(() => {
      const t = document.querySelector('.rs-nav-toggle')?.getBoundingClientRect();
      const r = document.querySelector('[data-pane="sidebar"]')?.getBoundingClientRect();
      if (!t || !r) return null;
      return { toggleRight: Math.round(t.right), railRight: Math.round(r.right) };
    });
    expect(fits).not.toBeNull();
    expect(
      fits?.toggleRight,
      'the rail toggle renders outside the rail and cannot be tapped',
    ).toBeLessThanOrEqual((fits?.railRight ?? 0) + 1);

    await toggle.click();
    const items = page.locator('#sidebar-nav .nav-item');
    const names = await items.allTextContents();
    for (const expected of ['Overview', 'Requests', 'Costs', 'Agents', 'Settings', 'Users']) {
      expect(names.join(' '), `${expected} unreachable at phone width`).toContain(expected);
    }
    // The account menu and setup guide live in the expanded state — the shell contract
    // requires them to stay reachable somewhere.
    await expect(page.locator('.rs-sidebar-footer')).toBeVisible();
  });

  test('the account footer stays on screen however long the nav gets', async ({ page }) => {
    // A regression guard with a known cause: adding the Batches page made the expanded
    // nav taller than a 320x568 screen, and the footer — the only route to Settings, the
    // theme toggle, Users and Log out — fell below the fold. It was still reachable by
    // scrolling, so `toBeVisible()` passed; the account menu, which opens upward from a
    // trigger inside it, rendered off-screen. Pinning the footer makes nav length
    // irrelevant, and this measures that rather than the current page count.
    await page.setViewportSize({ width: 320, height: 568 });
    await open(page);
    await page.locator('.rs-nav-toggle').click();
    await page.waitForTimeout(250);
    const box = await page
      .locator('.rs-sidebar-footer')
      .evaluate((el) => el.getBoundingClientRect().toJSON() as { top: number; bottom: number });
    expect(box.top, 'the account footer starts below the fold').toBeLessThan(568);
    expect(box.bottom, 'the account footer runs past the bottom of the screen').toBeLessThanOrEqual(
      568.5,
    );
  });

  test('the collapsed rail keeps the group names for assistive technology, and rules the groups apart (task 11.1)', async ({
    page,
  }) => {
    await open(page);
    // Each group is still named: a clipped label is in the accessibility tree.
    for (const name of ['Observe', 'Configure', 'Admin'])
      await expect(page.getByRole('group', { name, exact: true })).toHaveCount(1);
    const rail = await page.evaluate(() => {
      const groups = [...document.querySelectorAll<HTMLElement>('#sidebar-nav .nav-group')];
      return groups.map((g) => {
        const label = g.querySelector<HTMLElement>('.nav-group-label');
        const lr = label?.getBoundingClientRect();
        const cs = getComputedStyle(g);
        return {
          label: lr
            ? { w: lr.width, h: lr.height, display: getComputedStyle(label!).display }
            : null,
          ruleTop: `${cs.borderTopWidth} ${cs.borderTopStyle}`,
          ruleColor: cs.borderTopColor,
          border2: getComputedStyle(document.documentElement).getPropertyValue('--border2').trim(),
        };
      });
    });
    expect(rail).toHaveLength(3);
    for (const g of rail) {
      // Hidden visually only: clipped to 1px, never `display:none` (which would drop the name).
      expect(g.label).not.toBeNull();
      expect(g.label!.display).not.toBe('none');
      expect(g.label!.w).toBeLessThanOrEqual(1);
      expect(g.label!.h).toBeLessThanOrEqual(1);
    }
    // A Soft Hairline above every group but the first.
    expect(rail.map((g) => g.ruleTop)).toEqual(['0px none', '1px solid', '1px solid']);
    const hex = (rgb: string): string =>
      `#${(rgb.match(/\d+/g) ?? [])
        .slice(0, 3)
        .map((n) => Number(n).toString(16).padStart(2, '0'))
        .join('')}`;
    expect(hex(rail[1]!.ruleColor)).toBe(rail[1]!.border2.toLowerCase());
  });

  test('the rail reclaims the viewport when collapsed', async ({ page }) => {
    await open(page);
    const width = await page
      .locator('[data-pane="sidebar"]')
      .evaluate((el) => el.getBoundingClientRect().width);
    // 208px would be 53% of a 390px screen; the locked rail is 56px.
    expect(width).toBeLessThanOrEqual(60);
  });

  test('the requests table renders as stacked records, not a 9-column grid', async ({ page }) => {
    await open(page, '#/requests');
    const shape = await page.evaluate(() => {
      const row = document.querySelector('.req-row');
      const head = document.querySelector('.table-head');
      const label = document.querySelector('.rs-cell-label');
      return {
        row: row ? getComputedStyle(row).display : null,
        head: head ? getComputedStyle(head).display : null,
        label: label ? getComputedStyle(label).display : null,
      };
    });
    expect(shape.row).toBe('block');
    expect(shape.head).toBe('none');
    expect(shape.label).not.toBe('none');
  });

  test('the agent run boundary survives the stacked reflow (add-agent-request-attribution)', async ({
    page,
  }) => {
    await open(page, '#/requests');
    const panel = await page
      .locator('.rs-table-requests')
      .evaluate((el) => el.getBoundingClientRect().width);
    const boundaries = page.locator('.rs-agent-boundary');
    expect(await boundaries.count(), 'no agent boundary rendered at all').toBeGreaterThan(0);

    const first = boundaries.first();
    // Still laid out (a stacked record must not collapse its own group label) …
    await expect(first).toBeVisible();
    const box = await first.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height, display: getComputedStyle(el).display };
    });
    expect(box.height, 'the boundary collapsed to zero height when stacked').toBeGreaterThan(0);
    // … and it cannot be what makes the table overflow: it is a sibling block, not a
    // participant in `.req-row`'s grid, so it can never be wider than the panel.
    expect(box.width).toBeLessThanOrEqual(panel + 0.5);
    // It must carry TEXT, not a decorative mark alone.
    expect((await first.textContent())?.trim().length ?? 0).toBeGreaterThan(0);

    // Between stacked records, as an overline label over a rule with no fill
    // (adopt-design-tokens-v2 task 9.3): each boundary that follows a record sits after a
    // stacked row and before one, and none paints a band.
    const placed = await boundaries.evaluateAll((els) =>
      els.map((el) => {
        const prev = el.previousElementSibling;
        const next = el.nextElementSibling;
        const stacked = (e: Element | null): boolean =>
          e !== null && e.classList.contains('req-row') && getComputedStyle(e).display === 'block';
        const cs = getComputedStyle(el);
        return {
          text: (el.textContent ?? '').trim(),
          afterRecord: stacked(prev),
          beforeRecord: stacked(next),
          fill: cs.backgroundColor,
          rule: `${cs.borderBottomStyle} ${cs.borderBottomWidth}`,
        };
      }),
    );
    expect(
      placed.every((b) => b.beforeRecord),
      'a boundary not followed by its record',
    ).toBe(true);
    expect(
      placed.some((b) => b.afterRecord),
      'no boundary sits between two stacked records',
    ).toBe(true);
    for (const b of placed) {
      expect(b.fill, `"${b.text}" paints a band`).toBe('rgba(0, 0, 0, 0)');
      expect(b.rule, `"${b.text}" has no rule under it`).toBe('solid 1px');
    }
  });

  test('the batches table renders as stacked records, not a 10-column grid', async ({ page }) => {
    await open(page, '#/batches');
    const shape = await page.evaluate(() => {
      const row = document.querySelector('.rs-batch-row');
      const head = document.querySelector('.rs-table-batches .table-head');
      const label = document.querySelector('.rs-batch-row .rs-cell-label');
      const terminalAction = document
        .querySelector('[data-batch-job="bj-done"]')
        ?.querySelector('.rs-cell:last-child');
      return {
        row: row ? getComputedStyle(row).display : null,
        head: head ? getComputedStyle(head).display : null,
        label: label ? getComputedStyle(label).display : null,
        // A finished job offers no Cancel, so its action cell holds only its own empty
        // label. Stacked, that would close every completed record with a blank strip.
        terminalAction: terminalAction ? getComputedStyle(terminalAction).display : null,
      };
    });
    expect(shape.row).toBe('block');
    expect(shape.head).toBe('none');
    expect(shape.label).not.toBe('none');
    expect(shape.terminalAction).toBe('none');
  });

  test('every rendered control meets the comfort target, on every page', async ({ page }) => {
    // Identified SEMANTICALLY, not by a class list. The earlier version checked six
    // hand-picked classes on one page and passed while bare `<button>`/`<select>` controls
    // with inline padding shipped at 22-28px — a class list can only ever cover controls
    // somebody remembered to class.
    for (const name of PAGES) {
      for await (const state of pageStates(page, name)) {
        const small = await page.evaluate(() => {
          const out: string[] = [];
          for (const el of document.querySelectorAll<HTMLElement>(
            'button, a[href], input, select, textarea, [role="menuitem"]',
          )) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue; // not rendered in this state
            // Locked exceptions (STYLESEED.md): the switch keeps its 32x18 drawn track and meets
            // the floor through an expanded hit area, asserted separately below; checkboxes
            // and radios would be stretched rather than given a bigger tap area.
            if (el.classList.contains('toggle')) continue;
            if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio'))
              continue;
            if (r.height < 44) {
              out.push(
                `${el.tagName}.${el.className.toString().split(/\s+/)[0] ?? ''}` +
                  ` ${String(Math.round(r.width))}x${String(Math.round(r.height))}`,
              );
            }
          }
          return out;
        });
        expect(small, `controls under the comfort target on ${state}`).toEqual([]);
      }
    }
  });

  test('icon-only controls meet the floor in BOTH axes', async ({ page }) => {
    // A minimum target is two-dimensional. These have no text to widen them — the rail
    // toggle shipped at 24x44 before this was checked.
    await open(page, '#/routing');
    const narrow = await page.evaluate(() => {
      const out: string[] = [];
      for (const sel of ['.rs-nav-toggle', '.icon-x', '.drag-handle', '.drawer-close']) {
        for (const el of document.querySelectorAll<HTMLElement>(sel)) {
          const r = el.getBoundingClientRect();
          if (r.width === 0) continue;
          if (r.width < 44) out.push(`${sel} w=${String(Math.round(r.width))}`);
        }
      }
      return out;
    });
    expect(narrow, 'icon-only controls under the inline-axis floor').toEqual([]);
  });

  test('the switch meets the floor by hit area, not by its box', async ({ page }) => {
    // Its 32x18 drawn track is locked design. Conformance therefore has to be established by
    // hit-testing — measuring the rectangle would report a false failure.
    //
    // The auto-layer switches live in the Auto routing tab's Setup panel, which a visit
    // does not land on — so the tab is opened first and the switch is taken from the Layers
    // cells, never "the first `.toggle` on the page", which on Tiers & headers is not a
    // layer switch.
    await open(page, '#/routing');
    await openRoutingSection(page, 'Auto routing');
    const sw = page.locator('[data-testid="auto-layers"] .toggle').first();
    await sw.waitFor({ state: 'visible' });
    await sw.scrollIntoViewIfNeeded();
    const hit = await page.evaluate(() => {
      const t = document.querySelector('[data-testid="auto-layers"] .toggle');
      if (!t) return null;
      const r = t.getBoundingClientRect();
      const owns = (dx: number, dy: number): boolean => {
        const el = document.elementFromPoint(r.left + r.width / 2 + dx, r.top + r.height / 2 + dy);
        return el === t || t.contains(el as Node);
      };
      return { above: owns(0, -18), below: owns(0, 18), right: owns(20, 0) };
    });
    expect(hit).not.toBeNull();
    expect(hit?.above, 'switch hit area does not extend above its box').toBe(true);
    expect(hit?.below, 'switch hit area does not extend below its box').toBe(true);
    expect(hit?.right, 'switch hit area does not extend beside its box').toBe(true);
  });

  test('expanding the nav then leaving narrow width does not strand the dashboard', async ({
    page,
  }) => {
    // The production lock-up: above 768px the toggle is display:none, so an expanded nav
    // that survives a resize leaves a full-screen scrim over inert content with nothing
    // able to dismiss it. Rotating a phone to landscape is enough to reach it.
    await open(page);
    await page.locator('.rs-nav-toggle').click();
    await expect(page.locator('.rs-nav-scrim')).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(150);

    await expect(page.locator('.rs-nav-scrim')).toHaveCount(0);
    const inert = await page.evaluate(() =>
      document.querySelector('[data-pane="content"]')?.hasAttribute('inert'),
    );
    expect(inert, 'the content pane is still inert after leaving narrow width').toBe(false);
  });
});

test.describe('coarse pointer above the narrow threshold', () => {
  // A 1024px tablet is touch-first but nowhere near `narrow` — the branch that exists
  // solely for this case would otherwise never be exercised.
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true });

  test('controls still meet the comfort target', async ({ page }) => {
    await open(page, '#/agents');
    const heights = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.btn-ghost')]
        .map((el) => el.getBoundingClientRect().height)
        .filter((h) => h > 0),
    );
    expect(heights.length).toBeGreaterThan(0);
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
  });
});

/** The readout strip's cells as laid out: id, box, and the figure's computed size. */
async function readoutCells(page: Page): Promise<
  {
    id: string | null;
    left: number;
    right: number;
    top: number;
    bottom: number;
    figure: string;
    ruleLeft: string;
    ruleTop: string;
  }[]
> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-readout-strip] [data-readout]')].map((c) => {
      const r = c.getBoundingClientRect();
      const fig = c.querySelector('.readout-figure');
      const cs = getComputedStyle(c);
      return {
        id: c.getAttribute('data-readout'),
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        figure: fig ? getComputedStyle(fig).fontSize : '',
        ruleLeft: `${cs.borderLeftWidth} ${cs.borderLeftStyle}`,
        ruleTop: `${cs.borderTopWidth} ${cs.borderTopStyle}`,
      };
    }),
  );
}

/** The readout strip (dashboard-analytics "Overview and Costs state their headline figures in
 * one readout strip", scenario "The strip reflows at narrow width"; adopt-design-tokens-v2
 * tasks 12.1 / 12.2). At 320 × 568 the cells stack, focal first, and nothing overflows; at
 * desktop they sit side by side in one panel, ruled apart by a Soft Hairline. Box edges are
 * compared with a 0.5px sub-pixel allowance: a stacking order and a containment, not a size. */
test.describe('the readout strip', () => {
  // Costs with `?costs=split`: subscription, estimate-priced and pre-snapshot spend at once, so
  // the strip holds all three cells and its longest qualification.
  for (const [route, query, count] of [
    ['#/overview', '', 4],
    ['#/costs', '?costs=split', 3],
  ] as const) {
    test(`${route}${query} at 320x568: the cells stack focal first, and nothing overflows`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 320, height: 568 });
      await open(page, route, query);
      await page.waitForSelector('[data-readout-strip] [data-readout]');
      const cells = await readoutCells(page);
      expect(cells.length, 'every cell is present').toBe(count);
      expect(cells[0]!.id, 'the focal cell comes first').toBe('spend');
      expect(cells[0]!.figure, 'and holds the Display figure').toBe('26px');
      for (let i = 1; i < cells.length; i++) {
        expect(
          cells[i]!.top,
          `${cells[i]!.id ?? ''} wraps below the cell before it`,
        ).toBeGreaterThanOrEqual(cells[i - 1]!.bottom - 0.5);
        expect(cells[i]!.ruleTop, `${cells[i]!.id ?? ''} is ruled from the cell above`).toBe(
          '1px solid',
        );
      }
      const box = await page.evaluate(() => {
        const s = document.querySelector('[data-readout-strip]')!.getBoundingClientRect();
        return {
          left: s.left,
          right: s.right,
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          mainOverflow: (() => {
            const m = document.querySelector('main')!;
            return m.scrollWidth - m.clientWidth;
          })(),
        };
      });
      for (const c of cells) {
        expect(c.left, `${c.id ?? ''} starts inside the strip`).toBeGreaterThanOrEqual(
          box.left - 0.5,
        );
        expect(c.right, `${c.id ?? ''} ends inside the strip`).toBeLessThanOrEqual(box.right + 0.5);
      }
      expect(box.scrollWidth, `${route} overflows at 320x568`).toBeLessThanOrEqual(box.clientWidth);
      expect(box.mainOverflow, `${route}'s page pane scrolls sideways`).toBeLessThanOrEqual(0);
    });
  }

  test('#/overview at 1440x900: one row of cells in one panel, ruled apart', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, '#/overview');
    await page.waitForSelector('[data-readout-strip] [data-readout]');
    const cells = await readoutCells(page);
    expect(cells.map((c) => [c.id, c.figure])).toEqual([
      ['spend', '26px'],
      ['requests', '15px'],
      ['tokens', '15px'],
      ['success', '15px'],
    ]);
    for (const c of cells)
      expect(Math.abs(c.top - cells[0]!.top), `${c.id ?? ''} on the row`).toBeLessThan(0.5);
    expect(cells.map((c) => c.ruleLeft)).toEqual([
      '0px none',
      '1px solid',
      '1px solid',
      '1px solid',
    ]);
  });
});

test.describe('non-admin at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('cannot reach the admin-only Users area', async ({ page }) => {
    await open(page, '', '?role=member');
    await page.locator('.rs-nav-toggle').click();
    const names = await page.locator('#sidebar-nav .nav-item').allTextContents();
    expect(names.join(' ')).not.toContain('Users');
  });
});

/** Hit-tests one switch: which of the given offsets from its track's edges still resolve to
 * it. `above`/`below` are measured from the drawn track's top and bottom edges, `side` from
 * its centre. Scrolled into view first: `elementFromPoint` is viewport-relative. */
async function switchHits(
  page: Page,
  sel: string,
  probes: { name: string; dx: number; dy: number; from: 'top' | 'bottom' | 'centre' }[],
): Promise<{ track: { w: number; h: number }; hits: Record<string, boolean> }> {
  return page.evaluate(
    ({ sel, probes }) => {
      const t = document.querySelector<HTMLElement>(sel);
      if (!t) throw new Error(`${sel} not rendered`);
      t.scrollIntoView({ block: 'center' });
      const r = t.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const hits: Record<string, boolean> = {};
      for (const p of probes) {
        const y =
          p.from === 'top'
            ? r.top + p.dy
            : p.from === 'bottom'
              ? r.bottom + p.dy
              : r.top + r.height / 2 + p.dy;
        const el = document.elementFromPoint(cx + p.dx, y);
        hits[p.name] = el === t || t.contains(el);
      }
      return { track: { w: r.width, h: r.height }, hits };
    },
    { sel, probes },
  );
}

test.describe('the switch reaches its floor by hit area (task 5.2, design.md D3)', () => {
  // The Layers cells' switches, on the Auto routing tab.
  const SWITCH = '[data-testid="auto-layers"] .toggle';

  test.describe('desktop width, fine pointer', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('a point 2px above or below the drawn track still activates it', async ({ page }) => {
      await open(page, '#/routing');
      await openRoutingSection(page, 'Auto routing');
      await page.locator(SWITCH).first().waitFor({ state: 'visible' });
      // The app renders the small size; the hit area is 24px tall at both sizes, so the
      // medium 20px track is measured too, on the same rendered switch.
      for (const size of ['toggle--sm', 'toggle--md'] as const) {
        await page.evaluate(
          ({ sel, size }) => {
            const t = document.querySelector(sel);
            t?.classList.remove('toggle--sm', 'toggle--md');
            t?.classList.add(size);
          },
          { sel: SWITCH, size },
        );
        const { track, hits } = await switchHits(page, SWITCH, [
          { name: '2px above', dx: 0, dy: -2, from: 'top' },
          // A half-open box: the last pixel row 2px below a 20px track is centred 1.5px out.
          { name: '2px below', dx: 0, dy: 1.5, from: 'bottom' },
          // Bounded: the desktop hit area is the 24px floor, not the 44px comfort target.
          { name: '13px above centre', dx: 0, dy: -13, from: 'centre' },
          { name: '13px below centre', dx: 0, dy: 13, from: 'centre' },
        ]);
        // EXACT: a fixed size (geometry-contract.ts).
        expect(track, `${size} drawn track`).toEqual(
          size === 'toggle--md' ? { w: 36, h: 20 } : { w: 32, h: 18 },
        );
        expect(hits['2px above'], `${size}: 2px above the track`).toBe(true);
        expect(hits['2px below'], `${size}: 2px below the track`).toBe(true);
        expect(hits['13px above centre'], `${size}: beyond the 24px hit area`).toBe(false);
        expect(hits['13px below centre'], `${size}: beyond the 24px hit area`).toBe(false);
      }
    });
  });

  test.describe('coarse pointer above narrow', () => {
    test.use({ viewport: { width: 1440, height: 900 }, hasTouch: true });

    test('the hit area is 44 x 44 while the drawn track stays 32 x 18', async ({ page }) => {
      await open(page, '#/routing');
      await openRoutingSection(page, 'Auto routing');
      await page.locator(SWITCH).first().waitFor({ state: 'visible' });
      const corners = [-21.5, 21.5].flatMap((dx) =>
        [-21.5, 21.5].map((dy) => ({
          name: `${String(dx)},${String(dy)}`,
          dx,
          dy,
          from: 'centre' as const,
        })),
      );
      const { track, hits } = await switchHits(page, SWITCH, [
        ...corners,
        { name: 'outside', dx: 0, dy: 22.5, from: 'centre' },
      ]);
      expect(track).toEqual({ w: 32, h: 18 });
      for (const c of corners)
        expect(hits[c.name], `corner ${c.name} of the 44x44 area`).toBe(true);
      expect(hits['outside'], 'the hit area stops at 44px').toBe(false);
    });
  });
});

test.describe('desktop width, fine pointer', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('every control meets the 24px floor at desktop width', async ({ page }) => {
    // Added with narrow-geometry-tolerances, and it closes a PRE-EXISTING gap rather than
    // only replacing what left the parity set.
    //
    // STYLESEED.md locks `target-base` at 24px in BOTH axes as the "minimum hit target at
    // EVERY width (WCAG 2.5.8 AA)" — but every comprehensive floor assertion above runs
    // inside `phone width` at 390x844, and the only other one runs at 1024x768 with
    // `hasTouch` against `.btn-ghost` alone. At 1440x900 with a fine pointer, nothing
    // enforced the floor at all. `.endpoint-chip`'s entry in the v0.11.0 parity set was
    // incidentally its only height assertion here, so removing it without this would have
    // deleted coverage.
    //
    // 24, not the 44px comfort target: 44 is `target-comfort`, which the lock scopes to
    // below `narrow` and to coarse pointers. Desktop with a mouse is held to the base floor.
    //
    // Every rendered state, as the phone sweep does: Routing lands on Tiers & headers, so
    // a plain `goto` would never measure the pipeline, its stage details or the Targets
    // matrix's pickers at desktop width.
    for (const name of PAGES) {
      for await (const state of pageStates(page, name)) {
        const small = await page.evaluate(() => {
          const out: string[] = [];
          // Semantic, matching the phone-width test — a class list only ever covers controls
          // somebody remembered to class.
          for (const el of document.querySelectorAll<HTMLElement>(
            'button, a[href], input, select, textarea, [role="menuitem"]',
          )) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue; // not rendered in this state
            // The same locked exceptions the phone-width assertion carries.
            if (el.classList.contains('toggle')) continue;
            if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio'))
              continue;
            if (r.height < 24 || r.width < 24) {
              out.push(
                `${el.tagName}.${el.className.toString().split(/\s+/)[0] ?? ''}` +
                  ` ${String(Math.round(r.width))}x${String(Math.round(r.height))}`,
              );
            }
          }
          return out;
        });
        expect(small, `controls under the 24px base floor on ${state} at desktop width`).toEqual(
          [],
        );
      }
    }
  });

  test('controls stay under a ceiling as well as over the floor', async ({ page }) => {
    // The hole this closes: `.endpoint-chip` LEFT the exact parity set in
    // narrow-geometry-tolerances (correctly — the glyph change deliberately
    // altered it), and its 24px floor above was added to replace the coverage.
    // But a floor only catches a collapse. A height BLOW-OUT — a stray line-height,
    // a wrapped label, a padding regression — passes both the floor and the
    // parity set's silence, which is no coverage at all in that direction.
    //
    // STRUCTURAL, not a restored number (geometry-contract.ts): the chip's height
    // is text-driven, and re-pinning it is exactly what caused the v0.12.0 CI
    // failure. The ceiling is a "this is still one line of chrome" bound, wide
    // enough that no legitimate rasteriser difference reaches it — macOS renders
    // 28 and Linux 27 — and narrow enough that a second line (~50+) cannot hide.
    const CEILING = 40;
    // `.btn-primary` is here for the same reason and was in the same state: the
    // semantic floor test covers it from below, nothing covered it from above,
    // and it was the OTHER value collected across the bridge and discarded.
    const SELECTORS = ['.endpoint-chip', '.btn-primary'] as const;
    const seen = new Map<string, number>();

    for (const name of PAGES) {
      await page.goto(`/browser-harness.html#/${name}`);
      await page.waitForSelector('html[data-harness-ready="true"]');
      for (const sel of SELECTORS) {
        const heights = await page.evaluate(
          (s) =>
            [...document.querySelectorAll(s)]
              .map((e) => e.getBoundingClientRect().height)
              .filter((h) => h > 0)
              .map((h) => Math.round(h)),
          sel,
        );
        for (const h of heights) {
          assertBetween(h, 24, CEILING, `${sel} height on ${name}`);
        }
        seen.set(sel, (seen.get(sel) ?? 0) + heights.length);
      }
    }

    // Not vacuous: a selector that never rendered anywhere would otherwise let
    // this test pass while asserting nothing, which is the exact failure mode
    // that left these two controls uncovered in the first place.
    for (const sel of SELECTORS) {
      expect(
        seen.get(sel) ?? 0,
        `${sel} never rendered on any page — nothing was asserted`,
      ).toBeGreaterThan(0);
    }

    // The chip also stays inside the bar that contains it — a relationship, so
    // it holds whatever the rasteriser does to the text inside it.
    await page.goto('/browser-harness.html#/requests');
    await page.waitForSelector('html[data-harness-ready="true"]');
    await assertWithin(page, '.endpoint-chip', '.rs-topbar');
  });

  test('every batches row lines up with the head, cell edge for cell edge', async ({ page }) => {
    // What D17's `minmax(0, …)` tracks exist for, measured rather than declared. A bare
    // `fr` track takes an implicit `auto` minimum, so ONE unshrinkable cell — the stacked
    // "up to $184.2500 / reserved, not spent", or a 12,500-item count — widens its own
    // track and shifts every column after it. The row then no longer aligns with the head
    // or with its neighbours, which is exactly what the mockup did.
    await open(page, '#/batches');
    const drift = await page.evaluate(() => {
      const table = document.querySelector('.rs-table-batches');
      if (!table) return ['no batches table'];
      // `.rs-cell` is `display: contents` at desktop — it carries no box, so the real grid
      // items are its children, and measuring the wrapper reads 0 for every column.
      const items = (el: Element): Element[] =>
        [...el.children]
          .flatMap((c) => (getComputedStyle(c).display === 'contents' ? [...c.children] : [c]))
          .filter((c) => getComputedStyle(c).display !== 'none');
      const head = table.querySelector('.table-head');
      const rows = [...table.querySelectorAll('.rs-batch-row')];
      if (!head || rows.length === 0) return ['no head or no rows'];
      const want = items(head).map((c) => Math.round(c.getBoundingClientRect().left));
      const out: string[] = [];
      for (const row of rows) {
        const cells = items(row);
        const id = (row as HTMLElement).dataset['batchJob'] ?? '?';
        // A finished job offers no Cancel, so its last cell contributes no item and the
        // row is legitimately short. That is safe only because the gap is TRAILING:
        // auto-placement fills tracks in order, so a gap anywhere earlier would land
        // every later item one track early — which the per-index edge check below
        // catches. A row with MORE items than headers has no such excuse.
        if (cells.length > want.length) {
          out.push(`${id}: ${String(cells.length)} cells vs ${String(want.length)} headers`);
          continue;
        }
        cells.forEach((c, i) => {
          const x = Math.round(c.getBoundingClientRect().left);
          if (Math.abs(x - (want[i] ?? 0)) > 1)
            out.push(`${id} col ${String(i)}: ${String(x)} vs head ${String(want[i] ?? 0)}`);
        });
      }
      return out.slice(0, 8);
    });
    expect(drift, 'batches columns drift between the head and a row').toEqual([]);
  });

  test('a batches cell can shrink inside its column, never widen it', async ({ page }) => {
    // The other half of D17. `minmax(0, …)` pins the TRACK, which is why the edges above
    // line up — but a grid item keeps `min-width: auto` unless told otherwise, and an
    // item wider than its track paints over the next column instead of shrinking. Seven
    // of the ten items read `min-width: auto` until the rule was pointed at the real
    // items rather than at the boxless `.rs-cell` wrapper.
    await open(page, '#/batches');
    const bad = await page.evaluate(() => {
      const out: string[] = [];
      for (const cell of document.querySelectorAll<HTMLElement>('.rs-batch-row > .rs-cell > *')) {
        const s = getComputedStyle(cell);
        if (s.display === 'none') continue;
        if (s.minWidth !== '0px') {
          const text = (cell.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 30);
          out.push(`min-width:${s.minWidth} text="${text}"`);
        }
      }
      return out.slice(0, 8);
    });
    expect(bad, 'a batches grid item can still widen its own column').toEqual([]);
  });
});

/** The desktop shell spaces on the 4px scale (dashboard-core "Spacing comes from the 4px
 * scale", scenario "The desktop shell spaces on the scale"; adopt-design-tokens-v2 task 3.2,
 * design.md D6). Each value is read twice: as the computed declaration, and as the distance
 * between two rendered edges, so a declaration that something else overrides, or a box that
 * adds its own padding, still fails.
 *
 * EXACT, under `geometry-contract.ts`: every distance here is a padding or a gap — the
 * stylesheet decides it, not text layout — so it is font-invariant. The 0.5px allowance is
 * sub-pixel layout rounding, not slack. */
test.describe('the desktop shell spaces on the 4px scale (1440x900)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  /** `b` edge minus `a` edge for the first match of each selector. */
  async function spacing(page: Page): Promise<Record<string, number | string | null>> {
    return page.evaluate(() => {
      const q = (s: string): Element | null => document.querySelector(s);
      const r = (e: Element | null): DOMRect | null => e?.getBoundingClientRect() ?? null;
      const page = q('.rs-page');
      const first = page?.firstElementChild ?? null;
      // The first two in-flow page sections (the page root's children that render a box).
      const sections = [...(page?.children ?? [])].filter(
        (c) => (c as HTMLElement).offsetParent !== null && c.getBoundingClientRect().height > 0,
      );
      // Overview's main/side row: its chart card and the breakdown panel beside it. (The
      // four stat tiles this used to read became the readout strip, task 12.1.)
      const card = q('.rs-grid-main-side > .panel.card');
      const cardChild = card?.firstElementChild ?? null;
      const tiles = [...document.querySelectorAll('.rs-grid-main-side > .panel')];
      const navLabel = q('#sidebar-nav .nav-item-label');
      const navIcon = navLabel?.firstElementChild ?? null;
      const navText = navLabel?.querySelector('.rs-nav-label') ?? null;
      const cs = (e: Element | null, p: string): string | null =>
        e ? getComputedStyle(e).getPropertyValue(p) : null;
      const pr = r(page);
      const fr = r(first);
      const cr = r(card);
      const ccr = r(cardChild);
      return {
        gutterDecl: cs(page, 'padding'),
        gutterInline: pr && fr ? fr.left - pr.left : null,
        gutterBlock: pr && fr ? fr.top - pr.top : null,
        sectionGapDecl: cs(page, 'row-gap'),
        sectionGap:
          sections.length >= 2
            ? sections[1]!.getBoundingClientRect().top - sections[0]!.getBoundingClientRect().bottom
            : null,
        cardDecl: cs(card, 'padding'),
        // The card's border is 1px; its content starts 1px + padding inside the border box.
        cardInline: cr && ccr ? ccr.left - cr.left - 1 : null,
        cardBlock: cr && ccr ? ccr.top - cr.top - 1 : null,
        panelGapDecl: cs(q('.rs-grid-main-side'), 'column-gap'),
        panelGap:
          tiles.length >= 2
            ? tiles[1]!.getBoundingClientRect().left - tiles[0]!.getBoundingClientRect().right
            : null,
        navGapDecl: cs(navLabel, 'column-gap'),
        navGap: navIcon && navText ? r(navText)!.left - r(navIcon)!.right : null,
      };
    });
  }

  test('a 24px gutter, 16px card padding, panels 16px and sections 24px apart, an 8px nav icon gap', async ({
    page,
  }) => {
    await open(page, '#/overview');
    const s = await spacing(page);
    expect(s.gutterDecl, 'the page gutter declaration').toBe('24px');
    expect(s.cardDecl, 'the card padding declaration').toBe('16px');
    expect(s.panelGapDecl, 'the gap between panels').toBe('16px');
    expect(s.sectionGapDecl, 'the gap between page sections').toBe('24px');
    expect(s.navGapDecl, "a nav item's icon-to-label gap").toBe('8px');
    for (const [name, want] of [
      ['gutterInline', 24],
      ['gutterBlock', 24],
      ['cardInline', 16],
      ['cardBlock', 16],
      ['panelGap', 16],
      ['sectionGap', 24],
      ['navGap', 8],
    ] as const) {
      const got = s[name];
      expect(typeof got, `${name} was not measured`).toBe('number');
      expect(
        Math.abs((got as number) - want),
        `${name} is ${String(got)}, not ${String(want)}`,
      ).toBeLessThan(0.5);
    }
  });

  test('every rendered switch track is a 10px capsule (task 3.4)', async ({ page }) => {
    // The Auto routing tab's Setup panel carries the app's switches. A radius of at least
    // half the track's rendered height draws semicircular ends; less leaves a flat. EXACT:
    // the track's size is inline and its radius is the stylesheet's, neither text-driven.
    // Only the small size renders on any page, so `radii.view.test.tsx` covers both sizes.
    await open(page, '#/routing');
    await openRoutingSection(page, 'Auto routing');
    await page.waitForSelector('[data-testid="auto-setup"] [role="switch"]');
    const tracks = await page.evaluate(() =>
      [...document.querySelectorAll('[role="switch"]')]
        .filter((e) => e.getBoundingClientRect().height > 0)
        .map((e) => ({
          radius: getComputedStyle(e).borderTopLeftRadius,
          height: e.getBoundingClientRect().height,
        })),
    );
    expect(tracks.length, 'switches were measured').toBeGreaterThan(1);
    for (const t of tracks) {
      expect(t.radius).toBe('10px');
      expect(parseFloat(t.radius), `a ${String(t.height)}px track`).toBeGreaterThanOrEqual(
        t.height / 2,
      );
    }
  });

  test('table cells sit 16px in from the row edge, with 16px between columns', async ({ page }) => {
    await open(page, '#/requests');
    const cells = await page.evaluate(() => {
      const out: Record<string, string> = {};
      for (const sel of ['.rs-table-requests .table-head', '.rs-table-requests .req-row']) {
        const e = document.querySelector(sel);
        if (!e) continue;
        const cs = getComputedStyle(e);
        out[sel] = `${cs.paddingLeft} ${cs.paddingRight} gap ${cs.columnGap}`;
      }
      return out;
    });
    expect(cells).toEqual({
      '.rs-table-requests .table-head': '16px 16px gap 16px',
      '.rs-table-requests .req-row': '16px 16px gap 16px',
    });
  });
});

/** Below narrow only the gutter and the card padding change (dashboard-core "Spacing comes
 * from the 4px scale", scenario "Narrow width changes only the gutter and the card padding";
 * STYLESEED.md `density-narrow`, "gaps unchanged"). Each page's section gap, Overview's panel
 * gap and the Limits intro's gap are read as declarations and as rendered distances at
 * 390 × 844, and must equal the desktop values the test above pins. EXACT, for the reason
 * given there: these are gaps, which no face moves. */
test.describe('narrow width keeps every page and section gap (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('sections stay 24px apart on every page, panels 16px, and the Limits intro 16px', async ({
    page,
  }) => {
    for (const name of [
      'overview',
      'requests',
      'batches',
      'costs',
      'agents',
      'providers',
      'routing',
      'limits',
      'settings',
      'users',
    ]) {
      // Setup is a centred column, not a `.rs-page`; its gaps are inline, and an inline style
      // cannot change with the width. Every gap a narrow query re-declares is held statically
      // by styles.scale.test.ts ("gaps unchanged").
      await open(page, `#/${name}`);
      const gap = await page.evaluate(() => {
        const root = document.querySelector('.rs-page');
        return root ? getComputedStyle(root).rowGap : null;
      });
      expect(gap, `the gap between ${name}'s page sections below narrow`).toBe('24px');
    }

    await open(page, '#/overview');
    const panels = await page.evaluate(() => {
      const grid = document.querySelector('.rs-grid-main-side');
      const kids = [...(grid?.children ?? [])].filter((c) => c.getBoundingClientRect().height > 0);
      const [a, b] = kids.map((c) => c.getBoundingClientRect());
      return {
        decl: grid ? getComputedStyle(grid).rowGap : null,
        // Stacked below narrow, so the panels are 16px apart in the block axis.
        apart: a && b ? b.top - a.bottom : null,
      };
    });
    expect(panels.decl, 'the gap between Overview panels below narrow').toBe('16px');
    expect(
      Math.abs((panels.apart ?? 0) - 16),
      `panels ${String(panels.apart)}px apart`,
    ).toBeLessThan(0.5);

    await open(page, '#/limits', '?budget=progress');
    const intro = await page.evaluate(() => {
      const box = document.querySelector('.limits-intro');
      const text = box?.querySelector(':scope > div')?.getBoundingClientRect();
      const action = box?.querySelector(':scope > button')?.getBoundingClientRect();
      return {
        decl: box ? getComputedStyle(box).rowGap : null,
        apart: text && action ? action.top - text.bottom : null,
      };
    });
    expect(intro.decl, 'the Limits intro gap below narrow (16px at desktop)').toBe('16px');
    expect(Math.abs((intro.apart ?? 0) - 16), `intro ${String(intro.apart)}px apart`).toBeLessThan(
      0.5,
    );
  });
});

test.describe('desktop parity against the recorded geometry (task 8.8; re-pinned by adopt-design-tokens-v2)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  /** Measured by building v0.11.0 in a git worktree, serving it beside this build, and
   * diffing landmark geometry and control heights across all nine pages at 1440x900.
   * Provenance and the full diff are in the change's `measurements.md`.
   *
   * The comparison is pinned as NUMBERS rather than run against the tag on every CI run:
   * a worktree build per run is slow, and the tag is a fixed point — re-deriving it would
   * produce the same values or mean someone rewrote history.
   *
   * RE-PINNED 2026-11-02 against adopt-design-tokens-v2's tree, not v0.27.1 (its design.md
   * Risks: "Desktop parity is then pinned against this change's tree"). That change is a
   * RECORDED desktop change (STYLESEED.md "Desktop geometry changes only through a recorded
   * change"): its height family moved `.nav-item` 31 → 32, and its type, spacing and
   * record-table treatment moved `.req-row` 35 → 37. Both are identical under forced Verdana, Georgia and Courier New on
   * macOS; the CI runner's values (`geometryCapture.spec.ts`) are pending the first push. */
  const BASELINE = {
    // Landmark geometry that must NOT move. [x, y, width, height]
    sidebar: [0, 0, 208, 900],
    // Controls already at or above the 24px floor. These values were read from BOTH
    // builds and are identical — measured in the real app, not from a control probe in
    // isolation, since a class renders at a different height depending on its content.
    // Since 2026-11-02 they are adopt-design-tokens-v2's recorded values (above).
    //
    // `.endpoint-chip` LEFT this set in narrow-geometry-tolerances. It was 28 here and is 27
    // now, because it contained `⧉` — a character no bundled font provides, drawn from a
    // platform symbol face — and replace-fallback-symbol-glyphs deliberately swapped it for an
    // SVG icon. 28 is NOT stale: it is a correct record of what v0.11.0 rendered, which is the
    // whole point of this set. Rewriting it to 27 would destroy that fact while leaving the
    // v0.11.0 provenance above it, and would assert nothing anyway — ±2 passes at either value.
    // A control we intentionally changed simply does not belong in a list of controls asserted
    // NOT to have changed. Its minimum size is covered by "every control meets the 24px floor
    // at desktop width" below, which was added with this removal because nothing else asserted
    // it above the narrow threshold.
    unchangedControls: {
      '.nav-item': 32,
      '.req-row': 37,
    },
  } as const;

  test('the sidebar and the untouched controls match the recorded geometry', async ({ page }) => {
    await open(page, '#/requests');
    const now = await page.evaluate(() => {
      const box = (sel: string): number[] | null => {
        const e = document.querySelector(sel);
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
      };
      const h = (sel: string): number | null => {
        const e = document.querySelector(sel);
        return e ? Math.round(e.getBoundingClientRect().height) : null;
      };
      return {
        sidebar: box('[data-pane="sidebar"]'),
        // ONLY what `unchangedControls` asserts. `.btn-primary` and
        // `.endpoint-chip` were collected here and never read — the loop below
        // iterates the BASELINE, not this object — so two values crossed the
        // bridge each run and were discarded, reading as coverage that did not
        // exist. Both are now asserted under the geometry contract in
        // "controls stay under a ceiling as well as over the floor".
        controls: {
          '.nav-item': h('.nav-item'),
          '.req-row': h('.req-row'),
        } as Record<string, number | null>,
      };
    });

    // The sidebar's box is font-invariant — fixed width, full viewport height — so it stays
    // an exact assertion.
    expect(now.sidebar, 'the sidebar moved at desktop width').toEqual([...BASELINE.sidebar]);
    for (const [sel, expected] of Object.entries(BASELINE.unchangedControls)) {
      if (now.controls[sel] === null) continue; // not present on this page
      // ±2. The earlier note here said the app "bundles no `@font-face`" so each platform
      // falls back differently — that is false: Geist is vendored and loaded (see
      // `overlayBaseline.spec.ts`'s header for the full correction). The ±2 was sized against
      // forced face swaps, which do not occur.
      //
      // It is kept, and the reason has CHANGED. It used to be that CI had never disclosed
      // these values — it reports only assertions that FAIL — so narrowing would have been
      // inference. `geometryCapture.spec.ts` now logs them on every CI run, and on 2026-09-18
      // ubuntu-latest printed exactly 31 and 35, matching macOS: the cross-platform spread is
      // ZERO. The ±2 is therefore no longer a stand-in for missing data. It is the
      // unseen-environment margin, the same convention `overlayBaseline.spec.ts` uses (spread +
      // margin), scaled to a 31px control rather than a 700px dialog — and it has a concrete
      // job, because ubuntu-latest moves to Ubuntu 26 from 2026-10-19.
      //
      // The 2026-11-02 re-pin (32 and 37) keeps the ±2. Both values are identical under every
      // forced face on macOS, so a zero spread is expected, but the runner's capture of the new
      // values is pending the first push; read its "requests:.nav-item" / ".req-row" lines.
      expect(
        Math.abs(now.controls[sel]! - expected),
        `${sel} changed height at desktop (${expected} → ${now.controls[sel]})`,
      ).toBeLessThanOrEqual(2);
    }
  });

  test('.req-row did not grow — the cell wrapper must contribute no box at desktop', async ({
    page,
  }) => {
    // Regression guard for a defect this baseline actually caught: wrapping each cell to
    // carry its stacked-view label added a layout box, taking every request row from 35px
    // to 51px. `display: contents` removes the wrapper's box at desktop; if that is ever
    // dropped, this fails.
    await open(page, '#/requests');
    const display = await page.evaluate(() => {
      const cell = document.querySelector('.rs-cell');
      return cell ? getComputedStyle(cell).display : null;
    });
    expect(display).toBe('contents');
  });
});

test.describe('overlay paint order follows the layer registry', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('z-index is derived from the registry, not hand-assigned', async ({ page }) => {
    // Only a real browser can check this. The element carrying z-index is usually NOT the
    // registered dialog root — the modal's is its PARENT backdrop, the drawer's a SIBLING —
    // and an ancestor stacking context can trap a child's z-index entirely.
    await open(page, '#/requests');
    await page.locator('button.req-row').first().click();
    await expect(page.locator('.drawer')).toBeVisible();

    const z = await page.evaluate(() => {
      const of = (s: string): number | null => {
        const el = document.querySelector(s);
        return el ? Number(getComputedStyle(el).zIndex) : null;
      };
      return { backdrop: of('.overlay'), surface: of('.drawer') };
    });
    // One open layer → the first slot of the band, backdrop then surface.
    expect(z.backdrop).toBe(40);
    expect(z.surface).toBe(41);
    expect(z.surface! - z.backdrop!, 'a layer is a backdrop AND a surface').toBe(1);
  });

  test('an open drawer isolates the page beneath it, including the nav', async ({ page }) => {
    // Consequence of deriving paint order rather than hand-assigning it: the drawer is a
    // modal layer, so its backdrop covers the sidebar and the rail toggle cannot be
    // clicked through it. That is correct isolation — and it means the expanded nav and an
    // open drawer can no longer be reached together through the UI at all, which bears on
    // the phase-2 coexistence question recorded in the change's design.
    await open(page, '#/requests');
    await page.locator('button.req-row').first().click();
    await expect(page.locator('.drawer')).toBeVisible();

    const covered = await page.evaluate(() => {
      const t = document.querySelector('.rs-nav-toggle');
      if (!t) return null;
      const r = t.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit !== null && !t.contains(hit) && hit !== t;
    });
    expect(covered, 'the drawer backdrop does not cover the sidebar').toBe(true);
  });

  test('a popover opened inside a dialog paints above it', async ({ page }) => {
    // Task 4.3's other half. The combobox lives inside the Routing tier editor; its panel
    // used to carry a hardcoded z-index 55 chosen to sit above modals. It now derives from
    // the registry, so this asserts the DERIVATION produces the same outcome — by
    // hit-testing, because an ancestor stacking context can trap a child's z-index and a
    // declaration check would not notice.
    test.setTimeout(30_000);
    await open(page, '#/routing');
    const input = page.locator('.mp-input').first();
    if ((await input.count()) === 0) test.skip(true, 'no tier editor on this fixture');
    await input.click();
    const panel = page.locator('.mp-panel').first();
    await expect(panel).toBeVisible();

    const result = await page.evaluate(() => {
      const p = document.querySelector('.mp-panel');
      if (!p) return null;
      const r = p.getBoundingClientRect();
      const hit = document.elementFromPoint(
        Math.round(r.left + r.width / 2),
        Math.round(r.top + 10),
      );
      return {
        panelOnTop: hit !== null && (p.contains(hit) || hit === p),
        z: Number(getComputedStyle(p).zIndex),
      };
    });
    expect(result, 'picker panel missing').not.toBeNull();
    expect(result?.panelOnTop, 'the popover is not hit-testing on top').toBe(true);
    // Derived, not the old hardcoded 55.
    expect(result?.z).toBeLessThan(60);
  });

  test('no layer can overtake the toast', async ({ page }) => {
    // The band is bounded on purpose: the toast is not a dismissible layer and must stay
    // above everything, so a dynamically-ordered layer must never reach it.
    await open(page);
    await page.locator('.rs-nav-toggle').click();
    await page.waitForTimeout(200);
    const zs = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.overlay, .drawer, .modal-backdrop')]
        .map((el) => Number(getComputedStyle(el).zIndex))
        .filter((n) => Number.isFinite(n)),
    );
    for (const z of zs) expect(z, 'a layer reached the toast band').toBeLessThan(60);
  });
});

/** The Auto-performance Workload-mix rows (fix-workload-mix-phone-overflow).
 *
 * The whole-page "in-flow content stays inside its pane" assertion above catches the
 * shipped 320px overflow on the DEFAULT fixture; these tests add the parts an
 * element-box page sweep cannot: they assert the actual text GLYPHS (via Range rects,
 * not only element boxes) stay inside the pane, that no required figure is clipped or
 * ellipsised to fit, and that every honesty state the view-model can emit — routed
 * counts, the bare `unpriced` (no dash; adopt-figure-states 4.2), free `$0`, priced,
 * `N unpriced`, and attempt-only `0%` — is present at phone width. The default fixture carries only some of those states, so the
 * `?workload=boundary` / `?workload=attempt-only` variants supply the rest. A companion
 * block pins that desktop rendering does NOT reflow. */

/** Geometry + visibility state of everything under `selector`, measured against the
 * content pane. Reports content that ESCAPES the pane (element boxes AND text-node Range
 * rects, so glyphs spilling a container whose own box fits are caught), content that is
 * CLIPPED (overflow hidden/clip or text-overflow ellipsis), and content that is HIDDEN
 * while still carrying text (display:none / visibility:hidden|collapse, or a non-empty
 * text node with a zero-area range). The hidden check matters because a required figure
 * removed from layout still lives in `textContent`: without it a "satisfy the box check
 * by hiding the value" fix would pass, which the workload-mix honesty contract forbids. */
async function paneOverflow(
  page: Page,
  selector: string,
): Promise<{ count: number; escapes: string[]; clipped: string[]; hidden: string[] }> {
  return page.evaluate((sel) => {
    const pane = document.querySelector('[data-pane="content"]');
    if (!pane) return { count: 0, escapes: ['no content pane'], clipped: [], hidden: [] };
    const bound = pane.getBoundingClientRect();
    const roots = [...document.querySelectorAll(sel)];
    const escapes: string[] = [];
    const clipped: string[] = [];
    const hidden: string[] = [];
    const over = (right: number): boolean => right > bound.right + 1;
    const short = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 30);
    for (const root of roots) {
      for (const el of [root, ...root.querySelectorAll('*')]) {
        const s = getComputedStyle(el);
        if (s.position === 'fixed' || s.position === 'absolute') continue;
        const text = (el.textContent ?? '').trim();
        // Hidden-but-present: removed from layout yet still in textContent.
        if (
          text.length > 0 &&
          (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse')
        ) {
          hidden.push(
            `${el.tagName} display=${s.display} visibility=${s.visibility} "${short(el.textContent ?? '')}"`,
          );
          continue;
        }
        const r = el.getBoundingClientRect();
        if (r.width > 0 && over(r.right)) {
          escapes.push(
            `${el.tagName} over=${String(Math.round(r.right - bound.right))}px "${short(el.textContent ?? '')}"`,
          );
        }
        const hides = s.overflowX === 'hidden' || s.overflowX === 'clip';
        if ((hides || s.textOverflow === 'ellipsis') && text.length > 0) {
          clipped.push(
            `${el.tagName} overflowX=${s.overflowX} textOverflow=${s.textOverflow} "${short(el.textContent ?? '')}"`,
          );
        }
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = (n.textContent ?? '').trim();
        if (!text) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const r = range.getBoundingClientRect();
        // A non-empty text node with a zero-area range is collapsed / hidden.
        if (r.width === 0 && r.height === 0) {
          hidden.push(`TEXT zero-area "${short(n.textContent ?? '')}"`);
          continue;
        }
        if (over(r.right)) {
          escapes.push(
            `TEXT over=${String(Math.round(r.right - bound.right))}px "${short(n.textContent ?? '')}"`,
          );
        }
      }
    }
    return {
      count: roots.length,
      escapes: escapes.slice(0, 10),
      clipped: clipped.slice(0, 10),
      hidden: hidden.slice(0, 10),
    };
  }, selector);
}

/* ---- request figure states (adopt-figure-states task 2.2; design Risks 1 and 2) ----
 *
 * `?requests=states` (browserHarness.tsx) heads the list with one row per cost-cell state the
 * vocabulary adds and a usage-estimated row at adversarial counts. Each state is wider than the
 * `$0.0000` it replaces, and `· est. usage` can push the tokens cell onto a second line, so
 * each row is measured: inside the pane, its tokens and cost figures inside their own cells
 * (and, while the table is a grid, inside their own columns), `· est. usage` on one line, and
 * no cost string clipped, ellipsized or hidden.
 *
 * The recorded desktop delta (design Risk 1, measured 2026-11-03 at 1440×900): each
 * usage-estimated row here (`912.3k↑ 45.7k↓ · est. usage`, `state-usage` and `state-free-est`)
 * wraps its tokens cell to two lines and stands 49px tall, against the 37px default-row pin
 * (`requests:.req-row` and `overview:.req-row` in the geometry capture), which does not move;
 * every other state row stays 37px. The marker wraps whole, so the row grows by one line and
 * the marker never splits. */
const STATE_ROWS = [
  { id: 'state-usage', cost: '$0.0123', usage: true },
  { id: 'state-free', cost: '$0 free', usage: false },
  { id: 'state-free-est', cost: '$0 free · est.', usage: true },
  { id: 'state-unpriced', cost: 'unpriced', usage: false },
  { id: 'state-speck', cost: '<$0.0001', usage: false },
  { id: 'state-not-billed', cost: '$0 · not billed', usage: true },
] as const;

interface StateRowGeometry {
  cost: string;
  marker: boolean;
  markerLines: number;
  tokensLines: number;
  grid: boolean;
  problems: string[];
}

async function figureStateRows(page: Page): Promise<StateRowGeometry[]> {
  return page.evaluate((n) => {
    const pane = document.querySelector('[data-pane="content"]')!.getBoundingClientRect();
    const rows = [
      ...document.querySelectorAll<HTMLElement>('.rs-table-requests button.req-row'),
    ].slice(0, n);
    const value = (row: Element, label: string): HTMLElement => {
      const cell = [...row.querySelectorAll('.rs-cell')].find(
        (c) => c.querySelector('.rs-cell-label')?.textContent === label,
      );
      const v = cell?.querySelector<HTMLElement>(':scope > :not(.rs-cell-label)');
      if (!v) throw new Error(`no ${label} cell`);
      return v;
    };
    const r1 = (v: number): number => Math.round(v * 10) / 10;
    return rows.map((row) => {
      const problems: string[] = [];
      const inside = (what: string, r: DOMRect, b: DOMRect): void => {
        if (r.left < b.left - 1 || r.right > b.right + 1) {
          problems.push(
            `${what} [${String(r1(r.left))}, ${String(r1(r.right))}] outside [${String(r1(b.left))}, ${String(r1(b.right))}]`,
          );
        }
      };
      const grid = getComputedStyle(row).display === 'grid';
      inside('row', row.getBoundingClientRect(), pane);
      const tokens = value(row, 'Tokens');
      const cost = value(row, 'Cost');
      for (const [name, el] of [
        ['tokens', tokens],
        ['cost', cost],
      ] as const) {
        const box = el.getBoundingClientRect();
        inside(name, box, pane);
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility !== 'visible') problems.push(`${name} hidden`);
        if (s.textOverflow === 'ellipsis') problems.push(`${name} ellipsized`);
        if (s.overflowX === 'hidden' || s.overflowX === 'clip') problems.push(`${name} clips`);
        if (el.scrollWidth > el.clientWidth + 1) {
          problems.push(
            `${name} content ${String(el.scrollWidth)} > box ${String(el.clientWidth)}`,
          );
        }
        for (const part of el.querySelectorAll<HTMLElement>('span:not(.sr-only)')) {
          if (part.closest('.sr-only')) continue;
          inside(`${name} part "${part.textContent ?? ''}"`, part.getBoundingClientRect(), box);
        }
      }
      if (grid) {
        // A figure wider than its 0.9fr / 0.7fr track would paint into the next column.
        const latency = value(row, 'Latency').getBoundingClientRect();
        const c = cost.getBoundingClientRect();
        const t = tokens.getBoundingClientRect();
        if (t.right > c.left + 1) problems.push('tokens bleeds into the cost column');
        if (c.right > latency.left + 1) problems.push('cost bleeds into the latency column');
      }
      const marker =
        [...tokens.querySelectorAll<HTMLElement>('span')].find(
          (sp) => sp.textContent === '· est. usage' && sp.children.length === 0,
        ) ?? null;
      const visible = tokens.querySelector<HTMLElement>('[aria-hidden="true"]');
      const lineHeight = visible ? parseFloat(getComputedStyle(visible).lineHeight) : 0;
      return {
        cost: (cost.textContent ?? '').replace(/\s+/g, ' ').trim(),
        marker: marker !== null,
        markerLines: marker ? marker.getClientRects().length : 0,
        tokensLines:
          visible && lineHeight > 0
            ? Math.round(visible.getBoundingClientRect().height / lineHeight)
            : 0,
        grid,
        problems,
      };
    });
  }, STATE_ROWS.length);
}

for (const vp of [MATRIX[0], MATRIX[3], MATRIX[4]]) {
  test.describe(`request figure states stay whole inside the pane @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('each state row keeps its words whole: no escape, no clip, `· est. usage` on one line', async ({
      page,
    }) => {
      await open(page, '#/requests', '?requests=states');
      await page.waitForSelector('.rs-table-requests button.req-row');
      const rows = await figureStateRows(page);
      expect(rows.map((r) => r.cost)).toEqual(STATE_ROWS.map((r) => r.cost));
      expect(rows.map((r) => r.marker)).toEqual(STATE_ROWS.map((r) => r.usage));
      for (const [i, r] of rows.entries()) {
        const id = STATE_ROWS[i]!.id;
        expect(r.problems, `${id} @ ${vp.name}`).toEqual([]);
        if (r.marker) expect(r.markerLines, `${id}: · est. usage split across lines`).toBe(1);
      }
      // The table is a grid only where its container is above `table-fit-requests`.
      expect(rows.every((r) => r.grid)).toBe(vp.width === 1440);
    });
  });
}

/* ---- batch figure states (adopt-figure-states task 5.3; design Risk "Wider strings in fixed
 * tracks") ----
 *
 * `?batches=states` (browserHarness.tsx) heads the list with an active job's `≤ $3.00` ceiling
 * above `reserved, not spent`, and a terminal job whose null settled cost reads `unpriced`.
 * Each Cost cell is measured: inside the pane, every line inside its cell (and, while the table
 * is a grid, inside its own column), and nothing clipped, ellipsized or hidden. */
for (const vp of [MATRIX[0], MATRIX[3], MATRIX[4]]) {
  test.describe(`batch figure states stay whole inside the pane @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('the `≤ $3.00` ceiling and the `unpriced` settled cost keep their words whole', async ({
      page,
    }) => {
      await open(page, '#/batches', '?batches=states');
      await page.waitForSelector('[data-batch-job="bj-unpriced"]');
      const cells = await page.evaluate(() => {
        const pane = document.querySelector('[data-pane="content"]')!.getBoundingClientRect();
        return ['bj-ceiling', 'bj-unpriced'].map((id) => {
          const row = document.querySelector<HTMLElement>(`[data-batch-job="${id}"]`)!;
          const cell = [...row.querySelectorAll<HTMLElement>('.rs-cell')].find(
            (c) => c.querySelector('.rs-cell-label')?.textContent === 'Cost',
          )!;
          const value = cell.querySelector<HTMLElement>('.cell-figure')!;
          const problems: string[] = [];
          // In the grid the cell wrapper is `display: contents`, so the value is the grid item
          // and its box is the column's.
          const box = value.getBoundingClientRect();
          const grid = getComputedStyle(row).display === 'grid';
          const lines = [...value.querySelectorAll<HTMLElement>('span')].filter(
            (sp) => sp.children.length === 0,
          );
          for (const el of [value, ...lines]) {
            const r = el.getBoundingClientRect();
            const what = `"${el.textContent ?? ''}"`;
            if (r.left < pane.left - 1 || r.right > pane.right + 1)
              problems.push(`${what} escapes the pane`);
            if (grid && el !== value && (r.left < box.left - 1 || r.right > box.right + 1))
              problems.push(`${what} leaves its column`);
            const s = getComputedStyle(el);
            if (s.display === 'none' || s.visibility !== 'visible') problems.push(`${what} hidden`);
            if (s.textOverflow === 'ellipsis') problems.push(`${what} ellipsized`);
            if (s.overflowX === 'hidden' || s.overflowX === 'clip') problems.push(`${what} clips`);
            if (el.scrollWidth > el.clientWidth + 1) problems.push(`${what} overflows its box`);
          }
          return { id, texts: lines.map((l) => l.textContent ?? ''), problems };
        });
      });
      expect(cells[0]!.texts).toEqual(['≤ $3.00', 'reserved, not spent']);
      expect(cells[1]!.texts).toEqual(['unpriced']);
      for (const c of cells) expect(c.problems, `${c.id} @ ${vp.name}`).toEqual([]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, 'the document overflows').toBeLessThanOrEqual(1);
    });
  });
}

/* ---- the agent strip's failure notice (adopt-figure-states task 3.2, flag F9) ----
 *
 * A failed agent-strip read is the shared Info notice with its own Retry, in the strip's
 * Agents row beside the overline. No default fixture fails that read, so the pinned geometry
 * cannot see it: the failure is set on the harness store, and the strip is measured where the
 * notice is widest against its row (a phone, the coarse-pointer laptop, the desktop pin). The
 * notice stays inside the pane and the strip's panel, nothing in it is clipped or hidden, its
 * Retry meets its floor, and at desktop it shares the overline's line. */
for (const vp of [MATRIX[0], MATRIX[3], MATRIX[4]]) {
  test.describe(`the agent strip's failure notice fits the strip @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('the notice and its Retry stay inside the strip, whole, at their floor', async ({
      page,
    }) => {
      await open(page, '#/overview');
      await page.waitForSelector('[data-testid="agent-strip"]');
      await page.evaluate(() => {
        const s = (
          globalThis as unknown as {
            __harnessStore: { setState: (v: Record<string, unknown>) => void };
          }
        ).__harnessStore;
        s.setState({ agentStripLoaded: false, agentStripError: 'agent activity down' });
      });
      await page.waitForSelector('[data-testid="agent-strip"] .notice');
      const overflow = await paneOverflow(page, '[data-testid="agent-strip"]');
      expect(overflow.count).toBe(1);
      expect(overflow.escapes, `escapes @ ${vp.name}`).toEqual([]);
      expect(overflow.clipped, `clipped @ ${vp.name}`).toEqual([]);
      expect(overflow.hidden, `hidden @ ${vp.name}`).toEqual([]);
      const g = await page.evaluate(() => {
        const box = (el: Element) => el.getBoundingClientRect();
        const panel = document.querySelector('[data-testid="agent-strip"]')!;
        const notice = panel.querySelector('.notice')!;
        const label = panel.querySelector('.upper-label')!;
        const retry = notice.querySelector('button')!;
        const p = box(panel);
        const pad = parseFloat(getComputedStyle(panel).paddingRight);
        const n = box(notice);
        const l = box(label);
        const r = box(retry);
        return {
          body: notice.querySelector('.notice-body')?.textContent ?? '',
          inside: n.left >= p.left + pad - 1 && n.right <= p.right - pad + 1,
          sameLine: l.top + l.height / 2 > n.top && l.top + l.height / 2 < n.bottom,
          retry: { width: r.width, height: r.height, inside: r.right <= n.right + 1 },
          docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      expect(g.body).toBe('Agent activity couldn’t be loaded. Routing is unaffected.');
      expect(g.inside, 'the notice leaves the strip panel').toBe(true);
      expect(g.retry.inside, 'Retry leaves the notice').toBe(true);
      expect(g.retry.height).toBeGreaterThanOrEqual(vp.width <= 768 ? 44 : 24);
      expect(g.retry.width).toBeGreaterThanOrEqual(24);
      if (vp.width === 1440) expect(g.sameLine, 'the notice wrapped under the overline').toBe(true);
      expect(g.docOverflow, 'the document overflows').toBeLessThanOrEqual(1);
    });
  });
}

/** The normalized text of every workload-mix row, in DOM order, for row-specific
 * assertions (a state must be present ON ITS OWN row, not merely somewhere on the page). */
async function workloadRowTexts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="workload-row"]')].map((r) =>
      (r.textContent ?? '').replace(/\s+/g, ' ').trim(),
    ),
  );
}

const ROW = '[data-testid="workload-row"]';

/** The workload mix lives in the Workload claim stage's detail on the Auto routing tab
 * (redesign-auto-routing-pipeline D8): open the tab, then that stage. */
async function openWorkloadMix(page: Page): Promise<void> {
  await openRoutingSection(page, 'Auto routing');
  await expandStage(page, 'Workload claim');
}

test.describe('Workload-mix rows at phone width', () => {
  test.use({ viewport: { width: 320, height: 568 } });

  test('the default fixture rows stay inside the pane, whole and unclipped', async ({ page }) => {
    await open(page, '#/routing');
    await openWorkloadMix(page);
    await page.waitForSelector(ROW);
    const geom = await paneOverflow(page, ROW);
    const texts = await workloadRowTexts(page);
    // The default fixture is none / code / structured (see DEFAULT_AUTO_PERF): the
    // long none label, and `code` carrying the "$1.3100 · 1 unpriced" qualifier.
    expect(geom.count).toBe(3);
    const noneRow = texts.find((t) => t.includes('no specialist workload'));
    const codeRow = texts.find((t) => t.startsWith('code'));
    expect(noneRow, 'the long none-label row is present').toBeTruthy();
    expect(codeRow ?? '', 'the code row keeps its partial-unpriced qualifier').toContain(
      '1 unpriced',
    );
    expect(geom.hidden, 'no required workload figure may be hidden').toEqual([]);
    expect(geom.clipped, 'no required workload figure may be clipped or ellipsised').toEqual([]);
    expect(geom.escapes, 'workload rows escape the pane at 320px').toEqual([]);
  });

  test('every pricing / routing state stays inside the pane', async ({ page }) => {
    await open(page, '#/routing', '?workload=boundary');
    await openWorkloadMix(page);
    await page.waitForSelector(ROW);
    const geom = await paneOverflow(page, ROW);
    const texts = await workloadRowTexts(page);
    expect(geom.count).toBe(5);
    const codeRow = texts.find((t) => t.startsWith('code')) ?? '';
    const visionRow = texts.find((t) => t.startsWith('vision')) ?? '';
    const structuredRow = texts.find((t) => t.startsWith('structured')) ?? '';
    const noneRow = texts.find((t) => t.includes('no specialist workload')) ?? '';
    const writingRow = texts.find((t) => t.startsWith('writing')) ?? '';
    // Each honesty state is present ON ITS OWN row — not merely somewhere on the page.
    expect(codeRow, 'routed count on the code row').toContain('7 routed');
    expect(codeRow, 'ordinary priced spend on the code row').toContain('$12.3400');
    // Null spend is the bare word `unpriced`: no dash and no dollar figure (adopt-figure-states
    // 4.2; dashboard-analytics "Workload-mix analytics remain complete at narrow width").
    expect(visionRow, 'null spend renders "unpriced" on the vision row').toContain('unpriced');
    expect(visionRow, 'null spend takes no dash on the vision row').not.toContain('—');
    expect(visionRow, 'null spend shows no dollar figure').not.toContain('$');
    expect(structuredRow, 'partial-pricing qualifier on the structured row').toContain(
      '1 unpriced',
    );
    expect(noneRow, 'free spend renders $0 on the none row').toContain('$0.0000');
    expect(noneRow, 'a free $0 carries NO unpriced qualifier').not.toContain('unpriced');
    expect(writingRow, 'a request-zero attempt-only class shows a 0% share').toContain('0%');
    expect(geom.hidden, 'no required workload figure may be hidden').toEqual([]);
    expect(geom.clipped, 'no required workload figure may be clipped or ellipsised').toEqual([]);
    expect(geom.escapes, 'a workload state escapes the pane at 320px').toEqual([]);
  });

  test('the attempt-only state renders its row and note inside the pane', async ({ page }) => {
    await open(page, '#/routing', '?workload=attempt-only');
    await openWorkloadMix(page);
    await page.waitForSelector('[data-testid="workload-mix"]');
    const note = await page.locator('[data-testid="workload-mix-attempt-only"]').textContent();
    expect(note, 'the attempt-only disclosure must render, not the empty affordance').toContain(
      'attempt spend but no classified parent requests',
    );
    const rowGeom = await paneOverflow(page, ROW);
    const noteGeom = await paneOverflow(page, '[data-testid="workload-mix-attempt-only"]');
    const texts = await workloadRowTexts(page);
    expect(rowGeom.count).toBe(1);
    expect(texts[0] ?? '', 'the attempt-only row shows a 0% share').toContain('0%');
    expect(rowGeom.hidden, 'the attempt-only row hides a figure').toEqual([]);
    expect(rowGeom.clipped, 'the attempt-only row clips a figure').toEqual([]);
    expect(rowGeom.escapes, 'the attempt-only row escapes the pane at 320px').toEqual([]);
    expect(
      noteGeom.hidden.concat(noteGeom.escapes),
      'the attempt-only note escapes the pane',
    ).toEqual([]);
  });
});

for (const vp of [
  { name: '1025x768', width: 1025, height: 768 },
  { name: '1440x900', width: 1440, height: 900 },
] as const) {
  test.describe(`Workload-mix rows keep their one-line desktop layout @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    // Direct Routing-page parity: the existing v0.11.0 baseline suite only opens Requests,
    // so nothing else proves the fix stays narrow-only here. Holds before AND after the
    // `rs-wrap` addition, since that class contributes nothing above 768px.
    test('rows stay a single non-wrapping flex line with unchanged typography', async ({
      page,
    }) => {
      await open(page, '#/routing');
      await openWorkloadMix(page);
      await page.waitForSelector('[data-testid="workload-row"]');
      const rows = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="workload-row"]')].map((row) => {
          const s = getComputedStyle(row);
          const kids = [...row.children];
          const rowH = row.getBoundingClientRect().height;
          const maxKidH = Math.max(...kids.map((k) => k.getBoundingClientRect().height));
          const first = kids[0];
          const second = kids[1];
          return {
            display: s.display,
            flexWrap: s.flexWrap,
            gap: s.gap,
            fontSize: s.fontSize,
            lineHeight: s.lineHeight,
            childCount: kids.length,
            // One flex line: the row is no taller than its tallest child. A wrapped
            // container would stack a second line and exceed it. (align-items:center
            // means child TOPS legitimately differ, so height — not top — is the test.)
            oneFlexLine: rowH <= maxKidH + 1,
            firstIsLabel: !!first && !first.classList.contains('figure'),
            secondIsFigure: !!second && second.classList.contains('figure'),
          };
        }),
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.display).toBe('flex');
        expect(r.flexWrap, 'desktop workload rows must not reflow').toBe('nowrap');
        // On the 4px spacing scale (adopt-design-tokens-v2 D6), a recorded spacing-scale
        // change: it was an off-scale 10px.
        expect(r.gap).toBe('8px');
        expect(r.fontSize).toBe('11px');
        // The Caption role's 16px line (adopt-design-tokens-v2 D5), a recorded type-scale
        // change: it was an off-grid unitless 1.7 (18.7px).
        expect(r.lineHeight).toBe('16px');
        expect(r.childCount).toBe(4);
        expect(r.oneFlexLine, 'the row stays a single flex line at desktop').toBe(true);
        expect(r.firstIsLabel, 'the class label leads the row').toBe(true);
        // The share and counts are figures: tabular Geist, never Mono (adopt-design-tokens-v2
        // task 9.1, a recorded type change: this span was `.mono`).
        expect(r.secondIsFigure, 'the figure stat span follows the label').toBe(true);
      }
    });

    test('null spend reads the bare word `unpriced`, with no dash, on its one line', async ({
      page,
    }) => {
      // adopt-figure-states 4.2: the desktop half of the narrow-width honesty check, on the
      // fixture that carries the null-spend row.
      await open(page, '#/routing', '?workload=boundary');
      await openWorkloadMix(page);
      await page.waitForSelector(ROW);
      const texts = await workloadRowTexts(page);
      const visionRow = texts.find((t) => t.startsWith('vision')) ?? '';
      expect(visionRow, 'null spend renders "unpriced" on the vision row').toContain('unpriced');
      expect(visionRow, 'null spend takes no dash on the vision row').not.toContain('—');
      expect(visionRow, 'null spend shows no dollar figure').not.toContain('$');
      const vision = await page.evaluate(() => {
        const row = [...document.querySelectorAll('[data-testid="workload-row"]')].find((r) =>
          (r.textContent ?? '').trim().startsWith('vision'),
        )!;
        const kids = [...row.children];
        return {
          flexWrap: getComputedStyle(row).flexWrap,
          oneFlexLine:
            row.getBoundingClientRect().height <=
            Math.max(...kids.map((k) => k.getBoundingClientRect().height)) + 1,
        };
      });
      expect(vision.flexWrap).toBe('nowrap');
      expect(vision.oneFlexLine, 'the unpriced row stays a single flex line').toBe(true);
      const geom = await paneOverflow(page, ROW);
      expect(geom.hidden.concat(geom.clipped, geom.escapes)).toEqual([]);
    });
  });
}

/** The Targets matrix (redesign-auto-routing-pipeline D9, task 7.2), measured on its
 * worst case: `?targets=1` puts every cell state on screen at once — the long model id
 * and provider label, a tier with fallbacks, shadowed and unresolved rules, an empty-tier
 * claim — over a catalog whose labels push every picker to its 220px cap. Below
 * `table-fit-targets` each row must become a stacked record; these prove it does at the
 * WCAG reflow width, and that its field labels are real text rather than paint. */
const MATRIX_COLUMNS = ['claim', 'strong', 'cheap'] as const;
const MATRIX_ROWS = 6; // "Any request" + code, vision, structured, research, writing

async function openTargetsMatrix(page: Page): Promise<void> {
  await open(page, '#/routing', '?targets=1');
  await openRoutingSection(page, 'Auto routing');
  // The whole tab, details included: an overflow the matrix causes and one a stage
  // detail causes look the same from the document's side.
  await expandAllStages(page);
  await page.locator('[data-testid="targets-matrix"]').waitFor({ state: 'visible' });
  await expect(page.locator('[data-testid="targets-row"]')).toHaveCount(MATRIX_ROWS);
}

test.describe('Targets matrix at the reflow width (?targets=1)', () => {
  test.use({ viewport: { width: 320, height: 568 } });

  test('the worst-case matrix does not overflow the document or its pane', async ({ page }) => {
    await openTargetsMatrix(page);
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      overflow.scrollWidth,
      `the Targets matrix overflows at 320x568 (${String(overflow.scrollWidth)} > ${String(overflow.clientWidth)})`,
    ).toBeLessThanOrEqual(overflow.clientWidth + 1);
    // Glyphs as well as boxes: a long model id spilling a cell whose own box fits would
    // pass the document check above.
    const geom = await paneOverflow(page, '[data-testid="targets-matrix"]');
    expect(geom.count).toBe(1);
    expect(geom.escapes, 'Targets matrix content escapes the pane at 320px').toEqual([]);
  });

  test('every stacked field carries a real, visible label element', async ({ page }) => {
    await openTargetsMatrix(page);
    const shape = await page.evaluate(() => {
      const head = document.querySelector('.tm-head');
      const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="targets-row"]')];
      const problems: string[] = [];
      const fields: { row: string; column: string; label: string }[] = [];
      const generated = (el: Element): boolean =>
        ['::before', '::after'].some((p) => {
          const c = getComputedStyle(el, p).content;
          return c !== 'none' && c !== 'normal' && c !== '""';
        });
      for (const row of rows) {
        const id = row.dataset['row'] ?? '?';
        const grid = row.querySelector(':scope > .rs-grid-targets');
        const display = grid ? getComputedStyle(grid).display : 'missing';
        if (display !== 'block') problems.push(`${id}: row grid is ${display}, not stacked`);
        const cells = row.querySelectorAll<HTMLElement>('[data-testid="targets-cell"]');
        for (const cell of cells) {
          const column = cell.dataset['column'] ?? '?';
          const label = cell.querySelector(':scope > .tm-label');
          if (!label) {
            problems.push(`${id}/${column}: no label element`);
            continue;
          }
          const text = (label.textContent ?? '').replace(/\s+/g, ' ').trim();
          const s = getComputedStyle(label);
          const r = label.getBoundingClientRect();
          const c = cell.getBoundingClientRect();
          // Real: a DOM element with its own text — not a pseudo-element, not an
          // aria-label — laid out in flow at a readable size, inside its own cell.
          if (text.length === 0) problems.push(`${id}/${column}: empty label`);
          if (generated(label) || generated(cell))
            problems.push(`${id}/${column}: label text is generated content`);
          if (s.position !== 'static') problems.push(`${id}/${column}: label is ${s.position}`);
          if (s.display === 'none' || s.visibility !== 'visible')
            problems.push(`${id}/${column}: label is hidden`);
          const clip = s.getPropertyValue('clip');
          if (clip !== 'auto' || s.overflow !== 'visible')
            problems.push(
              `${id}/${column}: label is clipped (clip=${clip}, overflow=${s.overflow})`,
            );
          if (r.width < 20 || r.height < 8)
            problems.push(`${id}/${column}: label is ${String(r.width)}x${String(r.height)}`);
          if (r.left < c.left - 0.5 || r.right > c.right + 0.5 || r.top < c.top - 0.5)
            problems.push(`${id}/${column}: label sits outside its cell`);
          fields.push({ row: id, column, label: text });
        }
      }
      return {
        head: head ? getComputedStyle(head).display : null,
        rows: rows.length,
        fields,
        problems: problems.slice(0, 12),
      };
    });
    // Stacked: the column header goes, so the per-field labels are the only names left.
    expect(shape.head, 'the column header still shows in the stacked layout').toBe('none');
    expect(shape.rows).toBe(MATRIX_ROWS);
    expect(shape.problems, 'stacked matrix labels').toEqual([]);
    // Every field of every row is labelled — the three targets; no Detected column
    // (split-auto-routing-readout-setup D9) — and each label names its own column.
    expect(shape.fields).toHaveLength(MATRIX_ROWS * MATRIX_COLUMNS.length);
    const want: Record<string, RegExp> = {
      claim: /^Claim$/,
      strong: /^Strong$/,
      cheap: /^Cheap$/,
    };
    for (const f of shape.fields) {
      expect(f.label, `${f.row}/${f.column} label`).toMatch(want[f.column] ?? /^$/);
    }
  });
});

test.describe('Targets matrix above table-fit-targets (?targets=1)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('stays a grid under its header, with the field labels read but not shown', async ({
    page,
  }) => {
    // The other side of the threshold: at 1440 the matrix's content box clears 900px, so
    // the query must NOT fire. The labels stay in the DOM — every picker keeps one
    // accessible name at every width — but are visually hidden behind the header.
    await openTargetsMatrix(page);
    const shape = await page.evaluate(() => {
      const head = document.querySelector('.tm-head');
      const row = document.querySelector('[data-testid="targets-row"] > .rs-grid-targets');
      const labels = [...document.querySelectorAll('[data-testid="targets-row"] .tm-label')];
      return {
        head: head ? getComputedStyle(head).display : null,
        row: row ? getComputedStyle(row).display : null,
        labels: labels.length,
        shown: labels.filter((l) => l.getBoundingClientRect().width > 1).length,
        empty: labels.filter((l) => (l.textContent ?? '').trim().length === 0).length,
      };
    });
    expect(shape.head).toBe('grid');
    expect(shape.row).toBe('grid');
    expect(shape.labels).toBe(MATRIX_ROWS * MATRIX_COLUMNS.length);
    expect(shape.empty, 'a field label lost its text').toBe(0);
    expect(shape.shown, 'field labels show beside the column header at desktop').toBe(0);
  });

  test('every picker in a row shares one top line, whatever the value above it', async ({
    page,
  }) => {
    // split-auto-routing-readout-setup D9: a cell is three rows of its row's subgrid —
    // value, picker + Clear, notes — so a long model id or a two-line inherit value in one
    // cell cannot push its picker below its neighbours'.
    await openTargetsMatrix(page);
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-testid="targets-row"]')].map((row) => ({
        row: row.dataset['row'] ?? '?',
        tops: [...row.querySelectorAll<HTMLElement>('.tm-picker')].map(
          (p) => p.getBoundingClientRect().top,
        ),
      })),
    );
    expect(rows).toHaveLength(MATRIX_ROWS);
    let measured = 0;
    for (const r of rows) {
      if (r.tops.length < 2) continue;
      measured += 1;
      expect(
        Math.max(...r.tops) - Math.min(...r.tops),
        `${r.row}: pickers do not share a top line (${r.tops.map((t) => t.toFixed(1)).join(', ')})`,
      ).toBeLessThanOrEqual(1);
    }
    // Non-vacuous: rows with two or more pickers exist in the worst-case fixture.
    expect(measured).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------------------
// Pipeline rows line up by construction (split-auto-routing-readout-setup D2). The list is
// one grid and every row a subgrid of its columns, so the assertions here are about EDGES:
// every action box at one position, every row's first line shared, and the phone records'
// one right edge. The geometry is read from the rendered rows, never from declarations.
// ---------------------------------------------------------------------------------------

type Box = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
};

/** Every Pipeline row's parts, as rendered boxes. The status and the name are read by their
 * FIRST line, so a status that wraps (or a savings block below) cannot hide a part that
 * left line one. */
async function pipelineRows(page: Page) {
  return page.evaluate(() => {
    const rect = (el: Element | null | undefined): Box | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      };
    };
    /** The first line box of an element's text. */
    const firstLine = (el: Element | null | undefined): Box | null => {
      if (!el) return null;
      const range = document.createRange();
      range.selectNodeContents(el);
      const lines = [...range.getClientRects()].filter((r) => r.width > 0);
      if (lines.length === 0) return null;
      const top = Math.min(...lines.map((r) => r.top));
      const first = lines.filter((r) => r.top < top + 2);
      return {
        left: Math.min(...first.map((r) => r.left)),
        right: Math.max(...first.map((r) => r.right)),
        top,
        bottom: Math.max(...first.map((r) => r.bottom)),
        width: 0,
        height: Math.max(...first.map((r) => r.bottom)) - top,
      };
    };
    return [...document.querySelectorAll<HTMLElement>('[data-testid="pipeline-stage"]')].map(
      (li) => ({
        stage: li.dataset['stage'] ?? '?',
        num: rect(li.querySelector('.ar-num')),
        name: firstLine(li.querySelector('.ar-name > div span')),
        status: firstLine(li.querySelector('.ar-status-line')),
        count: rect(li.querySelector('.ar-figcount')),
        action: rect(li.querySelector('.ar-action button')),
        dom: [...li.querySelectorAll('.ar-row > *')].map((e) => e.className.toString()),
      }),
    );
  });
}

type Rows = Awaited<ReturnType<typeof pipelineRows>>;

/** The action boxes' shared edges: one width, one height, one left and right edge. */
function actionEdgeProblems(rows: Rows, tolerance = 0.5): string[] {
  const boxes = rows.map((r) => r.action).filter((b): b is Box => b !== null);
  if (boxes.length !== rows.length)
    return [`${String(rows.length - boxes.length)} rows have no action box`];
  const out: string[] = [];
  for (const k of ['width', 'height', 'left', 'right'] as const) {
    const vals = boxes.map((b) => b[k]);
    if (Math.max(...vals) - Math.min(...vals) > tolerance)
      out.push(`action ${k} differs: ${vals.map((v) => v.toFixed(1)).join(', ')}`);
  }
  return out;
}

/** Two boxes share a line when they overlap vertically. */
const sameLine = (a: Box, b: Box): boolean => a.top < b.bottom - 1 && b.top < a.bottom - 1;

/** How many column tracks the Pipeline grid has — each `pipeline-fit` mode restates them
 * (one-line 7, two-line 6, phone 3), which only works when the container is the wrapper. */
async function pipelineTracks(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      getComputedStyle(document.querySelector('.ar-stages')!)
        .gridTemplateColumns.split(' ')
        .filter(Boolean).length,
  );
}

async function openPipeline(page: Page, query = ''): Promise<void> {
  await open(page, '#/routing', query);
  await openRoutingSection(page, 'Auto routing');
  await page.locator('[data-testid="pipeline-stage"] [data-testid="stage-bar"]').first().waitFor();
}

test.describe('Pipeline rows at desktop width', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('the six action boxes share their edges, and every first line holds its row', async ({
    page,
  }) => {
    await openPipeline(page);
    expect(await pipelineTracks(page), 'the one-line tracks').toBe(7);
    const rows = await pipelineRows(page);
    expect(rows).toHaveLength(6);
    expect(actionEdgeProblems(rows), 'action boxes').toEqual([]);
    for (const r of rows) {
      const at = `stage ${r.stage}`;
      for (const part of ['num', 'name', 'status', 'count', 'action'] as const)
        expect(r[part], `${at}: no ${part}`).not.toBeNull();
      // One line: number, name, first status line, count and action all overlap it — even
      // where the row's status wraps or Cascade's savings block follows below.
      const line = r.action!;
      for (const part of ['num', 'name', 'status', 'count'] as const)
        expect(sameLine(r[part]!, line), `${at}: ${part} left the row's first line`).toBe(true);
      expect(line.height, `${at}: the action is under the base target`).toBeGreaterThanOrEqual(24);
      expect(line.width, `${at}: the action box is not its track`).toBeGreaterThanOrEqual(95.5);
    }
    // The Cascade row really does carry a later line here (its savings block), so the
    // first-line assertion above covered the case it exists for.
    expect(await page.locator('[data-stage="cascade"] [data-testid="auto-savings"]').count()).toBe(
      1,
    );
  });

  test('a mutation back to the 88px right-aligned slot is caught', async ({ page }) => {
    // The defect this change fixed: a right-aligned flex slot whose buttons were as wide as
    // their labels, so Details and Targets ended at one edge and started at two.
    await openPipeline(page);
    await page.addStyleTag({
      content:
        '.ar-action{display:flex !important;justify-content:flex-end !important}.ar-act{width:auto !important}',
    });
    expect(actionEdgeProblems(await pipelineRows(page)).length).toBeGreaterThan(0);
  });
});

for (const vp of [
  { name: '1025x768', width: 1025, height: 768, comfort: false },
  { name: '768x1024', width: 768, height: 1024, comfort: true },
] as const) {
  test.describe(`Pipeline rows in two-line mode @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('the status takes line two; number, name, count and action keep line one', async ({
      page,
    }) => {
      await openPipeline(page);
      expect(await pipelineTracks(page), 'the two-line tracks were not restated').toBe(6);
      const rows = await pipelineRows(page);
      expect(rows).toHaveLength(6);
      expect(actionEdgeProblems(rows), 'action boxes').toEqual([]);
      for (const r of rows) {
        const at = `stage ${r.stage} at ${vp.name}`;
        const line = r.action!;
        for (const part of ['num', 'name', 'count'] as const)
          expect(sameLine(r[part]!, line), `${at}: ${part} left line one`).toBe(true);
        expect(r.status!.top, `${at}: the status did not move to line two`).toBeGreaterThanOrEqual(
          Math.max(r.name!.bottom, r.num!.bottom) - 0.5,
        );
        expect(line.height, `${at}: action height`).toBeGreaterThanOrEqual(vp.comfort ? 44 : 24);
      }
    });

    test('a container moved onto the grid itself is caught', async ({ page }) => {
      // The container must be the WRAPPER: a container query styles only descendants, so
      // on the grid it could never restate the grid's own tracks, and the rows would stay
      // one-line here.
      await openPipeline(page);
      await page.addStyleTag({
        content:
          '.ar-pipeline{container-type:normal !important;container-name:none !important}.ar-stages{container-type:inline-size;container-name:rs-pipeline}',
      });
      // The child placements still fire (they are the container's descendants), but the
      // grid's own tracks cannot be restated from a query on itself.
      expect(await pipelineTracks(page), 'the mutation went unnoticed').not.toBe(6);
    });
  });
}

test.describe('Pipeline rows under a coarse pointer above narrow', () => {
  test.use({ viewport: { width: 1440, height: 900 }, hasTouch: true, isMobile: false });

  test('the action boxes grow to the comfort target and keep their edges', async ({ page }) => {
    await openPipeline(page);
    const rows = await pipelineRows(page);
    expect(actionEdgeProblems(rows)).toEqual([]);
    for (const r of rows) {
      expect(r.action!.height, `stage ${r.stage}`).toBeGreaterThanOrEqual(44);
      expect(r.action!.width, `stage ${r.stage}`).toBeGreaterThanOrEqual(95.5);
    }
  });
});

for (const vp of [
  { name: '320x568', width: 320, height: 568 },
  { name: '390x844', width: 390, height: 844 },
] as const) {
  test.describe(`Pipeline rows as phone records @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('one 44x44 disclosure per row on one right edge, in DOM order', async ({ page }) => {
      await openPipeline(page);
      expect(await pipelineTracks(page), 'the phone tracks were not restated').toBe(3);
      const rows = await pipelineRows(page);
      expect(rows).toHaveLength(6);
      const actions = rows.map((r) => r.action!);
      for (const [i, a] of actions.entries()) {
        const at = `stage ${rows[i]!.stage} at ${vp.name}`;
        expect(a.width, `${at}: width`).toBeGreaterThanOrEqual(44);
        expect(a.height, `${at}: height`).toBeGreaterThanOrEqual(44);
        expect(Math.abs(a.right - actions[0]!.right), `${at}: right edge`).toBeLessThanOrEqual(0.5);
      }
      for (const r of rows) {
        const at = `stage ${r.stage} at ${vp.name}`;
        // Line one: number, name, action. Then the status; then the figure.
        expect(sameLine(r.num!, r.action!), `${at}: action left line one`).toBe(true);
        expect(sameLine(r.name!, r.action!), `${at}: name left line one`).toBe(true);
        expect(r.status!.top, `${at}: status above line one`).toBeGreaterThanOrEqual(r.action!.top);
        if (r.count)
          expect(r.count.top, `${at}: figure above the status`).toBeGreaterThanOrEqual(
            r.status!.top,
          );
        // Visual order equals DOM order: number, name, action, status, figure.
        expect(r.dom.slice(0, 4), `${at}: DOM order`).toEqual([
          'ar-num',
          'ar-name',
          'ar-action',
          'ar-status',
        ]);
      }
      // Each action is named — on a phone it is icon-only.
      const names = await page
        .locator('[data-testid="pipeline-stage"] .ar-action button')
        .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
      expect(names).toEqual([
        'Classify details',
        'Workload claim details',
        'Go to Targets, Strong column',
        'Semantic details',
        'Cascade details',
        'Default details',
      ]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, 'the document overflows').toBeLessThanOrEqual(1);
    });

    test('the Layer-0 note keeps an even line rhythm around its link', async ({ page }) => {
      // Its "Tiers & headers" button keeps the 44px comfort floor on its box; before the
      // fix that box also set its LINE's height, so the sentence read with one ragged gap.
      await open(page, '#/routing');
      await openRoutingSection(page, 'Auto routing');
      const m = await page.evaluate(() => {
        const note = document.querySelector('[data-testid="layer0-note"]');
        if (!note) return null;
        const tops = new Set<number>();
        const walker = document.createTreeWalker(note, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (!(n.textContent ?? '').trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          for (const r of range.getClientRects()) tops.add(Math.round(r.top));
        }
        // Fragments of one line can differ by a pixel (mono vs sans); fold them.
        const lines = [...tops]
          .sort((a, b) => a - b)
          .filter((t, i, a) => i === 0 || t - a[i - 1]! > 3);
        const btn = note.querySelector('button');
        return {
          gaps: lines.slice(1).map((t, i) => t - lines[i]!),
          btn: btn ? btn.getBoundingClientRect().height : 0,
        };
      });
      expect(m, 'no Layer-0 note').not.toBeNull();
      expect(m!.gaps.length, 'the note should wrap at phone width').toBeGreaterThan(0);
      expect(m!.btn, 'the link lost its comfort target').toBeGreaterThanOrEqual(44);
      const spread = Math.max(...m!.gaps) - Math.min(...m!.gaps);
      expect(spread, `uneven note lines: ${m!.gaps.join(', ')}`).toBeLessThanOrEqual(1);
    });
  });
}

/* ---- the Pipeline's designed states (adopt-figure-states task 4.3; design Risk "Wider
 * strings in fixed tracks") ----
 *
 * `?auto=zero` (browserHarness.tsx) is a range with nothing evaluated: the `No requests`
 * notice, and every stage share reading the words `not applicable` — wider than the 40px
 * share track, so they take the share and bar tracks (a zero range draws no bar). `?auto=legacy`
 * is an older server with no stage breakdown: the `Unavailable` notice, and no per-stage figure
 * on stages 2–6. Each is measured at the phone, two-line and one-line widths: the notice and the
 * words inside the pane, the words on one line beside their count, and nothing clipped. */
async function openPipelineState(page: Page, query: string, notice: string): Promise<void> {
  await open(page, '#/routing', query);
  await openRoutingSection(page, 'Auto routing');
  await page.waitForSelector(`[data-testid="${notice}"]`);
}

for (const vp of [MATRIX[0], MATRIX[3], MATRIX[4]]) {
  test.describe(`the Pipeline's zero and unavailable states stay whole @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('a zero range: the `No requests` notice, and `not applicable` on one line beside each count', async ({
      page,
    }) => {
      await openPipelineState(page, '?auto=zero', 'auto-zero');
      const notice = page.locator('[data-testid="auto-zero"]');
      await expect(notice.locator('.notice-title')).toHaveText('No requests');
      const geom = await paneOverflow(page, '[data-testid="auto-zero"]');
      expect(geom.hidden.concat(geom.clipped, geom.escapes), 'the notice escapes').toEqual([]);
      const rows = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('[data-testid="pipeline-stage"]')].map((li) => {
          const share = li.querySelector<HTMLElement>('.ar-figshare');
          const count = li.querySelector<HTMLElement>('.ar-figcount');
          const action = li.querySelector<HTMLElement>('.ar-action');
          const pane = document.querySelector('[data-pane="content"]')!.getBoundingClientRect();
          const lines = (el: HTMLElement | null): number => {
            if (!el) return 0;
            const range = document.createRange();
            range.selectNodeContents(el);
            const tops = [...range.getClientRects()].filter((r) => r.width > 0).map((r) => r.top);
            return new Set(tops.map((t) => Math.round(t))).size;
          };
          const s = share?.getBoundingClientRect();
          const c = count?.getBoundingClientRect();
          const a = action?.getBoundingClientRect();
          return {
            stage: li.dataset['stage'] ?? '?',
            share: share?.textContent ?? null,
            shareLines: lines(share),
            shareInk: share ? getComputedStyle(share).color : null,
            inPane: s ? s.left >= pane.left - 1 && s.right <= pane.right + 1 : true,
            clips: share ? share.scrollWidth > share.clientWidth + 1 : false,
            besideCount: s && c ? s.top < c.bottom && c.top < s.bottom : true,
            // In the grid layouts the action keeps its own track to the right of the figure.
            clearOfAction:
              s && a && getComputedStyle(li.querySelector('.ar-fig')!).display !== 'flex'
                ? s.right <= a.left + 1
                : true,
          };
        }),
      );
      expect(rows).toHaveLength(6);
      const later = rows.slice(1);
      expect(later.map((r) => r.share)).toEqual(Array<string>(5).fill('not applicable'));
      for (const r of later) {
        const at = `stage ${r.stage} @ ${vp.name}`;
        expect(r.shareLines, `${at}: not applicable wraps`).toBe(1);
        expect(r.inPane, `${at}: the share escapes the pane`).toBe(true);
        expect(r.clips, `${at}: the share is clipped`).toBe(false);
        expect(r.besideCount, `${at}: the share left its count's line`).toBe(true);
        expect(r.clearOfAction, `${at}: the share runs into the action track`).toBe(true);
      }
      // The words are Ink 3, not the share's Ink 2: compared as resolved colours.
      const ink = await page.evaluate(() => {
        const resolve = (v: string): string => {
          const probe = document.createElement('span');
          probe.style.color = `var(${v})`;
          document.body.append(probe);
          const c = getComputedStyle(probe).color;
          probe.remove();
          return c;
        };
        return { ink2: resolve('--text2'), ink3: resolve('--text3') };
      });
      expect(ink.ink3).not.toBe(ink.ink2);
      for (const r of later) expect(r.shareInk, `stage ${r.stage}: share ink`).toBe(ink.ink3);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, 'the document overflows').toBeLessThanOrEqual(1);
    });

    test('no stage breakdown: the `Unavailable` notice, and no figure on stages 2–6', async ({
      page,
    }) => {
      await openPipelineState(page, '?auto=legacy', 'auto-unavailable');
      const notice = page.locator('[data-testid="auto-unavailable"]');
      await expect(notice.locator('.notice-title')).toHaveText('Unavailable');
      await expect(notice.locator('button')).toHaveCount(0);
      const geom = await paneOverflow(page, '[data-testid="auto-unavailable"]');
      expect(geom.hidden.concat(geom.clipped, geom.escapes), 'the notice escapes').toEqual([]);
      const figures = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('[data-testid="pipeline-stage"]')].map(
          (li) =>
            li.querySelector('[data-testid="stage-figure"] .ar-figcount')?.textContent?.trim() ??
            null,
        ),
      );
      expect(figures).toHaveLength(6);
      expect(figures[0], 'Classify still counts the range').toBe('40');
      expect(figures.slice(1), 'stages 2–6 carry no figure').toEqual(Array<null>(5).fill(null));
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, 'the document overflows').toBeLessThanOrEqual(1);
    });
  });
}

for (const vp of MATRIX) {
  test.describe(`the Pipeline keeps its list semantics @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('one list of exactly six items, the column header excluded', async ({ page }) => {
      // Computed role semantics (not a DOM count): the `ol` carries an explicit `role="list"`
      // because WebKit drops list semantics from a marker-less list. This rig runs Chromium
      // only, so WebKit is covered by that role, not by this test.
      await openPipeline(page);
      const pipeline = page.locator('[data-testid="auto-pipeline"]');
      await expect(pipeline.getByRole('list')).toHaveCount(1);
      await expect(pipeline.getByRole('list').getByRole('listitem')).toHaveCount(6);
    });
  });
}

// ---------------------------------------------------------------------------------------
// Settings layout (compact-settings-layout). The Settings page was a 760px column of four
// stacked panels with a near-full-width <select> per agent; it now uses the standard 1200px
// container and, above the narrow threshold, two columns under a full-width Instance strip.
// Everything here runs against `?bodies=1`: capture on and eight agents, so the override grid
// has rows and columns to measure. With the default fixture (one agent, capture off) most of
// these assertions would pass for the wrong reason.
// ---------------------------------------------------------------------------------------

async function openSettings(page: Page): Promise<void> {
  await open(page, '#/settings', '?bodies=1');
  await page.waitForSelector('[data-testid="instance-strip"]');
  await page.waitForSelector('select[aria-label^="Capture override for"]');
}

/** Rendered box of the Settings panel carrying exactly this title. */
async function settingsPanel(page: Page, title: string) {
  const panel = page
    .locator('.rs-page .panel')
    .filter({ has: page.locator('.section-title', { hasText: new RegExp(`^\\s*${title}\\s*$`) }) })
    .first();
  const box = await panel.boundingBox();
  expect(box, `the "${title}" panel did not render`).not.toBeNull();
  return box!;
}

async function overrideSelectBoxes(page: Page) {
  const boxes = await page
    .locator('select[aria-label^="Capture override for"]')
    .evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    );
  expect(boxes, 'the fixture must render all eight agents').toHaveLength(8);
  return boxes;
}

for (const vp of MATRIX) {
  test.describe(`Settings layout @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('does not overflow the document or its pane, and every control meets its floor', async ({
      page,
    }) => {
      await openSettings(page);
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(overflow.scrollWidth, `Settings overflows at ${vp.name}`).toBeLessThanOrEqual(
        overflow.clientWidth + 1,
      );
      const escapes = await page.evaluate(() => {
        const pane = document.querySelector('[data-pane="content"]');
        if (!pane) return ['no content pane'];
        const right = pane.getBoundingClientRect().right;
        const out: string[] = [];
        for (const el of pane.querySelectorAll('*')) {
          const s = getComputedStyle(el);
          if (s.position === 'fixed' || s.position === 'absolute') continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0) continue;
          if (r.right > right + 1)
            out.push(`${el.tagName} over=${String(Math.round(r.right - right))}`);
        }
        return out;
      });
      expect(escapes, `in-flow Settings content escapes its pane at ${vp.name}`).toEqual([]);
      // 24px at every width; 44px in the block axis at or below the narrow threshold.
      const floor = vp.width <= 768 ? 44 : 24;
      const small = await page.evaluate((min) => {
        const out: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>(
          '[data-pane="content"] button, [data-pane="content"] select, [data-pane="content"] a[href]',
        )) {
          if (el.classList.contains('toggle')) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.height + 0.5 < min) out.push(`${el.tagName} ${String(Math.round(r.height))}px`);
        }
        return out;
      }, floor);
      expect(small, `Settings controls under ${String(floor)}px at ${vp.name}`).toEqual([]);

      // The sweeps skip bare radios (a locked exception), so the mode options carry their own
      // 24px floor on the LABEL; nothing else would notice it shrinking back to ~16px.
      const labelHeights = await page
        .locator('[role="radiogroup"][aria-label="Capture mode"] label')
        .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
      expect(labelHeights, 'the three mode options must render').toHaveLength(3);
      for (const h of labelHeights) {
        expect(
          h + 0.5,
          `a mode option label is ${String(h)}px tall at ${vp.name}`,
        ).toBeGreaterThanOrEqual(24);
      }
    });
  });
}

test.describe('Settings layout: wide', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('uses the standard page width, as wide as another page, and wider than 760px', async ({
    page,
  }) => {
    await openSettings(page);
    const settings = await page.locator('.rs-page').first().boundingBox();
    await page.goto('/browser-harness.html#/agents');
    await page.waitForSelector('html[data-harness-ready="true"]');
    const agents = await page.locator('.rs-page').first().boundingBox();
    expect(settings!.width, 'Settings kept its 760px cap').toBeGreaterThan(760);
    expect(Math.abs(settings!.width - agents!.width)).toBeLessThanOrEqual(1);
  });

  test('two columns under a full-width Instance strip: Bodies left; Notifications over Pricing right', async ({
    page,
  }) => {
    await openSettings(page);
    const instance = await settingsPanel(page, 'Instance');
    const bodies = await settingsPanel(page, 'Prompt & response bodies');
    const notify = await settingsPanel(page, 'Notifications');
    const pricing = await settingsPanel(page, 'Pricing catalog');

    // Instance spans both columns and sits above them.
    expect(instance.width).toBeGreaterThanOrEqual(bodies.width + notify.width);
    expect(bodies.y).toBeGreaterThanOrEqual(instance.y + instance.height - 1);
    expect(notify.y).toBeGreaterThanOrEqual(instance.y + instance.height - 1);
    // Bodies is a column to the LEFT of the right-hand panels, and they share a top edge.
    expect(bodies.x + bodies.width).toBeLessThanOrEqual(notify.x + 1);
    expect(Math.abs(bodies.y - notify.y)).toBeLessThanOrEqual(1);
    // Notifications and Pricing stack in the right column, same left edge and width.
    expect(pricing.y).toBeGreaterThanOrEqual(notify.y + notify.height - 1);
    expect(Math.abs(pricing.x - notify.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(pricing.width - notify.width)).toBeLessThanOrEqual(1);
  });

  test('the page is shorter than one tall bar per agent would make it', async ({ page }) => {
    await openSettings(page);
    const bodies = await settingsPanel(page, 'Prompt & response bodies');
    const selects = await overrideSelectBoxes(page);
    // Eight agents in 2+ columns: strictly fewer rows than agents.
    const rows = new Set(selects.map((s) => Math.round(s.y))).size;
    expect(rows, 'overrides still occupy a row per agent').toBeLessThan(selects.length);
    expect(bodies.height).toBeLessThan(560);
  });

  test('override selects take their content width and flow in more than one column', async ({
    page,
  }) => {
    await openSettings(page);
    const selects = await overrideSelectBoxes(page);
    for (const s of selects) expect(s.width).toBeLessThanOrEqual(160);
    const columns = new Set(selects.map((s) => Math.round(s.x))).size;
    expect(columns, 'overrides sit in one column').toBeGreaterThanOrEqual(2);
    const retention = await page.locator('select[aria-label="Retention"]').boundingBox();
    expect(retention!.width).toBeLessThanOrEqual(160);
  });

  test('the mode options sit in one row', async ({ page }) => {
    await openSettings(page);
    const ys = await page
      .locator('[role="radiogroup"][aria-label="Capture mode"] label')
      .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().y)));
    expect(ys).toHaveLength(3);
    expect(new Set(ys).size, 'the three mode options wrapped onto separate rows').toBe(1);
  });

  test('no second "30 days" beside the retention select', async ({ page }) => {
    await openSettings(page);
    const text = await page
      .locator('select[aria-label="Retention"]')
      .evaluate((el) => (el.parentElement?.textContent ?? '').replace(/\s+/g, ' ').trim());
    // The select's own options are its only text; nothing trails it.
    expect(await page.locator('select[aria-label="Retention"] ~ span').count()).toBe(0);
    expect(text).toContain('30 days');
  });
});

test.describe('Settings layout: at the threshold and below', () => {
  test('at 1025px the panels are still two columns and nothing is clipped', async ({ page }) => {
    await page.setViewportSize({ width: 1025, height: 768 });
    await openSettings(page);
    const bodies = await settingsPanel(page, 'Prompt & response bodies');
    const notify = await settingsPanel(page, 'Notifications');
    expect(bodies.x + bodies.width).toBeLessThanOrEqual(notify.x + 1);
    expect(notify.x + notify.width).toBeLessThanOrEqual(1025);
  });

  test('at 390px the panels stack in one column in the order Instance, Bodies, Notifications, Pricing', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSettings(page);
    const boxes = [
      await settingsPanel(page, 'Instance'),
      await settingsPanel(page, 'Prompt & response bodies'),
      await settingsPanel(page, 'Notifications'),
      await settingsPanel(page, 'Pricing catalog'),
    ];
    for (let i = 1; i < boxes.length; i += 1) {
      expect(
        boxes[i]!.y,
        `panel ${String(i)} is not below panel ${String(i - 1)}`,
      ).toBeGreaterThanOrEqual(boxes[i - 1]!.y + boxes[i - 1]!.height - 1);
      expect(Math.abs(boxes[i]!.x - boxes[0]!.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(boxes[i]!.width - boxes[0]!.width)).toBeLessThanOrEqual(1);
    }
  });
});
