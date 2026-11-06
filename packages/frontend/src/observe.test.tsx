import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { ApiError, type AnalyticsSummary } from './data/api';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { DEFAULT_SUMMARY, FakeApiClient } from './test/fakeClient';
import { labelText } from './test/labelText';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

function mount(store: AppStore): { host: HTMLElement; store: AppStore; dispose: () => void } {
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
  return {
    host,
    store,
    dispose: () => {
      dispose();
      host.remove();
    },
  };
}

function clickNav(host: HTMLElement, label: string): void {
  const el = [...host.querySelectorAll<HTMLElement>('.nav-item span')].find(
    (e) => labelText(e) === label,
  );
  if (!el) throw new Error(`no nav item "${label}"`);
  el.click();
}

function clickText(host: HTMLElement, selector: string, text: string): void {
  const el = [...host.querySelectorAll<HTMLElement>(selector)].find((e) => labelText(e) === text);
  if (!el) throw new Error(`no ${selector} with text "${text}"`);
  el.click();
}

describe('Observe pages render real analytics', () => {
  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset['theme'];
  });

  it('Overview shows real summary numbers (not seeds)', async () => {
    const { host, dispose } = mount(createAppStore(new FakeApiClient()));
    try {
      await flush();
      expect(host.textContent).toContain('$12.50'); // DEFAULT_SUMMARY.spend
      expect(host.querySelector('.req-row')).not.toBeNull(); // real recent rows
      expect(host.querySelector('.uplot')).not.toBeNull(); // the chart mounted
    } finally {
      dispose();
    }
  });

  it('Costs shows real spend and the free/paid/unpriced split', async () => {
    const { host, dispose } = mount(createAppStore(new FakeApiClient()));
    try {
      await flush();
      clickNav(host, 'Costs');
      await flush();
      expect(host.textContent).toContain('$12.50');
      // Four-way mix with counts beside percentages (split-subscription-spend).
      expect(host.textContent).toContain('free 80% (8)');
      expect(host.textContent).toContain('subscription');
      expect(host.textContent).toContain('other priced');
      expect(host.textContent).toContain('unpriced 20% (2)');
      // The headline says what it excludes rather than presenting an unqualified total.
      expect(host.textContent).toContain('excludes subscription');
    } finally {
      dispose();
    }
  });

  it('shows a visible error + retry on a failing load, then recovers', async () => {
    const fake = new FakeApiClient({ analyticsFailure: new ApiError(500, 'Internal', 'boom') });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      expect(host.textContent).toContain('load analytics');
      expect(host.textContent).toContain('boom');
      fake.analyticsFailure = null;
      clickText(host, 'button', 'Retry');
      await flush();
      expect(host.textContent).toContain('$12.50');
    } finally {
      dispose();
    }
  });

  it('Requests "Load more" appends the next page over a frozen window', async () => {
    const { host, store, dispose } = mount(createAppStore(new FakeApiClient()));
    try {
      await flush();
      clickNav(host, 'Requests');
      await flush();
      expect(host.querySelectorAll('.req-row').length).toBe(25);
      clickText(host, 'button', 'Load more');
      await flush();
      expect(host.querySelectorAll('.req-row').length).toBe(30);
      expect(new Set(store.state.requestList.map((r) => r.id)).size).toBe(30);
    } finally {
      dispose();
    }
  });

  it('a filter chip narrows the list via the fake server-side filter', async () => {
    const { host, store, dispose } = mount(createAppStore(new FakeApiClient()));
    try {
      await flush();
      clickNav(host, 'Requests');
      await flush();
      clickText(host, 'button', 'Fallbacks');
      await flush();
      expect(store.state.requestList.length).toBeGreaterThan(0);
      expect(store.state.requestList.every((r) => r.status === 'fallback')).toBe(true);
      expect(host.querySelectorAll('.req-row').length).toBe(store.state.requestList.length);
    } finally {
      dispose();
    }
  });
});

/* ── The readout strip (dashboard-analytics "Overview and Costs state their headline figures in
 * one readout strip"; adopt-design-tokens-v2 tasks 12.1 / 12.2, design.md D10) ──────────────────
 * The real stylesheet is loaded so sizes are COMPUTED, not inferred from class names: happy-dom
 * resolves rem against the 16px root (it does no layout, but sizes are computed values). */

const CSS = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8');

/** A summary for a range with no traffic at all. */
const EMPTY_RANGE: AnalyticsSummary = Object.fromEntries(
  Object.entries(DEFAULT_SUMMARY).map(([k, v]) => [k, typeof v === 'number' ? 0 : v]),
) as unknown as AnalyticsSummary;

const size = (e: Element): string => getComputedStyle(e).fontSize;

/** Every element that STARTS a run of the given computed size: its own size is `px` and its
 * parent's is not. Counted over the whole page, so a 26px figure anywhere — in the strip or
 * not — counts; the children of one figure do not count again. */
