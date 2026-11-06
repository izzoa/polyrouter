/** The height family, measured (adopt-design-tokens-v2 tasks 4.1, 4.2 and 4.4; design.md D4;
 * dashboard-core "Interactive controls share one height family").
 *
 * Controls are found by their SEMANTICS, never by a class list (D4): a class list only ever
 * covers the controls somebody remembered to class, which is how a bare `<button>` once
 * shipped at 22px. Every visible match must measure a member of the family:
 *
 *   32px  default — primary and secondary buttons, inputs, selects, nav items, the segmented
 *         track;
 *   24px  small inline — ghost buttons, filter chips, the endpoint chip, the Live pill, a small
 *         select in a row of 24px controls (`select--sm`), text-link buttons;
 *   26px  a segmented option, inside its 32px track's 1px edge and 2px inset;
 *   20px  the switch's drawn track (18px small), which meets the floors by hit area.
 *
 * Static chips are 20px and are not controls; checkboxes and radios are outside the family.
 * A control that carries a role class is held to that role's own height (`ROLE_HEIGHTS`), not
 * just to some member of the family: a primary at 24px or a ghost at 32px fails.
 *
 * EXACT, not a tolerance (`geometry-contract.ts`, ci-pipeline "Browser geometry assertions are
 * typed"). The classification was MEASURED, not assumed: every height below is a border-box
 * `min-height` filled by a derived padding around an explicit 1rem line (a select's by an
 * explicit `height`), so text layout does not enter it. On 2026-11-02 the whole family sweep
 * was re-run with three other faces forced on every element from page load (Verdana, Georgia,
 * Courier New) and not one control height moved (`notes/lane-g4-font-substitution.txt`), and
 * the macOS `@capture` run printed the same set (`geometryCapture.spec.ts`, "height family").
 * The CI runner's half of the capture runs on the first push.
 *
 * Widths are never pinned here: a label's width is text layout. The one width assertion — a
 * busy button keeps its width — compares the same button with itself in one run.
 */
import { expect, test, type Page } from '@playwright/test';
import { SURFACES, harnessUrl } from './overlays';

/** D4's semantic enumeration. `a.btn-*` reads as any anchor styled as a button. */
const CONTROLS =
  'button, [role="button"], input:not([type="checkbox"]):not([type="radio"]), select, textarea, ' +
  '[role="switch"], [role="combobox"], [aria-pressed], [aria-current], a[class*="btn-"]';

/** Controls that are not single-line, so the family does not govern them — each with the
 * requirement that does. Matched by selector, but bounded: every listed selector must still
 * match a rendered element (a stale entry fails), and every element it exempts must be
 * taller than the family's tallest member (a single-line control cannot hide behind it). */
const NOT_SINGLE_LINE: readonly { sel: string; why: string }[] = [
  {
    sel: 'button.req-row',
    why: 'a record-table row: "Record tables share one row…" sets rows of at least 32px',
  },
  { sel: 'button.setup-card', why: 'a two-line card: "Setup guide" over its progress line' },
  { sel: 'button.kind-card', why: 'a two-line option card: the kind over its description' },
  {
    sel: 'textarea',
    why: 'a multi-line field by nature: the channel modal’s Apprise URLs (Apprise kind only)',
  },
];

const SEGMENT_OPTION = 26;
const FAMILY = [24, 32] as const;
/** Each role's OWN height (dashboard-core scenario "Default and small controls take their
 * family height"; DESIGN.md Control heights). Family membership alone would pass a primary
 * drawn at 24px or a ghost at 32px; a control that carries one of these classes must measure
 * its role's height. First match wins, so the small select is read before the select. */
const ROLE_HEIGHTS: readonly (readonly [string, 24 | 32])[] = [
  ['.select--sm', 24],
  ['.btn-primary', 32],
  ['.btn-cancel', 32],
  ['.input', 32],
  ['.select', 32],
  ['.mp-input', 32],
  ['.nav-item', 32],
  ['.menu-item', 32],
  ['.account-trigger', 32],
  ['.btn-ghost', 24],
  ['.filter-chip', 24],
  ['.endpoint-chip', 24],
  ['.live-pill', 24],
];
/** Controls held to family membership only, not to their role's own height, each with the
 * change that owns the fix. Bounded like `NOT_SINGLE_LINE`: each entry must still match a
 * rendered control (a stale entry fails the overlay sweep). */
