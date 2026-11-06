/** The destructive buttons, rendered (adopt-red-destructive-actions task 2.2; design.md D10;
 * dashboard-core "The destructive ghost stays red when hovered or pressed", and ADDED "A double
 * activation sends one request").
 *
 * happy-dom performs no layout, so `styles.contrast.test.ts` holds only the declarations: the
 * destructive ghost's border plus padding per side, and its hover and pressed tones resolved
 * against each theme's tokens. This measures what those declarations render in Chromium:
 *
 * - the destructive ghost's box (`getBoundingClientRect`) is identical at rest, hovered and
 *   pressed, in both themes, at desktop and in the comfort context — its pressed state draws a
 *   2px Red Text border INSIDE the same box, the padding giving up 1px per side;
 * - hovered and pressed really apply (the Red Wash, then the 2px border), so an identical box is
 *   not the trivial result of a state that never took; they paint apart from each other in both
 *   themes; and no state computes an indigo token;
 * - the destructive commit is a 32px height-family member, 44px in the comfort context.
 *
 * The box and paint checks use two fixtures carrying the shipped classes, mounted on the harness
 * with the real stylesheet. That is a choice of measurement, not a gap: the box comparison needs a
 * bare ghost the pointer can rest on and press with nothing else moving, and the commit's height
 * needs a button outside the dialog's text-sized card. The real paths are covered elsewhere:
 * every real trigger's class by `src/destructiveTriggers.view.test.tsx` (task 5.3), and the real
 * commit inside `confirm:destructive` by `heightFamily.spec.ts`'s overlay sweep (32px) and
 * `overlaySheets.spec.ts`'s comfort floor (44px at 390).
 *
 * Two checks below do drive the real dialogs, from their real triggers:
 *
 * - every `confirm:*` surface keeps each of its actions inside its sheet at 320 and 390px. The
 *   action row wraps its controls rather than spilling past the sheet's edge: with
 *   `justify-content: flex-end`, an overflow leaves through the start side, where no scroll
 *   reaches it, and keep-or-purge's three actions need more than a 320px sheet's width;
 * - a double-click or a double-tap on a destructive trigger opens its confirmation once and
 *   never runs the commit or dismisses it: the trigger opens the dialog in the same task as its
 *   click, so the second click lands on whatever the dialog puts under the pointer.
 *
 * EXACT, not a tolerance (`geometry-contract.ts`): the box is compared with itself in one run,
 * so only float noise is allowed, and the heights are border-box `min-height`s.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { SURFACES, harnessUrl } from './overlays';

const EXACT = 0.05;
/** The indigo tokens: the accent and every derivation `:root` builds from it. */
const INDIGO = [
  '--accent',
  '--accent-bg',
  '--accent-deep',
  '--accent-fill-hover',
  '--accent-fill-pressed',
] as const;

async function open(page: Page): Promise<void> {
  await page.goto('/browser-harness.html#/agents');
  await page.waitForSelector('html[data-harness-ready="true"]');
  await page.waitForSelector('[data-pane="sidebar"]');
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
  const attr = await page.evaluate(() => document.documentElement.dataset['theme'] ?? 'light');
  expect(attr, 'the document is in the theme under test').toBe(theme);
}

/** The ghost and the commit, on a panel, fixed above the app so the pointer reaches them with
 * no scroll. A column, so neither stretches the other's height. */
async function mountFixtures(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.className = 'panel';
    host.style.cssText =
      'position:fixed;top:96px;left:16px;z-index:10000;padding:16px;' +
      'display:flex;flex-direction:column;align-items:flex-start;gap:8px';
    const ghost = document.createElement('button');
    ghost.type = 'button';
    ghost.className = 'btn-ghost btn-ghost--destructive';
    ghost.dataset['fixture'] = 'ghost';
    ghost.textContent = 'Delete';
    const commit = document.createElement('button');
    commit.type = 'button';
    commit.className = 'btn-destructive';
    commit.dataset['fixture'] = 'commit';
    commit.textContent = 'Delete agent';
    host.append(ghost, commit);
    document.body.append(host);
  });
}

/** Any CSS colour, painted and read back as `r,g,b`: a computed `color-mix()` serializes as
 * `oklab(…)` while a hex token serializes as `rgb(…)`, so strings alone cannot be compared. */
