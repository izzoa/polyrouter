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
import { INSPECTOR_SURFACES, SURFACES, harnessUrl, presentsAt, type Surface } from './overlays';

/** Opens the harness — on the query a surface needs, when it needs one. */
async function open(page: Page, surface: Pick<Surface, 'query'> = {}): Promise<void> {
  await page.goto(harnessUrl(surface));
  await page.waitForSelector('html[data-harness-ready="true"]');
  await page.waitForSelector('[data-pane="sidebar"]');
}

/** The identity consent's warning body for the harness fixture's client (design D10). */
const CLIENT_IDENTITY_WARNING =
  'polyrouter will send Fixture Client’s identity headers on this provider’s requests. ' +
  'The provider sees these requests coming from this polyrouter instance, not only from you. ' +
  'This likely violates the provider’s terms: the account can be suspended, and the provider ' +
  'can block it at any time.';

/** The layer registry, as the app sees it. */
async function layers(page: Page): Promise<{ token: number; kind: string }[]> {
  return page.evaluate(() => {
    const s = (
      globalThis as unknown as {
        __harnessStore?: { state: { layers: { token: number; kind: string }[] } };
      }
    ).__harnessStore;
    return (s?.state.layers ?? []).map((l) => ({ token: l.token, kind: l.kind }));
  });
}

/** Whether focus is inside the open inspector. */
async function focusInInspector(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.getElementById('inspector-drawer')?.contains(document.activeElement) ?? false,
  );
}