const ROLE_EXCEPTIONS: readonly { sel: string; why: string }[] = [
  {
    sel: '[aria-label="Disable body capture"] button.btn-ghost',
    why:
      'the keep-or-purge dialog\'s "Keep until retention" ghost is stretched to its row\'s 32px ' +
      'beside Cancel and Purge now; adopt-red-destructive-actions task 4.4 rebuilds the ' +
      'dialog with it as the 32px secondary action',
  },
];
const SWITCH_TRACK = { 'toggle--md': { w: 36, h: 20 }, 'toggle--sm': { w: 32, h: 18 } } as const;
/** EXACT: whole pixels, with only float noise allowed (see the header). */
const EXACT = 0.05;

interface Measured {
  name: string;
  kind: 'switch' | 'option' | 'control' | 'exempt';
  h: number;
  w: number;
  track?: string;
  exemptBy?: string;
  /** The role class that fixes this control's own height, when it carries one. */
  role?: string;
  /** The `ROLE_EXCEPTIONS` entry that holds it to family membership only. */
  roleExemptBy?: string;
}

/** Every visible control in `scope`, measured and classified. */
async function measure(page: Page, scope: string | null): Promise<Measured[]> {
  return page.evaluate(
    ({ sel, scope, exempt, roles, roleExempt }) => {
      const root: ParentNode = scope ? (document.querySelector(scope) ?? document) : document;
      const out: Measured[] = [];
      for (const el of root.querySelectorAll<HTMLElement>(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue; // not rendered in this state
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'contents') continue;
        const label = (el.getAttribute('aria-label') ?? el.textContent ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 40);
        const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean);
        const name = `${el.tagName.toLowerCase()}${cls.length ? '.' + cls.join('.') : ''} "${label}"`;
        const by = exempt.find((x) => el.matches(x));
        if (by !== undefined) {
          out.push({ name, kind: 'exempt', h: r.height, w: r.width, exemptBy: by });
          continue;
        }
        if (el.getAttribute('role') === 'switch') {
          const size = cls.find((c) => c === 'toggle--md' || c === 'toggle--sm') ?? 'unsized';
          out.push({ name, kind: 'switch', h: r.height, w: r.width, track: size });
          continue;
        }
        const inTrack = el.parentElement?.classList.contains('seg-track') === true;
        const roleExemptBy = roleExempt.find((x) => el.matches(x));
        const role = roleExemptBy === undefined ? roles.find((x) => el.matches(x)) : undefined;
        out.push({
          name,
          kind: el.hasAttribute('aria-pressed') && inTrack ? 'option' : 'control',
          h: r.height,
          w: r.width,
          ...(role !== undefined ? { role } : {}),
          ...(roleExemptBy !== undefined ? { roleExemptBy } : {}),
        });
      }
      return out;
    },
    {
      sel: CONTROLS,
      scope,
      exempt: NOT_SINGLE_LINE.map((x) => x.sel),
      roles: ROLE_HEIGHTS.map(([r]) => r),
      roleExempt: ROLE_EXCEPTIONS.map((x) => x.sel),
    },
  );
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < EXACT;

/** The defects in one state: every control that is not a family member, named with its
 * measured height. */
function offFamily(rows: readonly Measured[]): string[] {
  const bad: string[] = [];
  for (const m of rows) {
    if (m.kind === 'exempt') {
      // A single-line control cannot hide behind an exemption.
      if (m.h <= 32 + EXACT)
        bad.push(`${m.name} is exempt as ${m.exemptBy ?? ''} but ${String(m.h)}px tall`);
      continue;
    }
    if (m.kind === 'switch') {
      const want = SWITCH_TRACK[m.track as keyof typeof SWITCH_TRACK] as
        { w: number; h: number } | undefined;
      if (want === undefined) bad.push(`${m.name} has no size class (${m.track ?? ''})`);
      else if (!near(m.h, want.h) || !near(m.w, want.w))
        bad.push(
          `${m.name} draws ${String(m.w)}x${String(m.h)}, not ${String(want.w)}x${String(want.h)}`,
        );
      continue;
    }
    if (m.kind === 'option') {
      if (!near(m.h, SEGMENT_OPTION))
        bad.push(`${m.name} is ${String(m.h)}px, not the 26px option`);
      continue;
    }
    const own = ROLE_HEIGHTS.find(([r]) => r === m.role)?.[1];
    if (own !== undefined) {
      if (!near(m.h, own))
        bad.push(
          `${m.name} is ${String(m.h)}px, not its role's ${String(own)}px (${m.role ?? ''})`,
        );
      continue;
    }
    if (!FAMILY.some((f) => near(m.h, f))) bad.push(`${m.name} is ${String(m.h)}px`);
  }
  return bad;
}

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

