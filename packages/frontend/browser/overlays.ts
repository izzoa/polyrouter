/** The overlay surface matrix, shared by the baseline capture and the responsive suite
 * (phase2-responsive-overlays, task 9.1).
 *
 * Enumerated from the `ModalKind` union rather than by grepping `state.modal === '…'`:
 * `newProvider` appears only inside a compound condition, so a grep misses it — and it is
 * the largest form in the app, the one most likely to overflow. A list that can go stale
 * silently is not an enumeration.
 */
import type { Page } from '@playwright/test';

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface Surface {
  readonly name: string;
  /** Selector for the surface's own box — what must fit the viewport. */
  readonly sel: string;
  /** Puts the surface on screen. Must leave it OPEN. */
  readonly open: (page: Page) => Promise<void>;
  /** True when the surface only exists below the narrow threshold. */
  readonly narrowOnly?: boolean;
  /** The viewport widths that present this surface, inclusive, when that is not every width.
   * add-docked-inspector D13: the Request Inspector is a docked panel at the dock threshold
   * (1440px) and wider, and the modal drawer below it (the sheet at or below `narrow`), so
   * each presentation is its own surface. A suite at a width that cannot present a surface
   * honours its `viewport` or skips it (`presentsAt`, `viewportOf`). */
  readonly widths?: { readonly min?: number; readonly max?: number };
  /** The desktop viewport a suite presents the surface at, when 1440x900 cannot present it. */
  readonly viewport?: Viewport;
  /** Harness query a surface needs (`?semantic=1`), appended by every suite's `open`.
   * Opt-in per surface, so the default harness stays byte-identical for the others. */
  readonly query?: string;
}

/** The desktop viewport every surface is pinned at unless it names its own. */
export const DESKTOP: Viewport = { width: 1440, height: 900 };
/** The phone viewport a narrow-only surface is pinned at. */
export const PHONE: Viewport = { width: 390, height: 844 };
/** `narrow` (STYLESEED.md § Responsive), the shipped `max-width: 768px` query. */
const NARROW_MAX = 768;

/** Whether a viewport this wide presents the surface. */
export function presentsAt(s: Surface, width: number): boolean {
  if (s.narrowOnly === true && width > NARROW_MAX) return false;
  if (s.widths?.min !== undefined && width < s.widths.min) return false;
  if (s.widths?.max !== undefined && width > s.widths.max) return false;
  return true;
}

/** The viewport a suite presents (and pins) the surface at: its own, else the phone for a
 * narrow-only surface, else 1440x900. */
export function viewportOf(s: Surface): Viewport {
  return s.viewport ?? (s.narrowOnly === true ? PHONE : DESKTOP);
}

/** The Request Inspector's two surfaces (add-docked-inspector D13), in matrix order. A suite
 * that loops the matrix asserts it visited the ones its viewport can present: a renamed or
 * skipped inspector surface would otherwise silently stop being checked. */
export const INSPECTOR_SURFACES = ['inspector:docked', 'inspector:drawer'] as const;