/** Focuses the inspector's first or last focusable control, the way the trap counts them. */
async function focusInspectorEdge(page: Page, edge: 'first' | 'last'): Promise<void> {
  const name = await page.evaluate((which) => {
    const root = document.getElementById('inspector-drawer');
    if (!root) throw new Error('the inspector is not open');
    const controls = [
      ...root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((el) => el.getClientRects().length > 0);
    const el = which === 'first' ? controls[0] : controls.at(-1);
    if (!el) throw new Error('the inspector has no focusable control');
    el.focus();
    return document.activeElement === el
      ? (el.getAttribute('aria-label') ?? el.textContent ?? '')
      : null;
  }, edge);
  expect(name, `the inspector's ${edge} control did not take focus`).not.toBeNull();
}

/** The Request Inspector open beneath a modal (add-docked-inspector D13), in the presentation
 * the viewport gives it. Escape is offered to exactly one layer per press, in order, at every
 * presentation; the inspector traps Tab only when it is modal. Docked, it is a non-modal
 * `complementary` landmark that a dialog does not supersede: it stays registered beneath it. */
async function modalAboveInspector(
  page: Page,
  presentation: 'sheet' | 'drawer' | 'docked',
): Promise<void> {
  const modal = presentation !== 'docked';
  // On the Requests page, through the matrix's own inspector surface: the harness lands on
  // Overview, whose recent-requests card never docks, so a bare row click there would test the
  // modal drawer at every width.
  const surface = SURFACES.find(
    (x) => x.name === (modal ? 'inspector:drawer' : 'inspector:docked'),
  );
  expect(surface, 'the inspector surface').toBeDefined();
  await open(page, surface);
  await surface!.open(page);
  const inspector = page.locator('#inspector-drawer');
  await inspector.waitFor();
  // Past the drawer's (or the sheet's) entrance, so focus and boxes are at rest.
  await page.waitForTimeout(250);

  // The presentation under test, so nothing below can pass on the wrong one.
  if (modal) {
    await expect(inspector).toHaveAttribute('role', 'dialog');
    await expect(inspector).toHaveAttribute('aria-modal', 'true');
    await expect(inspector).not.toHaveClass(/rs-inspector-docked/);
  } else {
    await expect(inspector).toHaveAttribute('role', 'complementary');
    expect(
      await inspector.getAttribute('aria-modal'),
      'a docked panel claims aria-modal',
    ).toBeNull();
    await expect(inspector).toHaveClass(/rs-inspector-docked/);
  }
  expect((await layers(page)).map((l) => l.kind)).toEqual([modal ? 'dialog' : 'docked']);

  // Tab past either edge: a modal inspector wraps back inside itself; the docked panel lets
  // focus go, because the page beside it stays live.
  await focusInspectorEdge(page, 'last');
  await page.keyboard.press('Tab');
  expect(
    await focusInInspector(page),
    `Tab from the inspector's last control (${presentation})`,
  ).toBe(modal);
  await focusInspectorEdge(page, 'first');
  await page.keyboard.press('Shift+Tab');
  expect(
    await focusInInspector(page),
    `Shift+Tab from the inspector's first control (${presentation})`,
  ).toBe(modal);
  // Docked, focus is put back on the list, where a user beside the panel would be.
  if (!modal) await page.locator('button.req-row').first().focus();

  const s = SURFACES.find((x) => x.name === 'modal:newAgent');
  expect(s, 'the newAgent modal surface').toBeDefined();
  await s!.open(page);
  await page.waitForTimeout(200);
  // The dialog does not supersede the inspector, modal or docked: it stays registered beneath.
  expect(
    (await layers(page)).map((l) => l.kind),
    'the layers above the inspector',
  ).toEqual([modal ? 'dialog' : 'docked', 'dialog']);

  // The panel is inert to the user while the modal is open (dashboard-core "The docked
  // inspector participates without trapping"): focus cannot reach it, and the pointer is
  // stopped by the modal's backdrop. Tab through the dialog's whole cycle and one step more,
  // then the reverse: focus stays in the dialog, never in the inspector beneath.
  const insideDialog = (): Promise<boolean> =>
    page.evaluate(
      () => document.querySelector('.modal-card')?.contains(document.activeElement) ?? false,
    );
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press(key);
      expect(
        await insideDialog(),
        `${key} #${String(i + 1)} left the dialog (${presentation})`,
      ).toBe(true);
      expect(await focusInInspector(page), `${key} reached the inspector (${presentation})`).toBe(
        false,
      );
    }
  }
  // A pointer at the centre of the inspector's Close control lands on the modal's backdrop (or
  // dialog), never on the inspector. Docked, the panel sits beside the page with no scrim of
  // its own, so this is the modal's backdrop doing the work.
  const hit = await page.evaluate(() => {
    const close = document.querySelector('#inspector-drawer button[aria-label="Close inspector"]');
    if (!close) return 'no close control';
    const r = close.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return el?.closest('#inspector-drawer') ? 'inspector' : 'blocked';
  });
  expect(hit, `a pointer reached the inspector beneath the modal (${presentation})`).toBe(
    'blocked',
  );

  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  // The modal went; the inspector beneath it must remain, in the same presentation.
  expect(await page.locator('.modal-card').count()).toBe(0);
  expect(await page.locator('.drawer').count(), 'one Escape dismissed two layers').toBe(1);
  expect((await layers(page)).map((l) => l.kind)).toEqual([modal ? 'dialog' : 'docked']);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  expect(await page.locator('.drawer').count()).toBe(0);
  expect(await layers(page)).toEqual([]);
}