/** Every page, and every state of a page the family must hold in: Routing's two tabs (each
 * mounts only when shown) with every stage detail open and both tuning drawers, the
 * providers page with a provider card, and Limits with budget cards. Yields a label per
 * state with the page already in it. */
async function* pageStates(page: Page): AsyncGenerator<string> {
  for (const name of ['overview', 'requests', 'batches', 'costs', 'agents', 'settings', 'users']) {
    await open(page, `/browser-harness.html#/${name}`);
    yield name;
  }
  // The Setup guide, every step: step 2 is the provider form and step 3 the test request.
  await open(page, '/browser-harness.html#/setup');
  for (const step of [1, 2, 3]) {
    await store(page, 'obGo', step);
    yield `setup step ${String(step)}`;
  }
  // The signed-out pages, through the store's auth view (the harness boots signed in).
  await open(page, '/browser-harness.html#/overview');
  await store(page, 'setState', 'authView', 'gate');
  await page.locator('#f-login-email').waitFor({ state: 'visible' });
  yield 'sign-in';
  await store(page, 'setState', 'authView', 'invite');
  await page.locator('#f-invite-name').waitFor({ state: 'visible' });
  yield 'accept invite';
  await open(page, '/browser-harness.html?targets=1#/providers');
  yield 'providers (with a provider card)';
  await open(page, '/browser-harness.html?budget=progress#/limits');
  await expect(page.locator('.budget-card').first()).toBeVisible();
  yield 'limits (with budget cards)';
  for (const query of ['?semantic=1', '?targets=1']) {
    await open(page, `/browser-harness.html${query}#/routing`);
    await store(page, 'setRoutingSection', 'tiers');
    yield `routing${query}/tiers`;
    await store(page, 'setRoutingSection', 'auto');
    await page.waitForSelector('[data-testid="pipeline-stage"]');
    const closed = page.locator('button.ar-expander[aria-expanded="false"]');
    for (let i = 0; i < 8 && (await closed.count()) > 0; i += 1) await closed.first().click();
    await expect(closed).toHaveCount(0);
    yield `routing${query}/auto`;
    if (query !== '?semantic=1') continue;
    for (const drawer of ['calibration', 'learning'] as const) {
      await page.locator(`[data-testid="tuning-entry"][data-tuning="${drawer}"]`).click();
      await page
        .locator(`[data-testid="tuning-drawer"][data-tuning="${drawer}"]`)
        .waitFor({ state: 'visible' });
      await page.waitForTimeout(250);
      yield `routing/auto/drawer:${drawer}`;
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-testid="tuning-drawer"]')).toHaveCount(0);
    }
  }
}