async function rgb(page: Page, css: string): Promise<string> {
  return page.evaluate((c) => {
    const ctx = document.createElement('canvas').getContext('2d');
    if (ctx === null) throw new Error('no 2d canvas');
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `${String(r)},${String(g)},${String(b)}`;
  }, css);
}

/** A token resolved in the current theme, as `r,g,b`. */
async function token(page: Page, name: string): Promise<string> {
  const computed = await page.evaluate((t) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${t})`;
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, name);
  return rgb(page, computed);
}

interface Seen {
  x: number;
  y: number;
  w: number;
  h: number;
  background: string;
  border: string;
  borderWidth: string;
  color: string;
}

async function read(page: Page, el: Locator): Promise<Seen> {
  const raw = await el.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const cs = getComputedStyle(node);
    return {
      x: r.x,
      y: r.y,
      w: r.width,
      h: r.height,
      background: cs.backgroundColor,
      border: cs.borderTopColor,
      borderWidth: cs.borderTopWidth,
      color: cs.color,
    };
  });
  return {
    ...raw,
    background: await rgb(page, raw.background),
    border: await rgb(page, raw.border),
    color: await rgb(page, raw.color),
  };
}

const VIEWPORTS = [
  { name: 'desktop 1440x900', width: 1440, height: 900, comfort: false },
  { name: 'comfort 390x844', width: 390, height: 844, comfort: true },
] as const;

for (const vp of VIEWPORTS) {
  test.describe(`the destructive buttons at ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    for (const theme of ['light', 'dark'] as const) {
      test(`${theme}: the destructive ghost keeps its box at rest, hovered and pressed`, async ({
        page,
      }) => {
        await open(page);
        await setTheme(page, theme);
        await mountFixtures(page);
        const ghost = page.locator('[data-fixture="ghost"]');

        // Past the reduced-motion transition every colour change takes.
        await page.mouse.move(0, 0);
        await page.waitForTimeout(80);
        const rest = await read(page, ghost);
        await ghost.hover();
        await page.waitForTimeout(80);
        const hover = await read(page, ghost);
        await page.mouse.down();
        await page.waitForTimeout(80);
        const pressed = await read(page, ghost);
        await page.mouse.up();

        // The states really applied, so the box comparison below is not vacuous.
        const wash = await token(page, '--red-bg');
        expect(rest.borderWidth, 'at rest the ghost draws its 1px border').toBe('1px');
        expect(rest.border, 'at rest the border is Signal Red').toBe(await token(page, '--red'));
        expect(rest.color, 'the label is Red Text').toBe(await token(page, '--red-text'));
        expect(hover.background, 'hovered, it shows the Red Wash').toBe(wash);
        expect(hover.borderWidth, 'hovered, the border stays 1px').toBe('1px');
        expect(pressed.background, 'pressed, it keeps the Red Wash').toBe(wash);
        expect(pressed.borderWidth, 'pressed, it draws the 2px border').toBe('2px');
        expect(pressed.border, 'pressed, the border is Red Text').toBe(
          await token(page, '--red-text'),
        );

        // Hovered and pressed paint apart (in dark, Red Text equals Signal Red: the width is the
        // cue), and no state is indigo.
        const paint = (s: Seen): string =>
          [s.background, s.border, s.borderWidth, s.color].join(' / ');
        expect(paint(pressed), 'pressed paints exactly as hovered').not.toBe(paint(hover));
        const indigo = new Map<string, string>();
        for (const t of INDIGO) indigo.set(await token(page, t), t);
        for (const [state, s] of Object.entries({ rest, hover, pressed })) {
          for (const [part, c] of Object.entries({
            background: s.background,
            border: s.border,
            label: s.color,
          })) {
            expect(indigo.get(c), `${theme} ${state} ${part} computes ${c}`).toBeUndefined();
          }
        }

        // The box: identical at rest, hovered and pressed.
        for (const [state, s] of Object.entries({ hover, pressed })) {
          for (const k of ['x', 'y', 'w', 'h'] as const) {
            expect(
              Math.abs(s[k] - rest[k]),
              `${state} ${k} is ${String(s[k])}, at rest ${String(rest[k])}`,
            ).toBeLessThan(EXACT);
          }
        }
        expect(rest.h, 'the ghost is its family height').toBeGreaterThanOrEqual(
          vp.comfort ? 44 - EXACT : 24 - EXACT,
        );
        if (!vp.comfort) expect(Math.abs(rest.h - 24)).toBeLessThan(EXACT);
      });
    }

    test(`the destructive commit is ${vp.comfort ? 'at least 44' : '32'}px tall`, async ({
      page,
    }) => {
      await open(page);
      await mountFixtures(page);
      await page.mouse.move(0, 0);
      const commit = await read(page, page.locator('[data-fixture="commit"]'));
      if (vp.comfort)
        expect(commit.h, 'the comfort context grows the commit').toBeGreaterThanOrEqual(44 - EXACT);
      else
        expect(
          Math.abs(commit.h - 32),
          `the commit is ${String(commit.h)}px, not its 32px role height`,
        ).toBeLessThan(EXACT);
    });
  });
}

