/** Every entry control whose edge is its affordance shows a 3:1 boundary (adopt-design-tokens-v2
 * task 8.3, design.md D2; dashboard-core "An empty field shows a 3:1 edge"; DESIGN.md The 3:1
 * Edge Rule).
 *
 * Two kinds of edge, measured two ways:
 *
 * - **Drawn by the stylesheet** — an empty text input, a select, the textarea, the combobox
 *   input, an inactive filter chip, and the off switch's track. Each reads its COMPUTED edge (the
 *   track: its fill) and must equal the resolved Control Edge (`--border-control`), whose 3:1
 *   pairs on the canvas, a panel, a chip and the hover tone are held token by token in
 *   `styles.contrast.test.ts`. `entryFields.test.ts` holds the rules and fails an inline style
 *   that would redraw one of these edges.
 * - **Drawn by the browser** — a native checkbox and radio, which stay native under the
 *   per-theme `color-scheme` and `accent-color` (task 11.3). No stylesheet value says what the
 *   browser paints, so the RENDERED pixels are read: each unchecked widget is screenshotted with a
 *   3px margin, the margin's corners give the surface behind it, and the widget's most
 *   contrasting pixel — its edge, since its interior is the field fill — must reach 3:1 against
 *   that surface. The real widgets are read in place (a body-capture mode radio on its Settings
 *   panel, a channel-event checkbox on its modal), and fixtures put the same native widgets on
 *   the canvas, a panel, a chip and the hover tone.
 *
 * Both themes, at 1440 × 900. A widget's pixels are Chromium's, so a measured ratio is printed
 * (`EDGE …`) for the change notes and asserted against the floor only, never pinned.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

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
  const attr = await page.evaluate(() => document.documentElement.dataset['theme'] ?? 'light');
  expect(attr, 'the document is in the theme under test').toBe(theme);
  // Past the reduced-motion transition every colour change takes, and off any hover edge.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(80);
}

/** A token resolved to the `rgb(…)` a computed style reports. */
async function resolved(page: Page, token: string): Promise<string> {
  return page.evaluate((t) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${t})`;
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, token);
}

/** A stylesheet-drawn control's edge: its four border colours, which must agree. */
async function edgeOf(control: Locator): Promise<string> {
  return control.evaluate((el) => {
    const cs = getComputedStyle(el);
    const sides = [
      cs.borderTopColor,
      cs.borderRightColor,
      cs.borderBottomColor,
      cs.borderLeftColor,
    ];
    return new Set(sides).size === 1 ? (sides[0] ?? '') : sides.join(' / ');
  });
}

/** Asserts a stylesheet-drawn control's edge is the Control Edge, naming the control. */
async function expectControlEdge(page: Page, name: string, control: Locator): Promise<void> {
  await expect(control, `${name} is rendered`).toBeVisible();
  await page.mouse.move(0, 0);
  const want = await resolved(page, '--border-control');
  const got = await edgeOf(control);
  expect(got, `${name} draws its edge in ${got}, not the Control Edge ${want}`).toBe(want);
}

/** A native widget's rendered edge against the surface behind it, from its pixels. */
async function nativeEdge(
  page: Page,
  widget: Locator,
): Promise<{ ratio: number; surface: string }> {
  await widget.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  const box = await widget.boundingBox();
  if (box === null) throw new Error('the widget has no box');
  const M = 3;
  const x = Math.floor(box.x) - M;
  const y = Math.floor(box.y) - M;
  const clip = {
    x,
    y,
    width: Math.ceil(box.x + box.width) + M - x,
    height: Math.ceil(box.y + box.height) + M - y,
  };
  const png = await page.screenshot({ clip, animations: 'disabled', caret: 'hide' });
  return page.evaluate(
    async ({ b64, margin, inner }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (ctx === null) throw new Error('no 2d context');
      ctx.drawImage(img, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const px = (i: number, j: number): [number, number, number] => {
        const k = (j * width + i) * 4;
        return [data[k] ?? 0, data[k + 1] ?? 0, data[k + 2] ?? 0];
      };
      const lin = (v: number): number => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      const lum = ([r, g, b]: [number, number, number]): number =>
        0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      // The surface: the margin's four corners, which lie outside the widget and must agree.
      const corners = [px(0, 0), px(width - 1, 0), px(0, height - 1), px(width - 1, height - 1)];
      const keys = new Set(corners.map((c) => c.join(',')));
      if (keys.size !== 1)
        throw new Error(
          `the surface behind the widget is not one colour: ${[...keys].join(' | ')}`,
        );
      const surface = corners[0] ?? [0, 0, 0];
      const ls = lum(surface);
      let ratio = 1;
      for (let j = margin; j < margin + inner.h && j < height; j += 1)
        for (let i = margin; i < margin + inner.w && i < width; i += 1) {
          const l = lum(px(i, j));
          ratio = Math.max(ratio, (Math.max(l, ls) + 0.05) / (Math.min(l, ls) + 0.05));
        }
      return { ratio, surface: `rgb(${surface.join(', ')})` };
    },
    {
      b64: png.toString('base64'),
      margin: M,
      inner: { w: clip.width - 2 * M, h: clip.height - 2 * M },
    },
  );
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`a 3:1 edge on every edge-is-affordance control (${theme}, 1440x900)`, () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('the stylesheet-drawn edges are the Control Edge', async ({ page }) => {
      // An empty text input: the Users invite email.
      await open(page, '/browser-harness.html#/users');
      await setTheme(page, theme);
      const email = page.locator('#f-ua-email');
      await expect(email).toHaveValue('');
      await expectControlEdge(page, 'the empty invite email input', email);

      // A select and an inactive filter chip: the Requests filter row.
      await open(page, '/browser-harness.html#/requests');
      await setTheme(page, theme);
      await expectControlEdge(page, 'the agent filter select', page.locator('#req-agent'));
      await expectControlEdge(
        page,
        'an inactive filter chip',
        page
          .locator('[data-testid="requests-filter-row"] .filter-chip[aria-pressed="false"]')
          .first(),
      );

      // The combobox input: the add-model picker on a tier chain.
      await open(page, '/browser-harness.html#/routing');
      await setTheme(page, theme);
      await expectControlEdge(
        page,
        'the add-model combobox input',
        page.locator('.mp-input').first(),
      );

      // The off switch: no switch rests off in the harness, so one is turned off through itself.
      await store(page, 'setRoutingSection', 'auto');
      const cascade = page.locator('[role="switch"][aria-label="Toggle L3 · Cascade"]');
      await expect(cascade).toHaveAttribute('aria-checked', 'true');
      await cascade.click();
      const off = page.locator('[role="switch"].toggle--off').first();
      await expect(off).toBeVisible();
      await page.mouse.move(0, 0);
      const want = await resolved(page, '--border-control');
      // Polled, not read once: the track's fill transitions (collapsed to 0.01ms under reduced
      // motion), and the frame the class flips on can still report the on track's Ink.
      await expect
        .poll(() => off.evaluate((el) => getComputedStyle(el).backgroundColor), {
          message: `the off track is not filled with the Control Edge ${want}`,
          timeout: 2000,
        })
        .toBe(want);

      // The textarea: the channel modal's Apprise URLs.
      await open(page, '/browser-harness.html#/settings');
      await setTheme(page, theme);
      await store(page, 'openModal', 'channel');
      await store(page, 'setState', 'cf', 'kind', 'apprise');
      const textarea = page.locator('#f-cf-apprise');
      await expect(textarea).toHaveValue('');
      await expectControlEdge(page, 'the empty Apprise URLs textarea', textarea);
    });

    test('a native checkbox and radio draw at least 3:1 on every surface', async ({ page }) => {
      const results: string[] = [];
      const check = async (label: string, widget: Locator): Promise<void> => {
        await expect(widget, `${label} is rendered`).toBeVisible();
        await expect(widget, `${label} is unchecked`).not.toBeChecked();
        const { ratio, surface } = await nativeEdge(page, widget);
        results.push(`${label} ${ratio.toFixed(2)}:1 on ${surface}`);
        expect(
          ratio,
          `${label}: its edge is ${ratio.toFixed(2)}:1 against ${surface}`,
        ).toBeGreaterThanOrEqual(3);
      };

      // In place: an unchecked body-capture mode radio on its Settings panel.
      await open(page, '/browser-harness.html#/settings');
      await setTheme(page, theme);
      await check(
        'a Settings mode radio (panel)',
        page.locator('input[type="radio"][name="bc-mode"]:not(:checked)').first(),
      );

      // In place: an unchecked channel-event checkbox on the channel modal.
      await store(page, 'openModal', 'channel');
      const boxes = page.locator('.modal-card input[type="checkbox"]');
      expect(await boxes.count(), 'the channel modal renders its event checkboxes').toBeGreaterThan(
        0,
      );
      const unchecked = page.locator('.modal-card input[type="checkbox"]:not(:checked)');
      if ((await unchecked.count()) === 0) await boxes.first().click();
      await check('a channel-event checkbox (modal panel)', unchecked.first());
      await store(page, 'closeModal');

      // Fixtures: the same native widgets on each surface a form can put them on.
      for (const surface of ['bg', 'panel', 'chip', 'hover'] as const) {
        await page.evaluate((s) => {
          document.querySelector('[data-edge-fixture]')?.remove();
          const host = document.createElement('div');
          host.setAttribute('data-edge-fixture', s);
          host.style.cssText = `position:fixed;top:100px;left:300px;z-index:2147483647;display:flex;gap:16px;padding:16px;background:var(--${s})`;
          host.innerHTML =
            '<input type="checkbox" aria-label="fixture checkbox"><input type="radio" aria-label="fixture radio">';
          document.body.append(host);
        }, surface);
        await check(
          `a checkbox on --${surface}`,
          page.getByRole('checkbox', { name: 'fixture checkbox' }),
        );
        await check(`a radio on --${surface}`, page.getByRole('radio', { name: 'fixture radio' }));
      }
      console.log(`EDGE ${theme}: ${results.join(' · ')}`);
    });
  });
}
