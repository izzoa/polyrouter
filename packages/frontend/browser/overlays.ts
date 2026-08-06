/** The overlay surface matrix, shared by the baseline capture and the responsive suite
 * (phase2-responsive-overlays, task 9.1).
 *
 * Enumerated from the `ModalKind` union rather than by grepping `state.modal === '…'`:
 * `newProvider` appears only inside a compound condition, so a grep misses it — and it is
 * the largest form in the app, the one most likely to overflow. A list that can go stale
 * silently is not an enumeration.
 */
import type { Page } from '@playwright/test';

export interface Surface {
  readonly name: string;
  /** Selector for the surface's own box — what must fit the viewport. */
  readonly sel: string;
  /** Puts the surface on screen. Must leave it OPEN. */
  readonly open: (page: Page) => Promise<void>;
  /** True when the surface only exists below the narrow threshold. */
  readonly narrowOnly?: boolean;
}

/** Drives the harness store directly — see `browserHarness.tsx` for why. */
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

export const MODAL_KINDS = [
  'newAgent',
  'newProvider',
  'editProvider',
  'newLimit',
  'channel',
  'keyReveal',
] as const;

export const SURFACES: readonly Surface[] = [
  {
    name: 'drawer',
    sel: '.drawer',
    open: async (page) => {
      await store(page, 'go', 'requests');
      // Clicked rather than driven by id: the fixture's row ids are not part of the
      // contract, and a wrong id would silently leave the drawer closed.
      await page.locator('button.req-row').first().click();
      await page.waitForSelector('.drawer');
    },
  },
  ...MODAL_KINDS.map(
    (kind): Surface => ({
      name: `modal:${kind}`,
      sel: '.modal-card',
      open: async (page) => {
        await store(page, 'openModal', kind);
        await page.waitForSelector('.modal-card');
      },
    }),
  ),
  {
    name: 'confirm:bodyCapture',
    sel: '[aria-label="Confirm body capture"]',
    open: async (page) => {
      await store(page, 'go', 'settings');
      const radios = page
        .locator('.panel', { hasText: 'Prompt & response bodies' })
        .locator('input[type=radio]');
      await radios.nth(2).click();
      await page.waitForSelector('[aria-label="Confirm body capture"]');
    },
  },
  {
    name: 'confirm:disableCapture',
    sel: '[aria-label="Disable body capture"]',
    open: async (page) => {
      await store(page, 'go', 'settings');
      const card = page.locator('.panel', { hasText: 'Prompt & response bodies' });
      await card.locator('input[type=radio]').nth(2).click();
      await page.waitForSelector('[aria-label="Confirm body capture"]');
      await page
        .locator('[aria-label="Confirm body capture"] button.btn-primary')
        .first()
        .click();
      await card.locator('input[type=radio]').nth(0).click();
      await page.waitForSelector('[aria-label="Disable body capture"]');
    },
  },
  {
    name: 'nav:expanded',
    sel: '.rs-sidebar.rs-nav-open',
    narrowOnly: true,
    open: async (page) => {
      await store(page, 'setNavExpanded', true);
      await page.waitForSelector('.rs-sidebar.rs-nav-open');
    },
  },
  {
    name: 'accountMenu',
    sel: '[role="menu"][aria-label="Account"]',
    open: async (page) => {
      await store(page, 'setNavExpanded', true);
      await store(page, 'setAccountMenuOpen', true);
      await page.waitForSelector('[role="menu"][aria-label="Account"]');
    },
  },
  {
    name: 'picker',
    sel: '.mp-panel',
    open: async (page) => {
      await store(page, 'go', 'routing');
      await page.locator('.mp-input').first().click();
      await page.waitForSelector('.mp-panel');
    },
  },
  {
    name: 'toast',
    sel: '.toast',
    open: async (page) => {
      // The longest message the app can actually produce: `say()` interpolates provider
      // names and raw API error strings, so its content is unbounded. A short fixture
      // message would make every containment assertion pass for the wrong reason.
      await store(
        page,
        'say',
        'Provider anthropic-production-eu-west-1 added — test the connection & sync models',
      );
      await page.waitForSelector('.toast');
    },
  },
];

/** Bounding box of a surface, rounded — the unit every assertion here works in. */
export async function boxOf(page: Page, sel: string): Promise<[number, number, number, number]> {
  const r = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
  }, sel);
  if (!r) throw new Error(`surface not on screen: ${sel}`);
  return r as [number, number, number, number];
}
