/**
 * The Settings page's layout (compact-settings-layout).
 *
 * Structure and text only: happy-dom has no layout engine, so the geometry (container width,
 * which panel sits left of which, control widths) is asserted in the browser specs. What this
 * file pins is what a layout change must never disturb: every panel's content, the order the
 * panels appear in the DOM (which IS the tab order and the stacked narrow order), and which
 * panels exist for which session.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { DEFAULT_SESSION, FakeApiClient } from './test/fakeClient';
import type { BodyCaptureStatus, SessionInfo } from './data/api';

const css = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8');
/** The declarations of a single-selector rule in the stylesheet, whitespace-normalised. */
const rule = (selector: string): string => {
  const m = new RegExp(`(?:^|\\n)\\${selector}\\s*\\{([^}]*)\\}`).exec(css);
  expect(m, `${selector} is not defined in styles.css`).not.toBeNull();
  return m![1]!.replace(/\s+/g, ' ').trim();
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

interface Harness {
  host: HTMLElement;
  store: AppStore;
  fake: FakeApiClient;
}

const AGENTS: BodyCaptureStatus['agents'] = [
  { id: 'a1', name: 'Eigent', override: null },
  { id: 'a2', name: 'Warp', override: 'always' },
  { id: 'a3', name: 'Zed', override: 'never' },
];

async function mount(
  opts: {
    session?: SessionInfo;
    body?: Partial<BodyCaptureStatus>;
    /** Replace the capture-status read: one that never settles, or one that fails. */
    bodyRead?: () => Promise<BodyCaptureStatus>;
  } = {},
): Promise<Harness> {
  globalThis.history.replaceState(null, '', '/#/settings');
  const fake = new FakeApiClient({
    session: opts.session ?? DEFAULT_SESSION,
    bodyCaptureStatus: {
      mode: 'all',
      retentionDays: 30,
      droppedCount: 0,
      lastPurgeAt: null,
      lastPurgeCount: 0,
      available: true,
      agents: AGENTS,
      ...opts.body,
    },
  });
  if (opts.bodyRead !== undefined)
    vi.spyOn(fake, 'bodyCaptureStatus').mockImplementation(opts.bodyRead);
  const store = createAppStore(fake);
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(
    () => (
      <AppProvider store={store}>
        <App live={false} />
      </AppProvider>
    ),
    host,
  );
  await flush();
  return { host, store, fake };
}

const page = (host: HTMLElement): HTMLElement => host.querySelector<HTMLElement>('.rs-page')!;
const panelTitle = (p: Element): string =>
  (p.querySelector('.section-title')?.textContent ?? '').replace(/\s+/g, ' ').trim();
const panels = (host: HTMLElement): HTMLElement[] =>
  [...host.querySelectorAll<HTMLElement>('.rs-page .panel')].filter(
    (p) => !p.classList.contains('confirm-card'),
  );
const titles = (host: HTMLElement): string[] => panels(host).map(panelTitle);
const grid = (host: HTMLElement): HTMLElement => host.querySelector<HTMLElement>('.rs-grid-2')!;
const before = (a: Element, b: Element): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('Settings layout: container and panel order', () => {
  it('uses the same 1200px container and gap as the other dashboard pages', async () => {
    const { host } = await mount();
    const style = page(host).getAttribute('style') ?? '';
    expect(style).toContain('max-width:1200px');
    // Sections 24px apart (adopt-design-tokens-v2 task 3.2), as on every other page.
    expect(style).toContain('gap:24px');
    expect(style).not.toContain('760px');
  });

  it('keeps every panel, in the order Instance, Bodies, Notifications, Pricing', async () => {
    const { host } = await mount();
    expect(titles(host)).toEqual([
      'Instance',
      'Prompt & response bodies',
      'Notifications',
      'Pricing catalog',
    ]);
  });

  it('puts the Instance panel above the grid, Bodies on the left, Notifications and Pricing on the right', async () => {
    const { host } = await mount();
    const g = grid(host);
    expect(g).not.toBeNull();
    const instance = panels(host)[0]!;
    expect(g.contains(instance)).toBe(false);
    expect(before(instance, g)).toBe(true);
    const [left, right] = [...g.children] as HTMLElement[];
    expect(left!.querySelectorAll('.panel')).toHaveLength(1);
    expect(panelTitle(left!.querySelector('.panel')!)).toBe('Prompt & response bodies');
    expect([...right!.querySelectorAll('.panel')].map(panelTitle)).toEqual([
      'Notifications',
      'Pricing catalog',
    ]);
  });

  it('gives both grid columns min-width:0, since the class applies it only below the threshold', async () => {
    const { host } = await mount();
    for (const child of [...grid(host).children] as HTMLElement[]) {
      expect(child.getAttribute('style')).toContain('min-width:0');
    }
  });

  it('a member has no Pricing panel and no empty slot: the right column is Notifications alone', async () => {
    const { host } = await mount({ session: { ...DEFAULT_SESSION, role: 'member' } });
    expect(titles(host)).toEqual(['Instance', 'Prompt & response bodies', 'Notifications']);
    const right = grid(host).children[1] as HTMLElement;
    expect([...right.querySelectorAll('.panel')].map(panelTitle)).toEqual(['Notifications']);
    expect(host.textContent).not.toContain('Pricing catalog');
  });
});

describe('Settings layout: the Instance summary', () => {
  it('shows Account with its role, Mode, Version, and Endpoint with Copy', async () => {
    const { host } = await mount();
    const strip = host.querySelector<HTMLElement>('[data-testid="instance-strip"]')!;
    expect(strip).not.toBeNull();
    const text = strip.textContent ?? '';
    for (const label of ['Account', 'Mode', 'Version', 'Endpoint']) expect(text).toContain(label);
    expect(text).toContain('admin@localhost');
    expect(text).toContain('admin');
    expect(text).toContain('selfhosted');
    expect(text).toMatch(/v\d/);
    const copy = [...strip.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Copy',
    );
    expect(copy).toBeDefined();
    // One wrapping row, not a definition grid.
    expect(strip.getAttribute('style')).toContain('flex-wrap:wrap');
    expect(strip.classList.contains('rs-grid-label')).toBe(false);
  });

  it('keeps the self-hosted auto-login note beneath it, and drops it on other modes', async () => {
    const hosted = await mount();
    expect(hosted.host.textContent).toContain('Self-hosted loopback uses auto-login');
    document.body.innerHTML = '';
    const cloud = await mount({ session: { ...DEFAULT_SESSION, mode: 'cloud' } });
    expect(cloud.host.textContent).not.toContain('Self-hosted loopback uses auto-login');
  });

  it('Copy still copies the endpoint', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { host } = await mount();
    const copy = [...host.querySelectorAll('[data-testid="instance-strip"] button')].find(
      (b) => b.textContent?.trim() === 'Copy',
    ) as HTMLButtonElement;
    copy.click();
    await flush();
    expect(writeText).toHaveBeenCalledTimes(1);
  });
});