/* ── The real dialogs ─────────────────────────────────────────────────────────── */

const CONFIRMS = SURFACES.filter((s) => s.name.startsWith('confirm:'));

for (const vp of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
] as const) {
  test.describe(`every confirmation's actions at ${String(vp.width)}x${String(vp.height)}`, () => {
    test.use({ viewport: vp });

    test('stay inside the sheet: the row wraps its controls, never past an edge', async ({
      page,
    }) => {
      test.setTimeout(40_000);
      expect(CONFIRMS.map((s) => s.name)).toEqual(
        expect.arrayContaining(['confirm:disableCapture', 'confirm:destructive']),
      );
      for (const s of CONFIRMS) {
        await page.goto(harnessUrl(s));
        await page.waitForSelector('html[data-harness-ready="true"]');
        await page.waitForSelector('[data-pane="sidebar"]');
        await s.open(page);
        await page.waitForTimeout(300);
        const seen = await page.evaluate((sel) => {
          const card = document.querySelector(sel);
          if (card === null) return null;
          const r = card.getBoundingClientRect();
          const cs = getComputedStyle(card);
          const left = r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
          const right = r.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
          return {
            box: [left, right],
            scrolls: card.scrollWidth > card.clientWidth + 1,
            buttons: [...card.querySelectorAll('button')].map((b) => {
              const br = b.getBoundingClientRect();
              return { label: (b.textContent ?? '').trim(), left: br.left, right: br.right };
            }),
          };
        }, s.sel);
        expect(seen, `${s.name} is not on screen`).not.toBeNull();
        const { box, scrolls, buttons } = seen!;
        expect(buttons.length, `${s.name} renders no action`).toBeGreaterThan(1);
        expect(scrolls, `${s.name} scrolls sideways`).toBe(false);
        const outside = buttons
          .filter((b) => b.left < box[0]! - 0.5 || b.right > box[1]! + 0.5)
          .map(
            (b) =>
              `${b.label} spans ${b.left.toFixed(1)}–${b.right.toFixed(1)}, ` +
              `the sheet's content box ${box[0]!.toFixed(1)}–${box[1]!.toFixed(1)}`,
          );
        expect(outside, `${s.name}: actions outside the sheet`).toEqual([]);
      }
    });
  });
}

/** The Agents page, its rows' real Delete triggers, and how many agents are listed. */
async function agentsPage(page: Page): Promise<Locator> {
  await open(page);
  await page.evaluate(() => {
    (globalThis as unknown as { __harnessStore: { go: (p: string) => void } }).__harnessStore.go(
      'agents',
    );
  });
  const triggers = page.locator('main button.btn-ghost--destructive', { hasText: 'Delete' });
  await expect(triggers, 'the harness lists two agents').toHaveCount(2);
  return triggers;
}

const agentDialog = '[role="dialog"][aria-label^="Delete agent "]';

/** At 390x684 the second agent's Delete sits under the bottom sheet's commit, so the second
 * click of a double activation on it lands on `Delete agent`. Asserted, so the check cannot pass
 * on a layout that moved the two apart. */
async function underTheCommit(page: Page, at: { x: number; y: number }): Promise<void> {
  const c = await page
    .locator(`${agentDialog} button.btn-destructive`)
    .boundingBox({ timeout: 2_000 });
  expect(c, 'the commit is not rendered').not.toBeNull();
  expect(
    at.x >= c!.x && at.x <= c!.x + c!.width && at.y >= c!.y && at.y <= c!.y + c!.height,
    `the trigger at ${JSON.stringify(at)} is not under the commit ${JSON.stringify(c)}`,
  ).toBe(true);
}

