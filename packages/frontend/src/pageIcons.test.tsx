import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { PAGE_ICONS } from './components/PageIcon';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';
import type { Page } from './types';

const ALL_PAGES: Page[] = [
  'overview',
  'requests',
  'costs',
  'agents',
  'providers',
  'routing',
  'limits',
  'settings',
  'users',
  'setup',
];

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

function mountApp(store: AppStore): { host: HTMLElement; dispose: () => void } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const dispose = render(
    () => (
      <AppProvider store={store}>
        <App live={false} />
      </AppProvider>
    ),
    host,
  );
  return { host, dispose: () => (dispose(), host.remove()) };
}

/** The Topbar icon is the only page-icon that is neither in the nav rail nor in
 * the setup card — a location-based hook that needs no test-only markup. */
const topbarIcon = (host: HTMLElement): Element | null =>
  [...host.querySelectorAll('[data-page-icon]')].find(
    (n) => !n.closest('nav') && !n.closest('.setup-card'),
  ) ?? null;

const activeNavIcon = (host: HTMLElement): SVGElement | null =>
  host.querySelector<SVGElement>('button.nav-item[aria-current="page"] [data-page-icon]');

/** The nine primary-nav pages (setup is the header-only exception). */
const PRIMARY: Page[] = ALL_PAGES.filter((p) => p !== 'setup');

describe('per-page icons (add-nav-page-icons)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('the registry is exhaustive over the Page union', () => {
    expect(Object.keys(PAGE_ICONS).sort()).toEqual([...ALL_PAGES].sort());
    for (const p of ALL_PAGES) expect(typeof PAGE_ICONS[p]).toBe('function');
  });

  it('every rendered icon is decorative (aria-hidden svg)', async () => {
    const { host, dispose } = mountApp(createAppStore(new FakeApiClient()));
    try {
      await flush();
      const icons = [...host.querySelectorAll('[data-page-icon]')];
      expect(icons.length).toBeGreaterThan(0);
      for (const el of icons) {
        expect(el.tagName.toLowerCase()).toBe('svg');
        expect(el.getAttribute('aria-hidden')).toBe('true');
      }
    } finally {
      dispose();
    }
  });

  it('every primary-nav page shows the SAME glyph geometry in rail and header, and the header glyph changes per page', async () => {
    const store = createAppStore(new FakeApiClient());
    const { host, dispose } = mountApp(store);
    try {
      await flush();
      const headerGeometry = new Map<Page, string>();
      for (const page of PRIMARY) {
        store.go(page);
        await flush();
        const rail = activeNavIcon(host);
        const header = topbarIcon(host);
        expect(rail, `rail icon for ${page}`).not.toBeNull();
        expect(header, `header icon for ${page}`).not.toBeNull();
        // The active rail item and the header resolve to THIS page…
        expect(rail?.getAttribute('data-page-icon')).toBe(page);
        expect(header?.getAttribute('data-page-icon')).toBe(page);
        // …and render the identical glyph geometry (inner SVG, size-independent),
        // not merely the same data attribute.
        expect(rail?.innerHTML).toBe(header?.innerHTML);
        expect(rail?.innerHTML.length).toBeGreaterThan(0);
        headerGeometry.set(page, header!.innerHTML);
      }
      // The <Dynamic> switch really swaps the visible glyph: all nine header
      // geometries are distinct (a stale/removed switch would collapse them).
      expect(new Set(headerGeometry.values()).size).toBe(PRIMARY.length);
    } finally {
      dispose();
    }
  });

  it('the Providers accessible name is unchanged by the icon (label + count badge only)', async () => {
    const store = createAppStore(new FakeApiClient());
    const { host, dispose } = mountApp(store);
    try {
      await flush();
      const btn = [...host.querySelectorAll('button.nav-item')].find((b) =>
        b.textContent?.includes('Providers'),
      );
      expect(btn).toBeTruthy();
      // The icon is aria-hidden and contributes no text: the name is "Providers"
      // optionally followed by the count badge digits — never icon artifacts.
      expect(btn?.querySelector('svg[data-page-icon="providers"]')?.getAttribute('aria-hidden')).toBe(
        'true',
      );
      expect(btn?.textContent?.replace(/\s+/g, '')).toMatch(/^Providers\d*$/);
    } finally {
      dispose();
    }
  });

  it('setup keeps its rail progress ring (no rail icon) and shows its glyph only in the header', async () => {
    const store = createAppStore(new FakeApiClient());
    const { host, dispose } = mountApp(store);
    try {
      await flush();
      const card = host.querySelector('.setup-card');
      expect(card).not.toBeNull();
      // The card retains an svg (the progress ring) but NOT a registry page-icon.
      expect(card?.querySelector('svg')).not.toBeNull();
      expect(card?.querySelector('[data-page-icon]')).toBeNull();

      store.go('setup');
      await flush();
      // Header now shows setup's registry glyph; the rail still has no setup icon.
      expect(topbarIcon(host)?.getAttribute('data-page-icon')).toBe('setup');
      expect(host.querySelector('.setup-card [data-page-icon]')).toBeNull();
    } finally {
      dispose();
    }
  });
});