describe('Settings layout: tab order equals reading order', () => {
  it('visits Copy, then the bodies controls, then Notifications, with no CSS reordering', async () => {
    const { host } = await mount();
    const q = (sel: string, text?: string): Element => {
      const all = [...host.querySelectorAll(sel)];
      const hit = text === undefined ? all[0] : all.find((e) => e.textContent?.trim() === text);
      expect(hit, `${sel} ${text ?? ''}`).toBeDefined();
      return hit!;
    };
    const copy = q('[data-testid="instance-strip"] button', 'Copy');
    const radio = q('input[type=radio]');
    const override = q('select[aria-label^="Capture override for"]');
    const add = q('button', '+ Add channel');
    expect(before(copy, radio)).toBe(true);
    expect(before(radio, override)).toBe(true);
    expect(before(override, add)).toBe(true);
    // The ordering is structural; no `order:` property may reorder it visually.
    for (const el of host.querySelectorAll<HTMLElement>('.rs-page, .rs-page *')) {
      expect(el.getAttribute('style') ?? '').not.toMatch(/(^|;)\s*order\s*:/);
    }
  });
});

describe('Settings layout: the compact bodies card', () => {
  const card = (host: HTMLElement): HTMLElement =>
    panels(host).find((p) => panelTitle(p) === 'Prompt & response bodies')!;
  const retentionSelect = (host: HTMLElement): HTMLSelectElement =>
    card(host).querySelector<HTMLSelectElement>('select[aria-label="Retention"]')!;
  const overrideSelects = (host: HTMLElement): HTMLSelectElement[] => [
    ...card(host).querySelectorAll<HTMLSelectElement>('select[aria-label^="Capture override for"]'),
  ];

  it('keeps the mode options in order, in one wrapping row inside a group named "Capture mode"', async () => {
    const { host } = await mount();
    const group = card(host).querySelector<HTMLElement>('[role="radiogroup"]')!;
    expect(group.getAttribute('aria-label')).toBe('Capture mode');
    expect([...group.querySelectorAll('label')].map((l) => l.textContent?.trim())).toEqual([
      'Off — metadata only',
      'Errors & escalations only',
      'All requests',
    ]);
    expect(
      [...group.querySelectorAll('input[type=radio]')].map((r) => (r as HTMLInputElement).name),
    ).toEqual(['bc-mode', 'bc-mode', 'bc-mode']);
    expect(group.getAttribute('style')).toContain('flex-wrap:wrap');
    expect(group.getAttribute('style')).not.toContain('flex-direction:column');
    // The 24px target floor is carried by each label: the shared floor skips bare radios.
    for (const l of group.querySelectorAll('label')) {
      expect(l.getAttribute('style')).toContain('min-height:24px');
    }
  });

  it('shows no second "30 days" for a numeric retention, and "forever (explicit)" for keep-forever', async () => {
    const days = await mount({ body: { retentionDays: 30 } });
    const sel = retentionSelect(days.host);
    expect(sel.parentElement!.querySelector('span')).toBeNull();
    expect(days.host.textContent).not.toContain('forever (explicit)');
    expect(sel.classList.contains('rs-select-md')).toBe(true);
    expect(sel.getAttribute('style') ?? '').not.toContain('width');
    document.body.innerHTML = '';

    const forever = await mount({ body: { retentionDays: null } });
    const fSel = retentionSelect(forever.host);
    expect(fSel.parentElement!.querySelector('span')?.textContent).toBe('forever (explicit)');
  });

  it('lays the overrides out as columns of name + content-width select, keeping names and options', async () => {
    const { host } = await mount();
    const selects = overrideSelects(host);
    expect(selects.map((s) => s.getAttribute('aria-label'))).toEqual([
      'Capture override for Eigent',
      'Capture override for Warp',
      'Capture override for Zed',
    ]);
    expect(selects.map((s) => s.value)).toEqual(['inherit', 'always', 'never']);
    for (const s of selects) {
      expect([...s.options].map((o) => o.value)).toEqual(['inherit', 'always', 'never']);
      expect(s.classList.contains('rs-select-sm')).toBe(true);
      expect(s.getAttribute('style') ?? '').not.toContain('width');
    }
    const container = selects[0]!.parentElement!.parentElement!;
    // The template is a class: an inline one outranks any class, and responsive.test.ts
    // forbids it at this site.
    expect(container.classList.contains('rs-grid-fit')).toBe(true);
    expect(container.getAttribute('style') ?? '').not.toContain('grid-template-columns');
    expect(container.children).toHaveLength(AGENTS.length);
    // A long name is truncated in its cell but stays readable on hover.
    const name = selects[0]!.previousElementSibling as HTMLElement;
    expect(name.getAttribute('title')).toBe('Eigent');
  });

  it('the stylesheet gives those classes their content widths, each capped for a phone', () => {
    expect(rule('.rs-select-md')).toBe('width: 150px; max-width: 100%;');
    expect(rule('.rs-select-sm')).toBe('width: 112px; max-width: 100%;');
    expect(rule('.rs-grid-fit')).toBe(
      'grid-template-columns: repeat(auto-fill, minmax(min(220px, 100%), 1fr));',
    );
    // They must come AFTER `.select` (width: 100%), or equal specificity hands it the win.
    const at = (sel: string): number => css.indexOf(`\n${sel} {`);
    expect(at('.rs-select-md')).toBeGreaterThan(css.indexOf('.select {'));
    expect(at('.rs-select-sm')).toBeGreaterThan(css.indexOf('.select {'));
    // Self-adapting: it must not be listed in the narrow block that collapses the other grids.
    const narrow = css.slice(css.indexOf('@media (max-width: 768px)'));
    expect(narrow.slice(0, narrow.indexOf('.rs-page {'))).not.toContain('.rs-grid-fit');
  });

  it('changing an override still reaches the API', async () => {
    const { host, fake } = await mount();
    const sel = overrideSelects(host)[0]!;
    sel.value = 'never';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    const call = fake.callLog.find((c) => c.method === 'bodyCaptureSetOverride');
    expect(call?.args).toEqual(['a1', 'never']);
  });

  it('shows the inert hint only while capture is off, and always keeps Purge all bodies', async () => {
    const off = await mount({ body: { mode: 'off' } });
    expect(card(off.host).textContent).toContain(
      'Inert while capture is off — the mode above is the master switch.',
    );
    expect(
      [...card(off.host).querySelectorAll('button')].map((b) => b.textContent?.trim()),
    ).toContain('Purge all bodies');
    document.body.innerHTML = '';
    const on = await mount({ body: { mode: 'all' } });
    expect(card(on.host).textContent).not.toContain('Inert while capture is off');
    expect(
      [...card(on.host).querySelectorAll('button')].map((b) => b.textContent?.trim()),
    ).toContain('Purge all bodies');
  });

  it('keeps the badge truthful: amber "Bodies captured" while on, "Metadata-only" while off', async () => {
    const on = await mount({ body: { mode: 'all' } });
    expect(card(on.host).querySelector('.chip')?.textContent).toBe('Bodies captured');
    document.body.innerHTML = '';
    const off = await mount({ body: { mode: 'off' } });
    expect(card(off.host).querySelector('.chip')?.textContent).toBe('Metadata-only');
  });

  // adopt-design-tokens-v2 task 16.6: before the status arrives, or when its first read fails,
  // the card used to render the cloud sentence and a green Metadata-only badge, telling an
  // instance that captures bodies that it never stores them.
  it('claims nothing while the capture status loads: a placeholder, no sentence, no badge', async () => {
    const { host } = await mount({ bodyRead: () => new Promise<BodyCaptureStatus>(() => {}) });
    const c = card(host);
    expect(c.getAttribute('aria-busy')).toBe('true');
    expect(c.querySelector('.chip')).toBeNull();
    expect(c.textContent).not.toContain('never persisted');
    expect(c.textContent).not.toContain('Metadata-only');
    expect(c.textContent).not.toContain('Off by default');
    expect(c.querySelectorAll('[aria-hidden="true"].ar-skel')).toHaveLength(2);
  });

  it('claims nothing after a failed status read: the error line, no sentence, no badge', async () => {
    const { host } = await mount({
      bodyRead: () => Promise.reject(new Error('capture status unavailable')),
    });
    const c = card(host);
    expect(c.getAttribute('aria-busy')).toBeNull();
    expect(c.querySelector('.chip')).toBeNull();
    expect(c.querySelector('.ar-skel')).toBeNull();
    expect(c.textContent).not.toContain('never persisted');
    expect(c.textContent).not.toContain('Metadata-only');
    const line = [...c.querySelectorAll<HTMLElement>('span')].find(
      (s) => s.textContent === 'capture status unavailable',
    );
    expect(line, 'the read error is shown').toBeDefined();
    // Status text, so the text variant: the --red fill reads 3.75–3.91:1 as small text.
    expect(line!.getAttribute('style')).toContain('var(--red-text)');
  });

  it('sets the on badge in the amber text token, never the amber fill', async () => {
    const { host } = await mount({ body: { mode: 'all' } });
    const style = card(host).querySelector('.chip')?.getAttribute('style') ?? '';
    expect(style).toContain('var(--amber-text)');
    expect(style).not.toMatch(/var\(--amber\)/);
  });

  it('where capture is unavailable the card is read-only text with no controls', async () => {
    const { host } = await mount({ body: { available: false, mode: 'off', agents: [] } });
    const c = card(host);
    expect(c.textContent).toContain('polyrouter stores metadata only');
    expect(c.querySelectorAll('input, select')).toHaveLength(0);
    expect([...c.querySelectorAll('button')].map((b) => b.textContent?.trim())).not.toContain(
      'Purge all bodies',
    );
  });
});