test.describe('every single-line control is a height-family member (1440x900)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('on every page and in every page state', async ({ page }) => {
    test.setTimeout(120_000);
    const seen = new Set<string>();
    let switches = 0;
    let options = 0;
    for await (const state of pageStates(page)) {
      const rows = await measure(page, null);
      expect(rows.length, `${state} rendered no controls at all`).toBeGreaterThan(0);
      for (const r of rows) {
        if (r.exemptBy !== undefined) seen.add(r.exemptBy);
        if (r.kind === 'switch') switches += 1;
        if (r.kind === 'option') options += 1;
      }
      expect(offFamily(rows), `controls outside the height family on ${state}`).toEqual([]);
    }
    // Not vacuous: the two named members were actually measured somewhere.
    expect(switches, 'no switch was measured').toBeGreaterThan(0);
    expect(options, 'no segmented option was measured').toBeGreaterThan(0);
    // A stale exemption is a hole: every entry must still exempt something real.
    for (const { sel } of NOT_SINGLE_LINE.filter(
      (x) => x.sel !== 'textarea' && x.sel !== 'button.kind-card',
    )) {
      expect(seen.has(sel), `${sel} is exempt but never rendered on a page`).toBe(true);
    }
  });

  test('in every overlay surface', async ({ page }) => {
    test.setTimeout(120_000);
    const seen = new Set<string>();
    for (const s of SURFACES) {
      if (s.narrowOnly === true) continue;
      await open(page, harnessUrl(s));
      await s.open(page);
      await page.waitForTimeout(250);
      const rows = await measure(page, s.sel);
      for (const r of rows) {
        if (r.exemptBy !== undefined) seen.add(r.exemptBy);
        if (r.roleExemptBy !== undefined) seen.add(r.roleExemptBy);
      }
      expect(offFamily(rows), `controls outside the height family in ${s.name}`).toEqual([]);
    }
    for (const { sel } of ROLE_EXCEPTIONS)
      expect(seen.has(sel), `${sel} is a role exception but never rendered`).toBe(true);
    // The textarea renders only for an Apprise channel, so it is not required here.
    expect(seen.has('button.kind-card'), 'button.kind-card is exempt but never rendered').toBe(
      true,
    );
  });

  test('the segmented track is 32px, static chips 20px and the Live pill 24px', async ({
    page,
  }) => {
    for (const url of [
      '/browser-harness.html#/overview',
      '/browser-harness.html#/requests',
      '/browser-harness.html?budget=progress#/limits',
    ]) {
      await open(page, url);
      const sizes = await page.evaluate(() => {
        const h = (sel: string): number[] =>
          [...document.querySelectorAll(sel)]
            .map((e) => e.getBoundingClientRect().height)
            .filter((x) => x > 0);
        return { track: h('.seg-track'), chip: h('.chip'), pill: h('[data-testid="live-pill"]') };
      });
      expect(sizes.pill, `the Live pill on ${url}`).toEqual([24]);
      for (const t of sizes.track) expect(t, `a segmented track on ${url}`).toBe(32);
      for (const c of sizes.chip) expect(c, `a static chip on ${url}`).toBe(20);
    }
  });
});

/** A row's controls share one height and their tops agree; a shorter mark in it (a chip, a
 * switch, an icon) is centred on the row's centre line. Returns the defects. */
async function rowDefects(page: Page, rowSel: string): Promise<string[]> {
  return page.evaluate(
    ({ rowSel, sel }) => {
      const out: string[] = [];
      const rows = [...document.querySelectorAll<HTMLElement>(rowSel)].filter(
        (r) => r.getBoundingClientRect().height > 0,
      );
      if (rows.length === 0) return [`${rowSel} is not rendered`];
      for (const row of rows) {
        const controls = [...row.querySelectorAll<HTMLElement>(sel)]
          .filter((c) => c.getAttribute('role') !== 'switch')
          .map((c) => ({ c, r: c.getBoundingClientRect() }))
          .filter(({ r }) => r.height > 0);
        const label = (c: Element): string =>
          `${c.tagName.toLowerCase()} "${(c.textContent ?? c.getAttribute('aria-label') ?? '').trim().slice(0, 24)}"`;
        const first = controls[0];
        for (const { c, r } of controls.slice(1)) {
          if (first === undefined) break;
          if (Math.abs(r.height - first.r.height) > 0.05)
            out.push(
              `${rowSel}: ${label(c)} is ${String(r.height)}px beside ${label(first.c)} at ${String(first.r.height)}px`,
            );
          if (Math.abs(r.top - first.r.top) > 0.5)
            out.push(
              `${rowSel}: ${label(c)} top ${String(r.top)} vs ${label(first.c)} top ${String(first.r.top)}`,
            );
        }
        const box = row.getBoundingClientRect();
        const line =
          first !== undefined ? first.r.top + first.r.height / 2 : box.top + box.height / 2;
        for (const mark of row.querySelectorAll<HTMLElement>(
          ':scope > .chip, :scope > [role="switch"], :scope > svg, :scope > * > .chip',
        )) {
          const r = mark.getBoundingClientRect();
          if (r.height === 0) continue;
          const centre = r.top + r.height / 2;
          // Only a mark in a row TALLER than itself has anything to centre in.
          if (Math.abs(centre - line) > 0.5 && r.height < (first?.r.height ?? box.height))
            out.push(
              `${rowSel}: ${label(mark)} centre ${String(centre)} is off the row's ${String(line)}`,
            );
        }
      }
      return out;
    },
    { rowSel, sel: CONTROLS },
  );
}

