/** The Indigo Budget, rendered (adopt-design-tokens-v2 task 7.3; design.md D11;
 * dashboard-core "A rendered check counts each view's indigo").
 *
 * Each view — a page with no overlay open, or an open overlay's own box — may show:
 *
 * - at most ONE visible indigo-filled control (`.btn-primary`);
 * - at most ONE focal measure: the distinct `data-measure` names among the visible
 *   `[data-series="focal"]` roots. One measure repeated per record (each budget card's spend
 *   line, each batch's progress fill, each Pipeline stage's bar) is one;
 * - and NO other visible element computing the raw accent as its `color`, `background-color`,
 *   a drawn `border-*-color`, or an SVG `fill` / `stroke`. Exempt: the inside of a focal
 *   root, the one primary, the brand mark (identity), and the focused element's own edge (a
 *   focused field's border is a state mark). The focus ring is an outline and the caret and
 *   `accent-color` are not read, so state marks never count.
 *
 * The source guard (`styles.contrast.test.ts`, "the Indigo Budget") limits WHERE the raw
 * accent may be written; this counts what a view actually shows, so a stray indigo series
 * fails here even where no source guard sees it. uPlot draws on a canvas, which no computed
 * style can read, so a chart is counted by its `data-series` root, which `Chart.series.test.tsx`
 * holds to what the chart is told to draw.
 *
 * Every page and Routing section, and every overlay surface, in both themes, at 1440x900 —
 * except the modal inspector drawer, which docks at 1440 and is counted at 1025x768. The docked
 * inspector is part of the board, not a layer above it, so it and the Requests page beside it
 * are counted as ONE view (add-docked-inspector design D16).
 */
import { expect, test, type Page } from '@playwright/test';
import { INSPECTOR_SURFACES, SURFACES, harnessUrl, viewportOf } from './overlays';

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
  // Past the reduced-motion transition every colour change takes (0.01ms over `all`).
  await page.waitForTimeout(80);
}

interface Audit {
  accent: string;
  primaries: string[];
  measures: string[];
  /** Focal roots that name no measure — each is a defect. */
  unnamed: string[];
  stray: string[];
  /** Elements read, so an audit of an empty scope cannot pass. */
  read: number;
}

/** Counts one view's indigo. `scope` is the open surface's own box, or null for the page. */
async function audit(page: Page, scope: string | null): Promise<Audit> {
  return page.evaluate((sel) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--accent)';
    document.body.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();

    const root: Element | null = sel === null ? document.body : document.querySelector(sel);
    if (root === null) throw new Error(`surface not on screen: ${String(sel)}`);
    const shown = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      return (
        r.width > 0 &&
        r.height > 0 &&
        el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
      );
    };
    const name = (el: Element): string => {
      const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean);
      const text = (el.getAttribute('aria-label') ?? el.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 32);
      return `${el.tagName.toLowerCase()}${cls.length ? '.' + cls.join('.') : ''}${text ? ` "${text}"` : ''}`;
    };

    const primaries = [...root.querySelectorAll('.btn-primary')].filter(shown);
    const focal = [...root.querySelectorAll('[data-series="focal"]')].filter(shown);
    const measures = [
      ...new Set(focal.map((f) => f.getAttribute('data-measure')).filter((m) => m !== null)),
    ] as string[];
    const unnamed = focal.filter((f) => !f.hasAttribute('data-measure')).map(name);

    const focused = document.activeElement;
    const stray: string[] = [];
    let read = 0;
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (!shown(el)) continue;
      read += 1;
      if (el.closest('[data-series="focal"]')) continue;
      if (el.closest('.btn-primary')) continue;
      if (el.closest('[data-brand-mark]')) continue;
      const cs = getComputedStyle(el);
      const hits: string[] = [];
      if (cs.color === accent) hits.push('color');
      if (cs.backgroundColor === accent) hits.push('background-color');
      for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
        const drawn =
          parseFloat(cs.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 &&
          cs.getPropertyValue(`border-${side.toLowerCase()}-style`) !== 'none';
        if (!drawn || el === focused) continue;
        if (cs.getPropertyValue(`border-${side.toLowerCase()}-color`) === accent)
          hits.push(`border-${side.toLowerCase()}-color`);
      }
      if (el instanceof SVGElement) {
        if (cs.fill === accent) hits.push('fill');
        if (cs.stroke === accent) hits.push('stroke');
      }
      if (hits.length > 0) stray.push(`${name(el)} computes the raw accent as ${hits.join(', ')}`);
    }
    return { accent, primaries: primaries.map(name), measures, unnamed, stray, read };
  }, scope);
}

/** Soft: every view is audited and every failing view is named, not only the first. */
function expectWithinBudget(a: Audit, view: string): void {
  expect(a.accent, 'the raw accent resolved').toBe('rgb(79, 93, 255)');
  // At least the view's own box was read and shown (a toast is one element of text).
  expect.soft(a.read, `${view}: the audit read the view`).toBeGreaterThan(0);
  expect
    .soft(a.primaries.length, `${view}: indigo-filled controls ${a.primaries.join(', ')}`)
    .toBeLessThanOrEqual(1);
  expect.soft(a.unnamed, `${view}: a focal series root names no measure`).toEqual([]);
  expect
    .soft(a.measures.length, `${view}: focal measures ${a.measures.join(', ')}`)
    .toBeLessThanOrEqual(1);
  expect.soft(a.stray, `${view}: indigo outside the budget`).toEqual([]);
}

