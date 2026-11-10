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
      // The notice names what failed; the raw error leaves it (adopt-figure-states 3.2).
      expect(host.textContent).toContain('Analytics couldn’t be loaded. Routing is unaffected.');
      expect(host.textContent).not.toContain('boom');
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
): Promise<{ host: HTMLElement; store: AppStore; dispose: () => void }> {
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
      // Tokens are compact through the one formatter (adopt-figure-states 3.2), not `0.17M`.
      expect(cells.map((c) => c.figure)).toEqual(['$12.50', '30', '169.5k', '80.0%']);
      // `3 flagged ~estimated` became words (adopt-figure-states 3.2).
      expect(cells[0]!.sub).toBe('3 requests with estimated usage');
      expect(cells[1]!.sub, 'no placeholder once the summary has loaded').toBe('');
      // The arrows are for the eye and the words for a screen reader; `cached` keeps its word.
      expect(cells[2]!.sub).toBe('120k↑ 45k↓120k tokens in, 45k out · 4.5k cached');
      const tokens = panels[0]!.querySelector('[data-readout="tokens"] .readout-sub')!;
      expect(tokens.querySelector('[aria-hidden="true"]')?.textContent).toBe('120k↑ 45k↓');
      expect(tokens.querySelector('.sr-only')?.textContent).toBe('120k tokens in, 45k out');
      expect(cells[3]!.sub).toBe('fallback 13.3% · escalated 20.0%');
      expect(panels[0]!.textContent).not.toMatch(/~|—/);
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

  it('an empty range states measured zeros and a rate that does not apply, never NaN, and still one Display figure', async () => {
    const { host, dispose } = await openPage('Overview', EMPTY_RANGE);
    try {
      const { cells, panels } = strip(host);
      // Measured zeros stay zeros; the rate of nothing is `not applicable`, in Ink 3, with a
      // sentence that says why (adopt-figure-states 3.2, D5).
      expect(cells.map((c) => c.figure)).toEqual(['$0.00', '0', '0', 'not applicable']);
      expect(
        panels[0]!.querySelector<HTMLElement>('[data-readout="success"] .readout-figure span')
          ?.style.color,
      ).toBe('var(--text3)');
      expect(cells[3]!.sub).toBe('No requests in this range');
      // The reason sits on the success-rate row itself, after its figure (redesign-readout-strip
      // D5), and the range states no subscription line or share.
      const success = panels[0]!.querySelector<HTMLElement>(
        '.readout-row[data-readout="success"]',
      )!;
      expect([...success.children].map((c) => c.textContent?.trim())).toEqual([
        'Success rate',
        'not applicable',
        'No requests in this range',
      ]);
      expect(panels[0]!.querySelector('.readout-secondary')).toBeNull();
      expect(cells[1]!.sub).toBe('');
      // No estimated-usage caption at zero, where DS-1 pinned `0 flagged ~estimated`.
      expect(cells[0]!.sub).toBe('');
      expect(panels[0]!.querySelector('.readout-qualifier')).toBeNull();
      expect(panels[0]!.textContent).not.toMatch(/NaN|undefined|Infinity|~|—|no requests yet/);
      expect(sizedRoots(host, '26px')).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  it('first load: a skeleton named for each figure, empty sub-lines, and still one Display and three Title figures', async () => {
    class HeldSummary extends FakeApiClient {
      override summary(): Promise<AnalyticsSummary> {
        return new Promise<AnalyticsSummary>(() => undefined);
      }
    }
    const { host, dispose } = await openPage('Overview', undefined, new HeldSummary());
    try {
      const { cells, panels } = strip(host);
      const hidden = (id: string): string[] =>
        [...panels[0]!.querySelectorAll(`[data-readout="${id}"] .readout-figure .sr-only`)].map(
          (e) => e.textContent ?? '',
        );
      expect(['spend', 'requests', 'tokens', 'success'].map(hidden)).toEqual([
        ['Loading spend'],
        ['Loading requests'],
        ['Loading tokens'],
        ['Loading success rate'],
      ]);
      for (const block of panels[0]!.querySelectorAll('.readout-figure .fig-skel'))
        expect(block.getAttribute('aria-hidden')).toBe('true');
      expect(panels[0]!.querySelectorAll('.readout-figure .fig-skel')).toHaveLength(4);
      // Every sub-line says nothing yet: no `0.00M↑`, `no requests yet` or `loading…`.
      expect(cells.map((c) => c.sub)).toEqual(['', '', '', '']);
      const shown = panels[0]!.textContent.replace(/Loading [a-z ]+/g, '');
      expect(shown).not.toMatch(/\$0\.00|0\.00M|\b0\b|loading…|—|no requests yet/);
      expect(panels[0]!.querySelector('.readout-qualifier')).toBeNull();
      expect(sizedRoots(host, '26px')).toHaveLength(1);
      expect(sizedRoots(panels[0]!, '15px')).toHaveLength(3);
    } finally {
      dispose();
    }
  });

  it('a sub-cent spend reads below precision, never $0.00', async () => {
    const { host, dispose } = await openPage('Overview', { spend: 0.004 });
    try {
      expect(strip(host).cells[0]!.figure).toBe('<$0.01');
      expect(sizedRoots(host, '26px').map((e) => e.textContent?.trim())).toEqual(['<$0.01']);
    } finally {
      dispose();
    }
  });

  it('a partly priced spend is followed by its unpriced count in Ink 3, outside the Display figure', async () => {
    const { host, dispose } = await openPage('Overview', { spend: 12.5, unpricedRequests: 4 });
    try {
      const cell = strip(host).panels[0]!.querySelector<HTMLElement>('[data-readout="spend"]')!;
      // The 26px figure is the amount alone…
      expect(sizedRoots(host, '26px').map((e) => e.textContent?.trim())).toEqual(['$12.50']);
      // …and the qualifier follows it in the same cell, in Ink 3, at caption size.
      const q = cell.querySelector<HTMLElement>('.readout-qualifier');
      expect(q?.textContent).toBe('· 4 unpriced');
      expect(q?.querySelector<HTMLElement>('span')?.style.color).toBe('var(--text3)');
      expect(size(q!)).toBe('11px');
      expect(cell.querySelector('.readout-figure')?.contains(q)).toBe(false);
    } finally {
      dispose();
    }
    const fully = await openPage('Overview', { unpricedRequests: 0 });
    try {
      expect(fully.host.querySelector('.readout-qualifier')).toBeNull();
      expect(fully.host.querySelector('[data-readout-strip]')?.textContent).not.toContain(
        'unpriced',
      );
    } finally {
      fully.dispose();
    }
  });

  it('the spend sub-line names estimate-priced spend and estimated usage in words, each absent at zero', async () => {
    const both = await openPage('Overview', { nativeFamilySpend: 0.0042, estimatedCount: 12 });
    try {
      expect(strip(both.host).cells[0]!.sub).toBe(
        'includes $0.0042 estimate-priced · 12 requests with estimated usage',
      );
      expect(both.host.querySelector('[data-readout-strip]')?.textContent).not.toMatch(/~|—/);
    } finally {
      both.dispose();
    }
    const priced = await openPage('Overview', { nativeFamilySpend: 0.0042, estimatedCount: 0 });
    try {
      expect(strip(priced.host).cells[0]!.sub).toBe('includes $0.0042 estimate-priced');
    } finally {
      priced.dispose();
    }
    const usage = await openPage('Overview', { nativeFamilySpend: 0, estimatedCount: 1 });
    try {
      expect(strip(usage.host).cells[0]!.sub).toBe('1 request with estimated usage');
    } finally {
      usage.dispose();
    }
  });

  // redesign-readout-strip 2.1: Overview states the value served on subscription beside spend,
  // in Costs' words, and the requests row its subscription share (design D2, D3).
  it('Overview states the subscription value beside spend', async () => {
    const { host, dispose } = await openPage('Overview', {
      spend: 0,
      cashSpend: 0,
      subscriptionSpend: 3.12,
      requests: 41,
      successCount: 40,
      subscriptionPricedRequests: 41,
      cashPricedRequests: 0,
      estimatedCount: 1,
    });
    try {
      const { cells, panels } = strip(host);
      expect(cells[0]!.figure).toBe('$0.00');
      const focal = panels[0]!.querySelector<HTMLElement>('[data-readout="spend"]')!;
      expect(focal.querySelector('.readout-secondary')?.textContent).toBe(
        '$3.12 served on subscription, at API rates · excluded from spend',
      );
      // The secondary line is not the qualification: that still states estimated usage.
      expect(cells[0]!.sub).toBe('1 request with estimated usage');
      expect(cells[1]!.sub).toBe('all on subscription plans');
      // No word beside the figure calls it billed or cash.
      expect(focal.textContent).not.toMatch(/billed|cash/i);
      // Still the one Display figure: the subscription value is Body text, not a second.
      expect(sizedRoots(host, '26px').map((e) => e.textContent?.trim())).toEqual(['$0.00']);
    } finally {
      dispose();
    }
  });

  it('A range without subscription traffic reads as before on Overview', async () => {
    const { host, dispose } = await openPage('Overview', {
      subscriptionSpend: 0,
      subscriptionPricedRequests: 0,
    });
    try {
      const { cells, panels } = strip(host);
      expect(panels[0]!.querySelector('.readout-secondary')).toBeNull();
      expect(panels[0]!.textContent).not.toMatch(/served on subscription|subscription plans/);
      expect(cells[1]!.sub).toBe('');
      expect(cells.map((c) => c.figure)).toEqual(['$12.50', '30', '169.5k', '80.0%']);
    } finally {
      dispose();
    }
  });

  it('The requests row states a partial subscription share', async () => {
    const { host, dispose } = await openPage('Overview', {
      requests: 41,
      successCount: 40,
      subscriptionPricedRequests: 12,
      cashPricedRequests: 29,
      subscriptionSpend: 1.5,
    });
    try {
      const { cells } = strip(host);
      expect(cells[1]!.sub).toBe('12 on subscription plans');
      // Only the subscription share: no count of the rest (FD3).
      expect(cells[1]!.sub).not.toMatch(/billed|29/);
    } finally {
      dispose();
    }
  });

  it('a refetch keeps the figures it replaces, with no skeleton in their place', async () => {
    const fake = new HeldAfterFirst();
    const { host, store, dispose } = await openPage('Overview', undefined, fake);
    try {
      expect(strip(host).cells[0]!.figure).toBe('$12.50');
      fake.hold = true;
      // The next poll's summary is still in flight.
      void store.loadOverview();
      await flush();
      const { cells, panels } = strip(host);
      expect(cells.map((c) => c.figure)).toEqual(['$12.50', '30', '169.5k', '80.0%']);
      expect(panels[0]!.querySelector('.fig-skel')).toBeNull();
    } finally {
      dispose();
    }
  });

  it('a failed read removes the figures under a neutral notice; Retry refetches and leaves focus on the strip', async () => {
    const fake = new HeldAfterFirst();
    const m = await openPage('Overview', undefined, fake);
    try {
      expect(strip(m.host).cells[0]!.figure).toBe('$12.50');
      // A later read fails: the store keeps the old summary, the page must not.
      fake.analyticsFailure = new ApiError(500, 'Internal', 'boom');
      await m.store.loadOverview();
      await flush();
      const notice = m.host.querySelector<HTMLElement>('.notice')!;
      expect(notice.querySelector('.notice-title')?.textContent).toBe('Couldn’t load');
      expect(notice.querySelector('.notice-body')?.textContent).toBe(
        'Analytics couldn’t be loaded. Routing is unaffected.',
      );
      expect(notice.textContent).not.toContain('boom');
      const failed = strip(m.host);
      expect(failed.panels).toHaveLength(1);
      expect(failed.cells.map((c) => c.figure)).toEqual(['', '', '', '']);
      expect(failed.cells.map((c) => c.sub)).toEqual(['', '', '', '']);
      expect(failed.panels[0]!.querySelector('.fig-skel, .readout-qualifier')).toBeNull();
      expect(failed.panels[0]!.textContent).not.toContain('$');

      // Retry, focused before the click: its load starts, the notice goes, and focus lands on
      // the strip's panel, never <body>.
      fake.analyticsFailure = null;
      fake.hold = true;
      const retry = [...notice.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => labelText(b) === 'Retry',
      )!;
      retry.focus();
      retry.click();
      await Promise.resolve();
      const panel = m.host.querySelector<HTMLElement>('[data-readout-strip]')!;
      expect(m.host.querySelector('.notice')).toBeNull();
      expect(panel.getAttribute('tabindex')).toBe('-1');
      expect(document.activeElement).toBe(panel);
      // While the retry is in flight its figures load as skeletons, never the old summary.
      expect(strip(m.host).cells[0]!.figure).not.toContain('$');
      expect(panel.querySelectorAll('.readout-figure .fig-skel')).toHaveLength(4);
      fake.release();
      await flush();
      expect(strip(m.host).cells[0]!.figure).toBe('$12.50');
      expect(document.activeElement).toBe(panel);
    } finally {
      m.dispose();
    }
  });
});

/** Overview's chart and recent rows are figures from their own reads (adopt-figure-states D5,
 * dashboard-core "Failed, unavailable and absent figures are distinct states"): a failed read
 * removes them and never reads as a measured empty range, and a first load is a skeleton or a
 * loading line, never `No requests in this range`. */
describe('Overview removes a failed read’s chart and recent rows, and never shows it as an empty range', () => {
  afterEach(() => {
    localStorage.clear();
  });
  const chartPanel = (host: HTMLElement): HTMLElement =>
    [...host.querySelectorAll<HTMLElement>('.panel.card')].find((p) =>
      (p.querySelector('.section-title')?.textContent ?? '').startsWith('Requests ·'),
    )!;
  const recentPanel = (host: HTMLElement): HTMLElement =>
    host.querySelector<HTMLElement>('.rs-table-requests')!;
  const rowCount = (host: HTMLElement): number =>
    recentPanel(host).querySelectorAll('.req-row').length;
  const chartShown = (host: HTMLElement): boolean =>
    chartPanel(host).querySelector('[data-measure="requests"]') !== null;

  it('a failed first load shows neither the empty-range sentences nor a skeleton, and Retry loads them', async () => {
    const fake = new FakeApiClient({ analyticsFailure: new ApiError(500, 'Internal', 'boom') });
    const m = mount(createAppStore(fake));
    try {
      await flush();
      expect(m.host.querySelector('.notice-body')?.textContent).toBe(
        'Analytics couldn’t be loaded. Routing is unaffected.',
      );
      expect(chartShown(m.host)).toBe(false);
      expect(chartPanel(m.host).textContent).not.toMatch(/No requests|Loading/);
      expect(chartPanel(m.host).querySelector('.fig-skel')).toBeNull();
      expect(rowCount(m.host)).toBe(0);
      expect(recentPanel(m.host).textContent).not.toMatch(/No requests in this range yet|Loading/);
      fake.analyticsFailure = null;
      [...m.host.querySelectorAll<HTMLButtonElement>('.notice button')]
        .find((b) => labelText(b) === 'Retry')!
        .click();
      // The retry loads (its slices are marked loading as the click runs): the chart as a
      // skeleton named for what loads, the rows as the list's loading line, never the
      // empty-range sentences.
      expect(chartPanel(m.host).querySelector('.sr-only')?.textContent).toBe(
        'Loading requests over time',
      );
      expect(recentPanel(m.host).textContent).toContain('Loading…');
      await flush();
      expect(chartShown(m.host)).toBe(true);
      expect(rowCount(m.host)).toBeGreaterThan(0);
    } finally {
      m.dispose();
    }
  });

  it('a failed refetch removes the chart and the rows it would have replaced', async () => {
    const fake = new FakeApiClient();
    const m = mount(createAppStore(fake));
    try {
      await flush();
      expect(chartShown(m.host)).toBe(true);
      const before = rowCount(m.host);
      expect(before).toBeGreaterThan(0);
      fake.analyticsFailure = new ApiError(500, 'Internal', 'boom');
      await m.store.loadOverview();
      await flush();
      // The store keeps its last series and rows; the page must not show them as current.
      expect(m.store.state.analyticsSeries.length).toBeGreaterThan(0);
      expect(m.store.state.recentRequests.length).toBe(before);
      expect(chartShown(m.host)).toBe(false);
      expect(chartPanel(m.host).textContent).not.toMatch(/No requests|Loading/);
      expect(rowCount(m.host)).toBe(0);
      expect(recentPanel(m.host).textContent).not.toMatch(/No requests in this range yet|Loading/);
    } finally {
      m.dispose();
    }
  });

  it('a first load is a skeleton, and a measured empty range says so once its read commits', async () => {
    class HeldSeries extends FakeApiClient {
      hold = true;
      private parked: (() => void)[] = [];
      override timeseries(
        ...args: Parameters<FakeApiClient['timeseries']>
      ): ReturnType<FakeApiClient['timeseries']> {
        if (!this.hold) return super.timeseries(...args);
        return new Promise((resolve, reject) => {
          this.parked.push(() => {
            super.timeseries(...args).then(resolve, reject);
          });
        });
      }
      release(): void {
        this.hold = false;
        for (const go of this.parked.splice(0)) go();
      }
    }
    const fake = new HeldSeries({ timeseries: [], requestRows: [] });
    const m = mount(createAppStore(fake));
    try {
      await flush();
      expect(chartPanel(m.host).textContent).not.toContain('No requests in this range');
      expect(chartPanel(m.host).querySelector('.fig-skel')?.getAttribute('aria-hidden')).toBe(
        'true',
      );
      expect(chartPanel(m.host).querySelector('.sr-only')?.textContent).toBe(
        'Loading requests over time',
      );
      fake.release();
      await flush();
      expect(chartPanel(m.host).querySelector('.fig-skel')).toBeNull();
      expect(chartPanel(m.host).textContent).toContain('No requests in this range');
      expect(recentPanel(m.host).textContent).toContain('No requests in this range yet.');
    } finally {
      m.dispose();
    }
  });
});

/** A fake whose summary reads can be held in flight and released later, so a test can see a
 * refetch or a retry mid-load. */
class HeldAfterFirst extends FakeApiClient {
  hold = false;
  private parked: (() => void)[] = [];
  override summary(range: Parameters<FakeApiClient['summary']>[0]): Promise<AnalyticsSummary> {
    if (!this.hold) return super.summary(range);
    return new Promise<AnalyticsSummary>((resolve, reject) => {
      this.parked.push(() => {
        super.summary(range).then(resolve, reject);
      });
    });
  }
  release(): void {
    this.hold = false;
    for (const go of this.parked.splice(0)) go();
  }
}

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
      // Subscription at cents (`$5.00`, where DS-1 pinned `$5.0000`); the estimate-priced
      // portion keeps four decimals (adopt-figure-states 3.3, D2).
      expect(cells.map((c) => [c.id, c.label, c.figure, c.figureSize])).toEqual([
        ['spend', 'Spend · 24h', '$2.00', '26px'],
        ['subscription', 'Served on subscription', '$5.00', '15px'],
        ['estimate-priced', 'Estimate-priced', '$0.7500', '15px'],
      ]);
      const spend = cells[0]!.sub;
      expect(spend).toContain('both ledgers');
      expect(spend).toContain('excludes subscription');
      expect(spend).toContain('4 requests with estimated usage');
      // The unclassified line at cents: `$1.25`, where DS-1 pinned `$1.2500`.
      expect(spend).toBe(
        'both ledgers, excludes subscription · 4 requests with estimated usage' +
          'includes $1.25 recorded before subscription tracking — cannot be classified',
      );
      expect(panels[0]!.textContent).not.toMatch(/~|—\s*unpriced/);
      // The two figures left the spend sub-line: their own cells state them now.
      expect(spend).not.toMatch(/served on subscription|estimate-priced|^\+/i);
      expect(cells[1]!.sub).toBe('excluded from spend');
      expect(cells[2]!.sub).toBe('included in spend');
      // The pre-snapshot sentence is its own line under the qualification.
      const pre = panels[0]!.querySelector('[data-readout="spend"] .readout-sub div');
      expect(pre?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
        'includes $1.25 recorded before subscription tracking — cannot be classified',
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
      // No estimated-usage words at zero, where DS-1 pinned `0 requests ~estimated`.
      expect(cells[0]!.sub).toBe('both ledgers, excludes subscription');
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

  it('a partly priced spend is followed by its unpriced count in Ink 3, and the spend sub-line names estimated usage', async () => {
    const { host, dispose } = await openPage('Costs', {
      spend: 0.004,
      unpricedRequests: 4,
      estimatedCount: 12,
      nativeFamilySpend: 0,
      subscriptionSpend: 0,
      unknownSpend: 0,
    });
    try {
      const { cells, panels } = strip(host);
      // A sub-cent spend reads below precision, and the 26px figure is the amount alone.
      expect(sizedRoots(host, '26px').map((e) => e.textContent?.trim())).toEqual(['<$0.01']);
      const q = panels[0]!.querySelector<HTMLElement>('[data-readout="spend"] .readout-qualifier');
      expect(q?.textContent).toBe('· 4 unpriced');
      expect(q?.querySelector<HTMLElement>('span')?.style.color).toBe('var(--text3)');
      expect(cells[0]!.sub).toBe(
        'both ledgers, excludes subscription · 12 requests with estimated usage',
      );
      // The estimate-priced words stay in their own cell, never on this sub-line.
      expect(cells[0]!.sub).not.toContain('estimate-priced');
      // The cost-integrity line names the same count in words.
      expect(host.textContent).toContain('12 requests with estimated usage.');
      expect(host.textContent).not.toMatch(/~/);
    } finally {
      dispose();
    }
  });

  it('first load: a Spend skeleton with an empty sub-line, and no Title cell', async () => {
    class HeldSummary extends FakeApiClient {
      override summary(): Promise<AnalyticsSummary> {
        return new Promise<AnalyticsSummary>(() => undefined);
      }
    }
    const { host, dispose } = await openPage('Costs', undefined, new HeldSummary());
    try {
      const { cells, panels } = strip(host);
      expect(cells.map((c) => c.id)).toEqual(['spend']);
      expect(
        [...panels[0]!.querySelectorAll('[data-readout="spend"] .readout-figure .sr-only')].map(
          (e) => e.textContent,
        ),
      ).toEqual(['Loading spend']);
      expect(
        panels[0]!.querySelector('.readout-figure .fig-skel')?.getAttribute('aria-hidden'),
      ).toBe('true');
      expect(cells[0]!.sub).toBe('');
      expect(panels[0]!.textContent).not.toMatch(/\$|subscription|estimate-priced/i);
      expect(sizedRoots(host, '26px')).toHaveLength(1);
      // The request mix and the cost-integrity count come from the same summary read, so
      // they load with the strip: a skeleton named for the mix, never zeros standing in
      // (dashboard-core "A zero is a measurement, never a placeholder").
      expect(host.textContent).not.toMatch(/\d+% \(\d+\)|not applicable \(/);
      expect(host.querySelector('[data-testid="mix-bar"]')).toBeNull();
      const mixLoading = host.querySelector<HTMLElement>('[data-testid="mix-loading"]');
      expect(mixLoading?.querySelector('.fig-skel')?.getAttribute('aria-hidden')).toBe('true');
      expect(mixLoading?.querySelector('.sr-only')?.textContent).toBe('Loading request mix');
      expect(host.textContent).not.toContain('with estimated usage');
    } finally {
      dispose();
    }
  });

  it('a failed read removes the figures under a neutral notice; Retry refetches and leaves focus on the strip', async () => {
    const fake = new HeldAfterFirst({
      summary: {
        ...DEFAULT_SUMMARY,
        spend: 2,
        subscriptionSpend: 5,
        nativeFamilySpend: 0.75,
        notBilledRequests: 2,
      },
    });
    const m = await openPage('Costs', undefined, fake);
    try {
      expect(strip(m.host).cells.map((c) => c.id)).toEqual([
        'spend',
        'subscription',
        'estimate-priced',
      ]);
      expect(m.host.querySelector('[data-testid="mix-bar"]')).not.toBeNull();
      expect(m.host.textContent).toContain('free 80% (8)');
      expect(m.host.textContent).toContain('3 requests with estimated usage.');
      expect(m.host.querySelector('[data-testid="not-billed-caption"]')).not.toBeNull();
      fake.analyticsFailure = new ApiError(500, 'Internal', 'boom');
      await m.store.loadCosts();
      await flush();
      // The request mix and the integrity count were the same read's figures: removed with
      // the strip's, never left on screen as current under the notice.
      expect(m.host.querySelector('[data-testid="mix-bar"]')).toBeNull();
      expect(m.host.querySelector('[data-testid="mix-loading"]')).toBeNull();
      expect(m.host.textContent).not.toMatch(/\d+% \(\d+\)/);
      expect(m.host.textContent).not.toContain('with estimated usage');
      expect(m.host.querySelector('[data-testid="not-billed-caption"]')).toBeNull();
      const notice = m.host.querySelector<HTMLElement>('.notice')!;
      expect(notice.querySelector('.notice-title')?.textContent).toBe('Couldn’t load');
      expect(notice.querySelector('.notice-body')?.textContent).toBe(
        'Cost analytics couldn’t be loaded. Routing is unaffected.',
      );
      expect(notice.textContent).not.toContain('boom');
      const failed = strip(m.host);
      expect(failed.panels).toHaveLength(1);
      // Every stat figure is removed: the spend, its sub-line, and both Title cells.
      expect(failed.cells.map((c) => [c.id, c.figure, c.sub])).toEqual([['spend', '', '']]);
      expect(failed.panels[0]!.querySelector('.fig-skel, .readout-qualifier')).toBeNull();
      expect(failed.panels[0]!.textContent).not.toContain('$');

      fake.analyticsFailure = null;
      fake.hold = true;
      const retry = [...notice.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => labelText(b) === 'Retry',
      )!;
      retry.focus();
      retry.click();
      await Promise.resolve();
      const panel = m.host.querySelector<HTMLElement>('[data-readout-strip]')!;
      expect(m.host.querySelector('.notice')).toBeNull();
      expect(document.activeElement).toBe(panel);
      expect(panel.querySelectorAll('.readout-figure .fig-skel')).toHaveLength(1);
      // The retry loads the mix as a skeleton too, never the old summary's shares.
      expect(m.host.querySelector('[data-testid="mix-loading"] .fig-skel')).not.toBeNull();
      expect(m.host.textContent).not.toMatch(/\d+% \(\d+\)/);
      fake.release();
      await flush();
      expect(strip(m.host).cells.map((c) => c.figure)).toEqual(['$2.00', '$5.00', '$0.7500']);
      expect(m.host.textContent).toContain('free 80% (8)');
      expect(document.activeElement).toBe(panel);
    } finally {
      m.dispose();
    }
  });
});