test.describe('controls that share a row share a height (1440x900, task 4.2)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  // The four known mixed rows (design.md D4). Two are read on Routing: the Tiers & headers
  // tab's add-tier row and its header-rule form, each a text input beside a select or a
  // button. On Settings, the body-capture card's header and each per-agent override row.
  const ROWS: readonly { url: string; row: string; minControls: number }[] = [
    {
      url: '/browser-harness.html#/requests',
      row: '[data-testid="requests-filter-row"]',
      minControls: 3,
    },
    { url: '/browser-harness.html#/routing', row: '[data-testid="add-tier-row"]', minControls: 2 },
    {
      url: '/browser-harness.html#/routing',
      row: '[data-testid="header-rule-form"]',
      minControls: 3,
    },
    {
      url: '/browser-harness.html?budget=progress#/limits',
      row: '.budget-card-header',
      minControls: 0,
    },
    {
      url: '/browser-harness.html?budget=progress#/limits',
      row: '[data-testid="budget-actions"]',
      minControls: 2,
    },
    {
      url: '/browser-harness.html#/settings',
      row: '[data-testid="capture-header"]',
      minControls: 0,
    },
    {
      url: '/browser-harness.html#/settings',
      row: '[data-testid="capture-override"]',
      minControls: 1,
    },
  ];

  for (const { url, row, minControls } of ROWS) {
    test(`${row} on ${url.split('#/')[1] ?? url}`, async ({ page }) => {
      await open(page, url);
      await page.locator(row).first().waitFor({ state: 'visible' });
      const count = await page.locator(row).first().locator(CONTROLS).count();
      expect(count, `${row} holds fewer controls than it should`).toBeGreaterThanOrEqual(
        minControls,
      );
      expect(await rowDefects(page, row)).toEqual([]);
    });
  }
});

/** A larger root font grows a control instead of clipping its label (D4; dashboard-core "Text
 * follows the user's font-size setting"). At a 20px root every role scales by 1.25, so a field's
 * 1rem line is 20px: the input is 36px (20 + 2 × 7 + 2) and a select must grow with it, or its
 * `normal` line box (16.25px text in Chromium's select) is cut by a 16px content box and the
 * row splits 36 / 32px. The small select grows with the 24px filter chips beside it to 28px.
 * EXACT for the same reason as the family: each height is a declared sum around a 1rem line. */
test.describe('a 20px root grows every select with its row, never clipping it (1440x900)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  const ROWS: readonly { url: string; row: string; small: boolean }[] = [
    {
      url: '/browser-harness.html#/routing',
      row: '[data-testid="header-rule-form"]',
      small: false,
    },
    {
      url: '/browser-harness.html#/requests',
      row: '[data-testid="requests-filter-row"]',
      small: true,
    },
  ];

  for (const { url, row, small } of ROWS) {
    test(`${row} at a 20px root`, async ({ page }) => {
      await open(page, url);
      await page.locator(row).first().waitFor({ state: 'visible' });
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '20px';
      });
      await page.waitForTimeout(80);
      const selects = await page
        .locator(row)
        .first()
        .evaluate((r) =>
          [...r.querySelectorAll<HTMLElement>('select')].map((el) => {
            const cs = getComputedStyle(el);
            const box =
              el.getBoundingClientRect().height -
              parseFloat(cs.paddingTop) -
              parseFloat(cs.paddingBottom) -
              parseFloat(cs.borderTopWidth) -
              parseFloat(cs.borderBottomWidth);
            return {
              name: el.getAttribute('aria-label') ?? el.id,
              h: el.getBoundingClientRect().height,
              font: parseFloat(cs.fontSize),
              box,
            };
          }),
        );
      expect(selects.length, `${row} holds a select`).toBeGreaterThan(0);
      for (const s of selects) {
        expect(s.h, `${s.name} at a 20px root`).toBe(small ? 28 : 36);
        // A select's text sits on a `normal` line box, about 1.2 × its size: the content box
        // must hold it, or the descenders are cut.
        expect(
          s.box,
          `${s.name}: a ${String(s.box)}px content box for ${String(s.font)}px text`,
        ).toBeGreaterThanOrEqual(s.font * 1.2);
      }
      expect(await rowDefects(page, row)).toEqual([]);
    });
  }
});

/** The comfort context (dashboard-core "The comfort context grows every control"): every
 * control is at least 44px in the block axis, and the switch, which keeps its drawn track,
 * reaches 44 × 44 by hit area. */
