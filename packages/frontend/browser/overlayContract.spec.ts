/** The layer contract, at BOTH presentations (phase2-responsive-overlays, tasks 9.9-9.10a).
 *
 * The happy-dom suites prove the contract thoroughly but never cross a breakpoint, so they
 * cannot see a presentation that changes behaviour. These run the same obligations at
 * desktop and phone width, and — the decisive one — keep a surface OPEN across the
 * threshold.
 *
 * That last test is what falsifies a second-component implementation. Adapting by swapping
 * in a different component would satisfy every static assertion at both widths while
 * silently dropping focus and re-entering the layer order mid-interaction.
 */
import { expect, test, type Page } from '@playwright/test';
import { SURFACES } from './overlays';

async function open(page: Page): Promise<void> {
  await page.goto('/browser-harness.html');
  await page.waitForSelector('html[data-harness-ready="true"]');
  await page.waitForSelector('[data-pane="sidebar"]');
}

/** The layer registry, as the app sees it. */
async function layers(page: Page): Promise<{ token: number; kind: string }[]> {
  return page.evaluate(() => {
    const s = (globalThis as unknown as { __harnessStore?: { state: { layers: { token: number; kind: string }[] } } })
      .__harnessStore;
    return (s?.state.layers ?? []).map((l) => ({ token: l.token, kind: l.kind }));
  });
}

for (const vp of [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 900 },
]) {
  test.describe(`layer contract @${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('a modal registers, traps focus, and restores it on close', async ({ page }) => {
      await open(page);
      await page.locator('button.req-row').first().focus();
      const opener = await page.evaluate(() => document.activeElement?.className ?? '');

      const s = SURFACES.find((x) => x.name === 'modal:newAgent');
      await s?.open(page);
      await page.waitForTimeout(200);

      expect((await layers(page)).some((l) => l.kind === 'dialog'), 'modal did not register').toBe(true);
      // Focus moved INTO the dialog.
      expect(
        await page.evaluate(() => document.querySelector('.modal-card')?.contains(document.activeElement) ?? false),
        'focus did not enter the dialog',
      ).toBe(true);

      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      expect(await page.locator('.modal-card').count(), 'Escape did not dismiss').toBe(0);
      expect(
        await page.evaluate(() => document.activeElement?.className ?? ''),
        'focus was not restored to the opener',
      ).toBe(opener);
    });

    test('inertness of the page behind an overlay is the same at both widths', async ({ page }) => {
      // NOT an assertion that a modal makes the page inert — it does not, and never has:
      // `inert` is applied only for the expanded nav (App.tsx:85), with modals relying on
      // the backdrop and the focus trap. That is pre-existing behaviour this change does
      // not touch, so asserting it here would be quietly expanding scope.
      //
      // What phase 2 DOES claim is invariance: whatever inertness a surface produces, it
      // must not depend on how the surface is presented.
      await open(page);
      const nav = SURFACES.find((x) => x.name === 'nav:expanded');
      await nav?.open(page);
      await page.waitForTimeout(200);
      expect(
        await page.evaluate(() =>
          document.querySelector('[data-pane="content"]')?.hasAttribute('inert'),
        ),
        'the expanded nav must make the content pane inert at every width',
      ).toBe(true);
    });

    test('Escape is offered to exactly one layer per press', async ({ page }) => {
      await open(page);
      await page.locator('button.req-row').first().click();
      await page.waitForSelector('.drawer');
      const s = SURFACES.find((x) => x.name === 'modal:newAgent');
      await s?.open(page);
      await page.waitForTimeout(200);
      expect((await layers(page)).length, 'expected two layers').toBeGreaterThan(1);

      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      // The modal went; the drawer beneath it must remain.
      expect(await page.locator('.modal-card').count()).toBe(0);
      expect(await page.locator('.drawer').count(), 'one Escape dismissed two layers').toBe(1);

      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      expect(await page.locator('.drawer').count()).toBe(0);
    });

    test('no surface claims modal semantics without registering', async ({ page }) => {
      await open(page);
      for (const s of SURFACES) {
        await open(page);
        await s.open(page);
        await page.waitForTimeout(150);
        const rogue = await page.evaluate(() => {
          const store = (globalThis as unknown as {
            __harnessStore?: { state: { layers: { root: () => HTMLElement | undefined }[] } };
          }).__harnessStore;
          const registered = new Set(
            (store?.state.layers ?? []).map((l) => l.root()).filter(Boolean),
          );
          return [...document.querySelectorAll('[aria-modal="true"]')]
            .filter((el) => !registered.has(el as HTMLElement))
            .map((el) => el.getAttribute('aria-label') ?? '?');
        });
        expect(rogue, `${s.name}: claims aria-modal without registering`).toEqual([]);
      }
    });
  });
}

test.describe('a surface open across the threshold is the SAME surface', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('identity, layer token and focus all survive the crossing', async ({ page }) => {
    await open(page);
    const s = SURFACES.find((x) => x.name === 'modal:newAgent');
    await s?.open(page);
    await page.waitForTimeout(300);

    // Tag the live node. A replacement component cannot carry this across.
    const before = await page.evaluate(() => {
      const el = document.querySelector('.modal-card') as HTMLElement & { __mark?: number };
      el.__mark = 424242;
      const store = (globalThis as unknown as {
        __harnessStore?: { state: { layers: { token: number }[] } };
      }).__harnessStore;
      return {
        token: store?.state.layers.at(-1)?.token ?? null,
        focus: document.activeElement?.tagName ?? null,
        focusIsInside: document.querySelector('.modal-card')?.contains(document.activeElement) ?? false,
      };
    });

    // Cross the narrow threshold with the surface still open.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);

    const after = await page.evaluate(() => {
      const el = document.querySelector('.modal-card') as (HTMLElement & { __mark?: number }) | null;
      const store = (globalThis as unknown as {
        __harnessStore?: { state: { layers: { token: number }[] } };
      }).__harnessStore;
      return {
        mark: el?.__mark ?? null,
        token: store?.state.layers.at(-1)?.token ?? null,
        focus: document.activeElement?.tagName ?? null,
        focusIsInside: el?.contains(document.activeElement) ?? false,
        // It should also now BE a sheet, or the crossing did nothing at all.
        bottom: el ? Math.round(el.getBoundingClientRect().bottom) : null,
      };
    });

    expect(after.mark, 'the surface was REPLACED, not restyled').toBe(424242);
    expect(after.token, 'the layer re-registered across the crossing').toBe(before.token);
    expect(after.focusIsInside, 'focus left the surface during the crossing').toBe(
      before.focusIsInside,
    );
    expect(after.focus, 'focus moved to a different element').toBe(before.focus);
    // Sanity: the crossing really did change the presentation, so the assertions above
    // are not passing simply because nothing happened.
    expect(after.bottom, 'the surface did not become a bottom sheet').toBe(844);
  });
});