/** Exactly one confirmation is open, and nothing was deleted. */
async function asksOnce(page: Page, triggers: Locator): Promise<void> {
  await expect(page.locator('[role="dialog"]'), 'exactly one confirmation is open').toHaveCount(1);
  await expect(triggers, 'the second click deleted the agent').toHaveCount(2);
}

/** Committing on purpose still works: the guard does not refuse every click. A press aimed at
 * the dialog comes after its stray-press window (`STRAY_PRESS_MS`, 500ms in ConfirmDialog.tsx). */
async function commitsOnPurpose(page: Page, triggers: Locator): Promise<void> {
  await page.waitForTimeout(600);
  await page.locator(`${agentDialog} button.btn-destructive`).click();
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  await expect(triggers, 'a deliberate commit deletes once').toHaveCount(1);
}

test.describe('a double activation on a destructive trigger', () => {
  test.describe('on a phone, where the trigger sits under the sheet’s commit', () => {
    test.use({ viewport: { width: 390, height: 684 } });

    test('a double-click asks once and does not commit', async ({ page }) => {
      const triggers = await agentsPage(page);
      const b = (await triggers.nth(1).boundingBox())!;
      const at = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      await page.mouse.dblclick(at.x, at.y);
      await page.waitForTimeout(150);
      await asksOnce(page, triggers);
      await underTheCommit(page, at);
      await commitsOnPurpose(page, triggers);
    });
    test('a second press counted afresh asks once and does not commit', async ({ page }) => {
      // WebKit and Firefox count the second tap of a double-tap 1, not 2 (measured with
      // Playwright); only the dialog's stray-press window can tell it apart. The second press is
      // sent with a click count of 1, as theirs arrives, and its count is read, so the check
      // cannot pass on the count guard alone.
      const triggers = await agentsPage(page);
      await page.evaluate(() => {
        const w = globalThis as unknown as { __counts: number[] };
        w.__counts = [];
        document.addEventListener('click', (e) => w.__counts.push(e.detail), true);
      });
      const b = (await triggers.nth(1).boundingBox())!;
      const at = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      await page.mouse.click(at.x, at.y);
      await page.mouse.down({ clickCount: 1 });
      await page.mouse.up({ clickCount: 1 });
      await page.waitForTimeout(150);
      const counts = await page.evaluate(
        () => (globalThis as unknown as { __counts: number[] }).__counts,
      );
      expect(counts, 'the second press was not counted afresh').toEqual([1, 1]);
      await asksOnce(page, triggers);
      await underTheCommit(page, at);
      await commitsOnPurpose(page, triggers);
    });
  });

  test.describe('on a touch screen', () => {
    test.use({ viewport: { width: 390, height: 684 }, hasTouch: true, isMobile: true });

    test('a double-tap asks once and does not commit', async ({ page }) => {
      const triggers = await agentsPage(page);
      const b = (await triggers.nth(1).boundingBox())!;
      const at = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      await page.touchscreen.tap(at.x, at.y);
      await page.waitForTimeout(120);
      await page.touchscreen.tap(at.x, at.y);
      await page.waitForTimeout(150);
      await asksOnce(page, triggers);
      await underTheCommit(page, at);
      await commitsOnPurpose(page, triggers);
    });
  });

  test.describe('on a desktop, where the second click lands on the scrim', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('a double-click opens the confirmation once and leaves it open', async ({ page }) => {
      const triggers = await agentsPage(page);
      await triggers.first().dblclick();
      await page.waitForTimeout(150);
      await asksOnce(page, triggers);
      await commitsOnPurpose(page, triggers);
    });

    test('so does a double-click on a batch’s Cancel', async ({ page }) => {
      await open(page);
      await page.evaluate(() => {
        (
          globalThis as unknown as { __harnessStore: { go: (p: string) => void } }
        ).__harnessStore.go('batches');
      });
      await page.locator('button[aria-label^="Cancel batch on "]').first().dblclick();
      await page.waitForTimeout(150);
      await expect(page.locator('[role="dialog"][aria-label="Cancel batch"]')).toHaveCount(1);
    });
  });
});