let hitTested = 0;
async function comfortDefects(page: Page): Promise<string[]> {
  const rows = await measure(page, null);
  const out: string[] = [];
  for (const m of rows) {
    if (m.kind === 'switch') continue; // by hit area, below
    if (m.h < 44 - EXACT) out.push(`${m.name} is ${String(m.h)}px`);
  }
  const hits = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[role="switch"]')]
      .filter((t) => t.getBoundingClientRect().width > 0)
      .map((t) => {
        t.scrollIntoView({ block: 'center' });
        const r = t.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const owns = (x: number, y: number): boolean => {
          const el = document.elementFromPoint(x, y);
          return el === t || t.contains(el);
        };
        // A switch under an open drawer or sheet is obscured, not under-sized: it is hit-tested
        // in the state where it is on top.
        if (!owns(cx, cy)) return null;
        // The corners of a centred 44 × 44 square, half a pixel inside.
        const ok = [
          [-21.5, -21.5],
          [21.5, -21.5],
          [-21.5, 21.5],
          [21.5, 21.5],
        ].every(([dx, dy]) => owns(cx + (dx ?? 0), cy + (dy ?? 0)));
        return ok ? 'ok' : `${t.getAttribute('aria-label') ?? 'switch'} hit area under 44x44`;
      })
      .filter((x): x is string => x !== null),
  );
  hitTested += hits.filter((x) => x === 'ok').length;
  return [...out, ...hits.filter((x) => x !== 'ok')];
}

for (const ctx of [
  { name: 'below narrow (390x844)', use: { viewport: { width: 390, height: 844 } } },
  {
    name: 'under a coarse pointer (1440x900)',
    use: { viewport: { width: 1440, height: 900 }, hasTouch: true },
  },
] as const) {
  test.describe(`the comfort context grows every control: ${ctx.name}`, () => {
    test.use(ctx.use);

    test('every control is at least 44px, and the switch reaches 44x44 by hit area', async ({
      page,
    }) => {
      test.setTimeout(120_000);
      hitTested = 0;
      for await (const state of pageStates(page)) {
        expect(await comfortDefects(page), `under 44px on ${state}`).toEqual([]);
      }
      expect(hitTested, 'no switch was hit-tested').toBeGreaterThan(0);
    });
  });
}

test.describe('a busy button keeps its width (task 4.4, design.md D14)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the budget modal's Save holds its width while it reads Saving…", async ({ page }) => {
    await open(page, '/browser-harness.html#/limits');
    await store(page, 'openModal', 'newLimit');
    const save = page.locator('.modal-card button.btn-primary');
    await expect(save).toHaveAccessibleName('Create budget');
    const rest = await save.evaluate((el) => el.getBoundingClientRect().width);
    // Held busy through the harness store, so no request has to stay pending.
    await store(page, 'setState', 'bf', 'busy', true);
    await expect(save).toBeDisabled();
    await expect(save).toHaveAttribute('aria-busy', 'true');
    await expect(save).toHaveAccessibleName('Saving…');
    const busy = await save.evaluate((el) => el.getBoundingClientRect().width);
    expect(busy, 'the Save button changed width when it went busy').toBe(rest);
    await store(page, 'setState', 'bf', 'busy', false);
    await expect(save).toHaveAccessibleName('Create budget');
    expect(await save.evaluate((el) => el.getBoundingClientRect().width)).toBe(rest);
  });

  test('the endpoint chip holds its width while it reads Copied (task 4.5, D19)', async ({
    page,
  }) => {
    await open(page, '/browser-harness.html#/overview');
    const chip = page.locator('button.endpoint-chip');
    await expect(chip).toHaveAccessibleName('Copy endpoint URL');
    const rest = await chip.evaluate((el) => el.getBoundingClientRect().width);
    // The chip's own successful copy (the clipboard itself is not under test, so its write is
    // stubbed to succeed): `Copied` belongs to the chip's copy, never to a toast with the same
    // words raised elsewhere.
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.resolve() },
      });
    });
    await chip.click();
    await expect(chip.locator('.stacked-label-item[data-shown="true"]')).toHaveText('Copied');
    await expect(chip).toHaveAccessibleName('Copy endpoint URL');
    expect(await chip.evaluate((el) => el.getBoundingClientRect().width)).toBe(rest);
  });
});