function sizedRoots(host: HTMLElement, px: string): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('*')].filter(
    (e) => size(e) === px && (e.parentElement === null || size(e.parentElement) !== px),
  );
}

interface StripCell {
  id: string | null;
  label: string;
  figure: string;
  figureSize: string;
  sub: string;
}

function strip(host: HTMLElement): { panels: HTMLElement[]; cells: StripCell[] } {
  const panels = [...host.querySelectorAll<HTMLElement>('[data-readout-strip]')];
  const cells = [...(panels[0]?.querySelectorAll<HTMLElement>('[data-readout]') ?? [])].map((c) => {
    const fig = c.querySelector<HTMLElement>('.readout-figure');
    return {
      id: c.getAttribute('data-readout'),
      label: c.querySelector('.readout-label')?.textContent?.trim() ?? '',
      figure: fig?.textContent?.trim() ?? '',
      figureSize: fig ? size(fig) : '',
      sub: (c.querySelector('.readout-sub')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    };
  });
  return { panels, cells };
}

async function openPage(
  page: 'Overview' | 'Costs',
  summary?: Partial<AnalyticsSummary>,
  client?: FakeApiClient,
): Promise<{ host: HTMLElement; dispose: () => void }> {
  const fake =
    client ??
    new FakeApiClient(summary === undefined ? {} : { summary: { ...DEFAULT_SUMMARY, ...summary } });
  const m = mount(createAppStore(fake));
  await flush();
  if (page === 'Costs') {
    clickNav(m.host, 'Costs');
    await flush();
  }
  return m;
}

describe('Overview states its headline figures in one readout strip (task 12.1)', () => {
  let sheet: HTMLStyleElement;
  beforeEach(() => {
    sheet = document.createElement('style');
    sheet.textContent = CSS;
    document.head.appendChild(sheet);
  });
  afterEach(() => {
    sheet.remove();
    localStorage.clear();
    delete document.documentElement.dataset['theme'];
  });

  it('one panel: spend at 26px, requests, tokens and success rate at 15px, each with its sub-line', async () => {
    const { host, dispose } = await openPage('Overview');
    try {
      const { panels, cells } = strip(host);
      expect(panels, 'one readout strip').toHaveLength(1);
      expect(panels[0]!.classList.contains('panel'), 'the strip is one panel').toBe(true);
      expect(host.querySelector('.rs-grid-4'), 'the tiles are gone').toBeNull();
      expect(cells.map((c) => [c.id, c.label, c.figureSize])).toEqual([
        ['spend', 'Spend · 24h', '26px'],
        ['requests', 'Requests', '15px'],
        ['tokens', 'Tokens', '15px'],
        ['success', 'Success rate', '15px'],
      ]);
      // DEFAULT_SUMMARY: $12.50, 30 requests, 120k + 45k + 4.5k cached tokens, 24 of 30 ok.
      expect(cells.map((c) => c.figure)).toEqual(['$12.50', '30', '0.17M', '80.0%']);
      expect(cells[0]!.sub).toBe('3 flagged ~estimated');
      expect(cells[1]!.sub, 'no placeholder once the summary has loaded').toBe('');
      // The arrows are for the eye and the words for a screen reader; `cached` keeps its word.
      // (45k out is 0.045M, which `toFixed(2)` renders 0.04M, as the tile did.)
      expect(cells[2]!.sub).toBe('0.12M↑ 0.04M↓0.12M tokens in, 0.04M out · 0.00M cached');
      const tokens = panels[0]!.querySelector('[data-readout="tokens"] .readout-sub')!;
      expect(tokens.querySelector('[aria-hidden="true"]')?.textContent).toBe('0.12M↑ 0.04M↓');
      expect(tokens.querySelector('.sr-only')?.textContent).toBe('0.12M tokens in, 0.04M out');
      expect(cells[3]!.sub).toBe('fallback 13.3% · escalated 20.0%');
      // The view's ONE Display figure, counted over the whole page, is the spend.
      const display = sizedRoots(host, '26px');
      expect(display.map((e) => e.textContent?.trim())).toEqual(['$12.50']);
      // No accent fill and no icon chip: prominence comes from size, never colour.
      expect(panels[0]!.querySelector('svg, [data-page-icon]')).toBeNull();
      expect(panels[0]!.outerHTML, 'the strip or a cell draws the accent').not.toMatch(/--accent/);
    } finally {
      dispose();
    }
  });

  it('an empty range renders the zero-state copy, never NaN, and still one Display figure', async () => {
    const { host, dispose } = await openPage('Overview', EMPTY_RANGE);
    try {
      const { cells, panels } = strip(host);
      expect(cells.map((c) => c.figure)).toEqual(['$0.00', '0', '0.00M', '—']);
      expect(cells[0]!.sub).toBe('0 flagged ~estimated');
      expect(cells[3]!.sub).toBe('no requests yet');
      expect(panels[0]!.textContent).not.toMatch(/NaN|undefined|Infinity/);
      expect(sizedRoots(host, '26px')).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  it('the requests cell reads `loading…` until the first summary arrives', async () => {
    class HeldSummary extends FakeApiClient {
      override summary(): Promise<AnalyticsSummary> {
        return new Promise<AnalyticsSummary>(() => undefined);
      }
    }
    const { host, dispose } = await openPage('Overview', undefined, new HeldSummary());
    try {
      expect(strip(host).cells.find((c) => c.id === 'requests')?.sub).toBe('loading…');
      expect(sizedRoots(host, '26px')).toHaveLength(1);
    } finally {
      dispose();
    }
  });
});

describe('Costs states its spend in the readout strip, keeping every qualification (task 12.2)', () => {
  let sheet: HTMLStyleElement;
  beforeEach(() => {
    sheet = document.createElement('style');
    sheet.textContent = CSS;
    document.head.appendChild(sheet);
  });
  afterEach(() => {
    sheet.remove();
    localStorage.clear();
    delete document.documentElement.dataset['theme'];
  });

  it('a range holding subscription, estimate-priced and pre-snapshot spend states each in its place', async () => {
    const { host, dispose } = await openPage('Costs', {
      spend: 2,
      estimatedCount: 4,
      subscriptionSpend: 5,
      nativeFamilySpend: 0.75,
      unknownSpend: 1.25,
    });
    try {
      const { panels, cells } = strip(host);
      expect(panels).toHaveLength(1);
      expect(cells.map((c) => [c.id, c.label, c.figure, c.figureSize])).toEqual([
        ['spend', 'Spend · 24h', '$2.00', '26px'],
        ['subscription', 'Served on subscription', '$5.0000', '15px'],
        ['estimate-priced', 'Estimate-priced', '$0.7500', '15px'],
      ]);
      const spend = cells[0]!.sub;
      expect(spend).toContain('both ledgers');
      expect(spend).toContain('excludes subscription');
      expect(spend).toContain('4 requests ~estimated');
      expect(spend).toBe(
        'both ledgers, excludes subscription · 4 requests ~estimated' +
          'includes $1.2500 recorded before subscription tracking — cannot be classified',
      );
      // The two figures left the spend sub-line: their own cells state them now.
      expect(spend).not.toMatch(/served on subscription|estimate-priced|^\+/i);
      expect(cells[1]!.sub).toBe('excluded from spend');
      expect(cells[2]!.sub).toBe('included in spend');
      // The pre-snapshot sentence is its own line under the qualification.
      const pre = panels[0]!.querySelector('[data-readout="spend"] .readout-sub div');
      expect(pre?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
        'includes $1.2500 recorded before subscription tracking — cannot be classified',
      );
      // The subscription value lost its indigo text: its own labelled cell distinguishes it.
      expect(panels[0]!.outerHTML).not.toMatch(/--accent/);
      // The request mix and the cost-integrity note stay panels, outside the strip.
      expect(panels[0]!.querySelector('[data-testid="mix-bar"]')).toBeNull();
      expect(host.querySelector('[data-testid="mix-bar"]')).not.toBeNull();
      expect(panels[0]!.textContent).not.toContain('Cost integrity');
      expect(host.textContent).toContain('Cost integrity');
      expect(sizedRoots(host, '26px').map((e) => e.textContent?.trim())).toEqual(['$2.00']);
    } finally {
      dispose();
    }
  });

  it('a range with neither subscription nor estimate-priced spend holds only the spend cell', async () => {
    const { host, dispose } = await openPage('Costs', {
      estimatedCount: 0,
      subscriptionSpend: 0,
      nativeFamilySpend: 0,
      unknownSpend: 0,
    });
    try {
      const { cells, panels } = strip(host);
      expect(cells.map((c) => c.id)).toEqual(['spend']);
      expect(cells[0]!.sub).toBe('both ledgers, excludes subscription · 0 requests ~estimated');
      // Absent, not a zero or a placeholder.
      expect(panels[0]!.textContent).not.toMatch(/\$0\.0000|subscription value|estimate-priced/i);
      expect(panels[0]!.textContent).not.toMatch(/served on subscription|included in spend/i);
      expect(sizedRoots(host, '26px').map((e) => e.textContent?.trim())).toEqual(['$12.50']);
    } finally {
      dispose();
    }
  });

  it('an empty range still holds exactly one Display figure, and no NaN', async () => {
    const { host, dispose } = await openPage('Costs', EMPTY_RANGE);
    try {
      const { cells, panels } = strip(host);
      expect(cells.map((c) => [c.id, c.figure])).toEqual([['spend', '$0.00']]);
      expect(panels[0]!.textContent).not.toMatch(/NaN|undefined|Infinity/);
      expect(sizedRoots(host, '26px')).toHaveLength(1);
    } finally {
      dispose();
    }
  });
});