/** Every page, each Routing section and each Setup step, already in its state. */
async function* views(page: Page): AsyncGenerator<string> {
  for (const [name, url] of [
    ['overview', '#/overview'],
    ['requests', '#/requests'],
    ['batches', '#/batches'],
    ['costs', '#/costs'],
    ['agents', '#/agents'],
    ['providers (with a provider card)', '?targets=1#/providers'],
    // add-subscription-usage-history: one Ink 2 graph per window on every card spends no indigo.
    ['providers (plan usage graphs)', '?usage=1#/providers'],
    ['limits (with budget cards)', '?budget=progress#/limits'],
    ['settings', '#/settings'],
    ['users', '#/users'],
  ] as const) {
    await open(page, `/browser-harness.html${url}`);
    // The usage graphs land after their own history read: audit them drawn, not loading.
    if (url.startsWith('?usage=1')) await page.waitForSelector('figure[data-usage-graph] canvas');
    yield name;
  }
  await open(page, '/browser-harness.html?chain=1#/routing');
  await store(page, 'setRoutingSection', 'tiers');
  yield 'routing / Tiers & headers';
  for (const query of ['', '?semantic=1']) {
    await open(page, `/browser-harness.html${query}#/routing`);
    await store(page, 'setRoutingSection', 'auto');
    await page.waitForSelector('[data-testid="pipeline-stage"]');
    const closed = page.locator('button.ar-expander[aria-expanded="false"]');
    for (let i = 0; i < 8 && (await closed.count()) > 0; i += 1) await closed.first().click();
    await page.mouse.move(0, 0);
    yield `routing${query} / Auto routing (every stage open)`;
  }
  await open(page, '/browser-harness.html#/setup');
  for (const step of [1, 2, 3]) {
    await store(page, 'obGo', step);
    yield `setup step ${String(step)}`;
  }
  // The signed-out pages, through the store's auth view (the harness boots signed in). Each
  // keeps its brand mark's lit route, which is identity, outside the budget.
  await open(page, '/browser-harness.html#/overview');
  await store(page, 'setState', 'authView', 'gate');
  await page.locator('#f-login-email').waitFor({ state: 'visible' });
  yield 'sign-in';
  await store(page, 'setState', 'authView', 'invite');
  await page.locator('#f-invite-name').waitFor({ state: 'visible' });
  yield 'accept invite';
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`the Indigo Budget holds in every view (${theme}, 1440x900)`, () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('every page and every Routing section, with no overlay open', async ({ page }) => {
      test.setTimeout(120_000);
      let seen = 0;
      const measures = new Set<string>();
      for await (const view of views(page)) {
        await setTheme(page, theme);
        const a = await audit(page, null);
        expectWithinBudget(a, view);
        for (const m of a.measures) measures.add(m);
        seen += 1;
      }
      expect(seen).toBeGreaterThanOrEqual(16);
      // Not vacuous: every focal measure D11 names was actually counted somewhere.
      expect([...measures].sort()).toEqual([
        'batch-progress',
        'budget-spend',
        'pipeline',
        'request-mix',
        'requests',
      ]);
    });

    test('every overlay surface, counted in its own box', async ({ page }) => {
      test.setTimeout(120_000);
      const inspectors: string[] = [];
      for (const s of SURFACES) {
        if (s.narrowOnly === true) continue;
        // At the viewport that presents it (add-docked-inspector D13): 1440x900, or the modal
        // inspector drawer's 1025x768.
        await page.setViewportSize(viewportOf(s));
        await open(page, harnessUrl(s));
        await setTheme(page, theme);
        await s.open(page);
        await page.waitForTimeout(250);
        // D16: the docked panel and the Requests page are ONE view, so it is audited with the
        // page (the list beside it, its filters and the selected row's Selected state, which is
        // a state mark and never counted); every other surface in its own box.
        const docked = s.name === 'inspector:docked';
        const view = docked ? 'inspector:docked, one view with the Requests page' : s.name;
        const a = await audit(page, docked ? null : s.sel);
        expectWithinBudget(a, view);
        // The request inspector opens on fixture row 0, a served row: its one focal measure is
        // the route trace's lit branch, and nothing else in it is indigo (add-route-trace-
        // inspector design D5, task 4.6). Counted, not only bounded, so a lit node that lost
        // its focal root (and was audited as stray instead) or a trace with no lit node fails.
        // Docked, the page beside it draws no other series, so the view still holds exactly one.
        if (s.name.startsWith('inspector:')) {
          expect.soft(a.measures, `${view}: the focal measure`).toEqual(['route-trace']);
          inspectors.push(s.name);
        }
      }
      // Both presentations were counted, under their new names: a renamed surface would
      // otherwise silently stop being checked.
      expect(inspectors).toEqual([...INSPECTOR_SURFACES]);
    });
  });
}