/** Selecting moves nothing (task 6.1, design.md D8; dashboard-core "Selecting moves nothing").
 * Every member of a selectable group carries a 1px edge at rest, transparent or Control Edge,
 * so the Selected state only recolours it; and a segmented option holds its selected weight's
 * width whether or not it is selected (`.rs-seg::after`). Each group's members are measured,
 * then the selection is moved to every other member in turn, and no member may change its
 * box. EXACT: the boxes are the same elements in one run, compared with themselves. */
test.describe('selecting moves nothing (1440x900, task 6.1)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  interface Box {
    label: string;
    x: number;
    y: number;
    w: number;
    h: number;
  }
  const boxes = (page: Page, sel: string): Promise<Box[]> =>
    page.evaluate(
      (s) =>
        [...document.querySelectorAll<HTMLElement>(s)].map((el) => {
          const r = el.getBoundingClientRect();
          return {
            label: (el.dataset['label'] ?? el.textContent ?? '').trim().slice(0, 32),
            x: r.x,
            y: r.y,
            w: r.width,
            h: r.height,
          };
        }),
      sel,
    );
  /** Boxes relative to the group's first member: for a group whose surroundings change with
   * the choice (a provider kind swaps the fields above the cards), what the Selected state
   * must not move is the members' sizes and their places in the group. */
  const relativeTo = (all: readonly Box[]): Box[] => {
    const o = all[0];
    return o === undefined ? [] : all.map((b) => ({ ...b, x: b.x - o.x, y: b.y - o.y }));
  };
  const moved = (before: readonly Box[], after: readonly Box[]): string[] =>
    before.flatMap((b, i) => {
      const a = after[i];
      if (a === undefined) return [`"${b.label}" disappeared`];
      const d = (['x', 'y', 'w', 'h'] as const).filter((k) => !near(a[k], b[k]));
      return d.map((k) => `"${b.label}" ${k} ${String(b[k])} -> ${String(a[k])}`);
    });

  /** Moves the selection to every unselected member of `sel` in turn, and returns every member
   * box that changed against the first measurement. */
  async function sweep(
    page: Page,
    sel: string,
    opts: { min?: number; relative?: boolean } = {},
  ): Promise<string[]> {
    const minMembers = opts.min ?? 2;
    const read = async (): Promise<Box[]> => {
      const b = await boxes(page, sel);
      return opts.relative === true ? relativeTo(b) : b;
    };
    const before = await read();
    expect(before.length, `${sel} has members`).toBeGreaterThanOrEqual(minMembers);
    const out: string[] = [];
    const members = page.locator(sel);
    let movedOnce = false;
    for (let i = 0; i < before.length; i += 1) {
      const m = members.nth(i);
      const on =
        (await m.getAttribute('aria-pressed')) === 'true' ||
        (await m.getAttribute('aria-current')) !== null;
      if (on) continue;
      await m.click();
      await page.waitForTimeout(80);
      const now = m;
      const selected =
        (await now.getAttribute('aria-pressed')) === 'true' ||
        (await now.getAttribute('aria-current')) !== null;
      expect(selected, `clicking "${before[i]?.label ?? ''}" selected it`).toBe(true);
      movedOnce = true;
      out.push(
        ...moved(before, await read()).map((x) => `after "${before[i]?.label ?? ''}": ${x}`),
      );
    }
    expect(movedOnce, `${sel}: the selection never moved`).toBe(true);
    return out;
  }

  test('segmented options: every track on Overview, Costs and Routing', async ({ page }) => {
    let tracks = 0;
    for (const url of ['#/overview', '#/costs', '#/routing']) {
      await open(page, `/browser-harness.html${url}`);
      // Every track, including one a sweep reveals: Routing's Auto routing section mounts
      // its own range only once the sections' selection moves onto it.
      const next = page.locator('.seg-track:not([data-sweep-track])').first();
      for (let t = 0; t < 8 && (await next.count()) > 0; t += 1) {
        await next.evaluate((el, i) => el.setAttribute('data-sweep-track', String(i)), t);
        // The width-holding copy is generated content with an empty alternative: it never
        // joins an option's accessible name.
        const options = page.locator(`[data-sweep-track="${String(t)}"] > .rs-seg`);
        for (let o = 0; o < (await options.count()); o += 1) {
          const opt = options.nth(o);
          await expect(opt).toHaveAccessibleName((await opt.getAttribute('data-label')) ?? '');
        }
        expect(
          await sweep(page, `[data-sweep-track="${String(t)}"] > .rs-seg`),
          `${url} track ${String(t)}`,
        ).toEqual([]);
        tracks += 1;
      }
    }
    // Overview's range and metric, Costs' range and metric, Routing's sections and the Auto
    // routing section's range.
    expect(tracks).toBeGreaterThanOrEqual(6);
  });

  test('segmented options in the budget modal (Alert / Block, the basis)', async ({ page }) => {
    await open(page, '/browser-harness.html#/limits');
    await store(page, 'openModal', 'newLimit');
    for (const name of ['At the threshold', 'What this budget counts']) {
      expect(
        await sweep(page, `.modal-card [role="group"][aria-label="${name}"] > .rs-seg`),
        name,
      ).toEqual([]);
    }
  });

  test('nav items', async ({ page }) => {
    await open(page, '/browser-harness.html#/overview');
    expect(await sweep(page, 'nav .nav-item', { min: 9 })).toEqual([]);
  });

  test('filter chips: the routing filters and the modes', async ({ page }) => {
    await open(page, '/browser-harness.html#/requests');
    expect(
      await sweep(page, '[data-testid="requests-filter-row"] .filter-chip', { min: 4 }),
    ).toEqual([]);
  });

  test('the provider-kind cards and the registration mode', async ({ page }) => {
    await open(page, '/browser-harness.html#/providers');
    await store(page, 'openModal', 'newProvider');
    expect(
      await sweep(page, '.modal-card .kind-card[aria-pressed]', { min: 4, relative: true }),
    ).toEqual([]);
    await store(page, 'closeModal');
    await store(page, 'go', 'setup');
    await store(page, 'obGo', 2);
    expect(await sweep(page, 'button.kind-card[aria-pressed]', { min: 4, relative: true })).toEqual(
      [],
    );
    await store(page, 'go', 'users');
    expect(await sweep(page, '[role="group"][aria-label="Registration mode"] > button')).toEqual(
      [],
    );
  });
});