/** The harness URL a surface is opened on. */
export function harnessUrl(s: Pick<Surface, 'query'>): string {
  return `/browser-harness.html${s.query ?? ''}`;
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

/** Opens one of the Auto routing tab's tuning drawers from its Layers cell entry
 * (split-auto-routing-readout-setup D8) — clicked, so the real invoker is what it returns
 * focus to. */
async function openTuningDrawer(page: Page, name: 'calibration' | 'learning'): Promise<void> {
  await store(page, 'go', 'routing');
  await store(page, 'setRoutingSection', 'auto');
  await page.locator(`[data-testid="tuning-entry"][data-tuning="${name}"]`).click();
  await page.waitForSelector(`[data-testid="tuning-drawer"][data-tuning="${name}"]`);
}

/** The docked panel and the modal drawer (the sheet at or below `narrow`) are the same
 * `#inspector-drawer` element; only the docked one carries `rs-inspector-docked`. Each surface's
 * selector names its presentation, so a suite that opens one where the viewport presents the
 * other finds nothing rather than measuring the wrong box under that name. */
const INSPECTOR_DOCKED = '#inspector-drawer.rs-inspector-docked';
const INSPECTOR_MODAL = '#inspector-drawer:not(.rs-inspector-docked)';

/** Opens the Request Inspector on the Requests page from fixture row 0, a served `success`
 * row. Clicked rather than driven by id: the fixture's row ids are not part of the contract,
 * and a wrong id would silently leave the inspector closed. */
async function openInspector(page: Page, sel: string): Promise<void> {
  await store(page, 'go', 'requests');
  await page.locator('button.req-row').first().click();
  await page.waitForSelector(sel);
}

/** The identity-imitation consent dialog, named by its title (`Imitate <label>’s client identity?`). */
export const CLIENT_IDENTITY_CONFIRM = '[role="dialog"][aria-label^="Imitate "]';

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
    // add-docked-inspector D13: the docked, non-modal panel, at the dock threshold and wider.
    name: 'inspector:docked',
    sel: INSPECTOR_DOCKED,
    widths: { min: 1440 },
    open: (page) => openInspector(page, INSPECTOR_DOCKED),
  },
  {
    // The modal drawer, below the dock threshold: presented at 1025x768 at desktop (the
    // verification matrix's widest viewport below 1440), and as the bottom sheet at or below
    // `narrow`.
    name: 'inspector:drawer',
    sel: INSPECTOR_MODAL,
    widths: { max: 1439 },
    viewport: { width: 1025, height: 768 },
    open: (page) => openInspector(page, INSPECTOR_MODAL),
  },
  {
    name: 'drawer:selfCalibration',
    sel: '[data-testid="tuning-drawer"][data-tuning="calibration"]',
    open: (page) => openTuningDrawer(page, 'calibration'),
  },
  {
    name: 'drawer:semanticLearning',
    sel: '[data-testid="tuning-drawer"][data-tuning="learning"]',
    query: '?semantic=1',
    open: (page) => openTuningDrawer(page, 'learning'),
  },
  ...MODAL_KINDS.map((kind): Surface => ({
    name: `modal:${kind}`,
    sel: '.modal-card',
    open: async (page) => {
      await store(page, 'openModal', kind);
      await page.waitForSelector('.modal-card');
    },
  })),
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
    // The identity-imitation consent (allow-preset-client-identity task 8.5), stacked over the
    // edit-provider modal. Opened the way a user does: the fixture provider's real Edit, then
    // its switch. The harness fixture is opt-in (`?identity=1`), so no other surface moves.
    name: 'confirm:clientIdentity',
    sel: CLIENT_IDENTITY_CONFIRM,
    query: '?identity=1',
    open: async (page) => {
      await store(page, 'go', 'providers');
      await page
        .locator('main button.btn-ghost', { hasText: /^Edit$/ })
        .first()
        .click();
      await page.locator('#f-np-imitate').click();
      await page.waitForSelector(CLIENT_IDENTITY_CONFIRM);
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
      await page.locator('[aria-label="Confirm body capture"] button.btn-primary').first().click();
      await card.locator('input[type=radio]').nth(0).click();
      await page.waitForSelector('[aria-label="Disable body capture"]');
    },
  },
  {
    // The Batches page's cancel confirmation, on the shared destructive `ConfirmDialog`. Opened
    // from the harness fixture's in-progress job, through its row's real Cancel trigger, so
    // the dialog returns focus where a user's would.
    name: 'confirm:cancelBatch',
    sel: '[aria-label="Cancel batch"]',
    open: async (page) => {
      await store(page, 'go', 'batches');
      await page.locator('button[aria-label^="Cancel batch on "]').first().click();
      await page.waitForSelector('[aria-label="Cancel batch"]');
    },
  },
  {
    // The shared destructive confirmation (adopt-red-destructive-actions task 6.1), opened from
    // the harness fixture's first agent through its row's real Delete trigger, so the dialog
    // returns focus where a user's would. Selected by its title-derived name,
    // `Delete agent "<name>"?`: a new dialog is named by its title (design.md D6).
    name: 'confirm:destructive',
    sel: '[role="dialog"][aria-label^="Delete agent "]',
    open: async (page) => {
      await store(page, 'go', 'agents');
      await page
        .locator('main button.btn-ghost--destructive', { hasText: 'Delete' })
        .first()
        .click();
      await page.waitForSelector('[role="dialog"][aria-label^="Delete agent "]');
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
      // Scrolled fully into view BEFORE the click: the picker closes when an ancestor
      // scrolls, by design, so an input sitting across the fold (at 320x568 the first one
      // does once the type scale's line heights land, adopt-design-tokens-v2 D5) would be
      // scrolled into view by its own focus and close the panel it just opened.
      const input = page.locator('.mp-input').first();
      await input.scrollIntoViewIfNeeded();
      await input.click();
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