for (const vp of [
  // At 1440x900 the Request Inspector docks (add-docked-inspector D13); below narrow it is the
  // sheet. The modal drawer between them has its own case at 1025x768, below.
  { name: 'phone', width: 390, height: 844, inspector: 'sheet' },
  { name: 'desktop', width: 1440, height: 900, inspector: 'docked' },
] as const) {
  test.describe(`layer contract @${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('a modal registers, traps focus, and restores it on close', async ({ page }) => {
      await open(page);
      await page.locator('button.req-row').first().focus();
      const opener = await page.evaluate(() => document.activeElement?.className ?? '');

      const s = SURFACES.find((x) => x.name === 'modal:newAgent');
      await s?.open(page);
      await page.waitForTimeout(200);

      expect(
        (await layers(page)).some((l) => l.kind === 'dialog'),
        'modal did not register',
      ).toBe(true);
      // Focus moved INTO the dialog.
      expect(
        await page.evaluate(
          () => document.querySelector('.modal-card')?.contains(document.activeElement) ?? false,
        ),
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
      // Desktop is now the DOCKED case: no trap, the same two-Escape order (D13).
      await modalAboveInspector(page, vp.inspector);
    });

    test('the identity consent is described by its warning, and focus lands on its commit', async ({
      page,
    }) => {
      // allow-preset-client-identity D10: focus lands on the commit, so the warning must be the
      // dialog's accessible DESCRIPTION, announced with its name, or the risk could be accepted
      // unheard. Asserted from the accessibility tree, not from the `aria-describedby` attribute.
      const s = SURFACES.find((x) => x.name === 'confirm:clientIdentity');
      expect(s, 'the confirm:clientIdentity surface').toBeDefined();
      await open(page, s);
      await s!.open(page);
      await page.waitForTimeout(200);
      const dialog = page.locator(s!.sel);
      await expect(dialog).toHaveAccessibleName('Imitate Fixture Client’s client identity?');
      await expect(dialog).toHaveAccessibleDescription(CLIENT_IDENTITY_WARNING);
      await expect(dialog.getByRole('button', { name: 'Turn on imitation' })).toBeFocused();
      // One layer for the consent, over the provider modal's.
      expect((await layers(page)).map((l) => l.kind)).toEqual(['dialog', 'dialog']);
    });

    test('no surface claims modal semantics without registering', async ({ page }) => {
      // One test opens EVERY surface in turn, so its budget grows with the matrix: the two
      // tuning drawers (split-auto-routing-readout-setup) took it past the 30s default.
      test.setTimeout(60_000);
      await open(page);
      const inspectors: string[] = [];
      for (const s of SURFACES) {
        // add-docked-inspector D13: an inspector surface this width cannot present is opened at
        // its own viewport when it has one (the modal drawer's 1025x768, from desktop), and is
        // not a surface at this width otherwise (the docked panel below narrow).
        await page.setViewportSize({ width: vp.width, height: vp.height });
        if (s.widths !== undefined && !presentsAt(s, vp.width)) {
          if (s.viewport === undefined || vp.width <= 768) continue;
          await page.setViewportSize(s.viewport);
        }
        await open(page, s);
        await s.open(page);
        if (s.name.startsWith('inspector:')) inspectors.push(s.name);
        await page.waitForTimeout(150);
        const rogue = await page.evaluate(() => {
          const store = (
            globalThis as unknown as {
              __harnessStore?: { state: { layers: { root: () => HTMLElement | undefined }[] } };
            }
          ).__harnessStore;
          const registered = new Set(
            (store?.state.layers ?? []).map((l) => l.root()).filter(Boolean),
          );
          return [...document.querySelectorAll('[aria-modal="true"]')]
            .filter((el) => !registered.has(el as HTMLElement))
            .map((el) => el.getAttribute('aria-label') ?? '?');
        });
        expect(rogue, `${s.name}: claims aria-modal without registering`).toEqual([]);
      }
      expect(inspectors, 'the inspector surfaces checked').toEqual(
        vp.width <= 768 ? ['inspector:drawer'] : [...INSPECTOR_SURFACES],
      );
    });
  });
}

test.describe('layer contract @tablet: the modal inspector drawer (1025x768, add-docked-inspector D13)', () => {
  test.use({ viewport: { width: 1025, height: 768 } });

  test('Escape is offered to exactly one layer per press, and the drawer keeps its trap', async ({
    page,
  }) => {
    await modalAboveInspector(page, 'drawer');
  });
});

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
      const store = (
        globalThis as unknown as {
          __harnessStore?: { state: { layers: { token: number }[] } };
        }
      ).__harnessStore;
      return {
        token: store?.state.layers.at(-1)?.token ?? null,
        focus: document.activeElement?.tagName ?? null,
        focusIsInside:
          document.querySelector('.modal-card')?.contains(document.activeElement) ?? false,
      };
    });

    // Cross the narrow threshold with the surface still open.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);

    const after = await page.evaluate(() => {
      const el = document.querySelector('.modal-card') as
        (HTMLElement & { __mark?: number }) | null;
      const store = (
        globalThis as unknown as {
          __harnessStore?: { state: { layers: { token: number }[] } };
        }
      ).__harnessStore;
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