/** The toast (task 10.2, design.md D13; DESIGN.md Overlays › Toast): an inverted bar on the 32px
 * family, 24px from the bottom, inside one of two live regions that are mounted before any
 * message. EXACT for the same reason as the family: a border-box `min-height` filled by 8px of
 * padding around an explicit 1rem line, so text layout does not enter a one-line bar's height. */
test.describe('the toast is a 32px bar, 24px from the bottom, in its kind’s region (1440x900)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  /** The bar's box and the role of the region that holds it. */
  const measure = (page: Page) =>
    page.locator('.toast').evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        h: r.height,
        fromBottom: innerHeight - r.bottom,
        radius: cs.borderTopLeftRadius,
        font: `${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight}`,
        region: el.parentElement?.getAttribute('role') ?? null,
      };
    });

  test('a confirmation and a failure each draw the same bar, in status and alert', async ({
    page,
  }) => {
    await open(page, '/browser-harness.html#/overview');
    // Both regions are present, empty, before anything is said.
    await expect(page.locator('[data-toast-region="confirm"][role="status"]')).toHaveText('');
    await expect(page.locator('[data-toast-region="failure"][role="alert"]')).toHaveText('');
    await expect(page.locator('.toast')).toHaveCount(0);

    await store(page, 'say', 'Agent created');
    const confirm = await measure(page);
    expect(Math.abs(confirm.h - 32), `the confirmation bar is ${String(confirm.h)}px`).toBeLessThan(
      EXACT,
    );
    expect(Math.abs(confirm.fromBottom - 24)).toBeLessThan(EXACT);
    expect(confirm).toMatchObject({ radius: '10px', font: '500 13px/16px', region: 'status' });

    // A failure raised while a confirmation shows waits for its time (D13), so the confirmation
    // is cleared first and the failure draws at once.
    await store(page, 'clearToast');
    await store(page, 'sayFailure', 'Copy failed — select the text manually');
    const failure = await measure(page);
    expect(Math.abs(failure.h - 32), `the failure bar is ${String(failure.h)}px`).toBeLessThan(
      EXACT,
    );
    expect(Math.abs(failure.fromBottom - 24)).toBeLessThan(EXACT);
    expect(failure).toMatchObject({ radius: '10px', font: '500 13px/16px', region: 'alert' });
    await expect(page.locator('[data-toast-region="confirm"]')).toHaveText('');
  });
});
