/** The breakdown metric switch (add-breakdown-metric-switch).
 *
 * The defect these guard against is one of OMISSION, which is why they assert the request
 * and the row SET rather than just the rendering: the server returns a top-N, so a client
 * that re-sorted the rows it already had would render "top by tokens" while silently
 * dropping anything that leads on tokens and trails on spend. Every assertion below would
 * pass against that broken implementation if it only checked ordering.
 */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { ApiError } from './data/api';
import { DEFAULT_SUMMARY, FakeApiClient } from './test/fakeClient';
import { BarRows } from './components/BarRows';
import { fmtTokensCompact } from './data/figures';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

interface Harness {
  host: HTMLElement;
  store: AppStore;
  fake: FakeApiClient;
  dispose: () => void;
}

async function mountPage(
  page: 'Costs' | 'Overview',
  summary?: Partial<typeof DEFAULT_SUMMARY>,
): Promise<Harness> {
  const fake = new FakeApiClient(summary ? { summary: { ...DEFAULT_SUMMARY, ...summary } } : {});
  const store = createAppStore(fake);
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
  await flush();
  [...host.querySelectorAll<HTMLElement>('.nav-item span')]
    .find((e) => e.textContent?.trim() === page)
    ?.click();
  await flush();
  return {
    host,
    store,
    fake,
    dispose: () => {
      dispose();
      host.remove();
    },
  };
}

/** Recorded `breakdown` calls with their arguments. */
/** Breakdown calls driven by the METRIC SELECTOR.
 *
 * The Overview agent strip (add-agent-request-attribution) also calls this endpoint,
 * with a fixed `requests` ranking that no selector controls — and the App mounts
 * Overview before navigating, so its call lands in the log even on a Costs harness.
 * Excluded by its metric, which is exact: the selector only ever sends `spend` or
 * `tokens`, so a genuine selector regression still fails these tests. */
const breakdownCalls = (fake: FakeApiClient): { method: string; args: unknown[] }[] =>
  fake.callLog.filter((c) => c.method === 'breakdown' && c.args[3] !== 'requests');

const metricButton = (host: HTMLElement, label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll<HTMLButtonElement>('button.rs-seg')].find(
    (b) => b.textContent?.trim() === label,
  );

/** The bar labels of the first breakdown panel. */
const barNames = (host: HTMLElement): string[] =>
  [...(host.querySelectorAll<HTMLElement>('.panel .bar-track') ?? [])].map(
    (t) => t.parentElement?.querySelector('span')?.textContent?.trim() ?? '?',
  );

afterEach(() => {
  document.body.innerHTML = '';
});

describe('switching the metric REFETCHES', () => {
  it('asks the server for the metric rather than re-sorting what it has', async () => {
    const h = await mountPage('Costs');
    try {
      const before = breakdownCalls(h.fake).length;
      expect(before).toBeGreaterThan(0);
      // Every initial call is spend — the metric reaches the request, it is not implied.
      expect(breakdownCalls(h.fake).every((c) => c.args[3] === 'spend')).toBe(true);

      metricButton(h.host, 'tokens')?.click();
      await flush();

      const after = breakdownCalls(h.fake).slice(before);
      expect(after.length, 'switching the metric did not refetch').toBeGreaterThan(0);
      expect(after.every((c) => c.args[3] === 'tokens')).toBe(true);
      // All three dimensions re-rank together — one selector, one screen.
      expect(new Set(after.map((c) => c.args[0]))).toEqual(new Set(['model', 'provider', 'agent']));
    } finally {
      h.dispose();
    }
  });

  it('renders a DIFFERENT row set, not the same rows reordered', async () => {
    // The fixture is built so the two rankings disagree; the fake ranks then truncates,
    // like the server. A client-side re-sort would show the same names in a new order.
    const h = await mountPage('Costs');
    try {
      const spendOrder = barNames(h.host);
      metricButton(h.host, 'tokens')?.click();
      await flush();
      const tokenOrder = barNames(h.host);
      expect(tokenOrder.length).toBeGreaterThan(0);
      expect(tokenOrder, 'the metric switch changed nothing').not.toEqual(spendOrder);
    } finally {
      h.dispose();
    }
  });

  it('does not refetch when the metric is unchanged', async () => {
    const h = await mountPage('Costs');
    try {
      const before = breakdownCalls(h.fake).length;
      metricButton(h.host, 'spend')?.click();
      await flush();
      expect(breakdownCalls(h.fake).length).toBe(before);
    } finally {
      h.dispose();
    }
  });
});

describe('the panel copy follows the metric', () => {
  it('never captions a token chart as spend', async () => {
    const h = await mountPage('Costs');
    try {
      expect(h.host.textContent).toContain('Spend by model');
      metricButton(h.host, 'tokens')?.click();
      await flush();
      expect(h.host.textContent).toContain('Tokens by model');
      expect(h.host.textContent).not.toContain('Spend by model');
    } finally {
      h.dispose();
    }
  });

  it('formats token bars as counts, not dollars', async () => {
    const h = await mountPage('Costs');
    try {
      metricButton(h.host, 'tokens')?.click();
      await flush();
      const values = [...h.host.querySelectorAll<HTMLElement>('.panel .bar-track')].map(
        (t) => t.parentElement?.querySelectorAll('span')[1]?.textContent ?? '',
      );
      expect(values.length).toBeGreaterThan(0);
      expect(
        values.some((v) => v.includes('$')),
        'a token bar rendered a dollar value',
      ).toBe(false);
      // Compact through the one formatter (adopt-figure-states 3.3, D8): `12.4k`, `1.2M`.
      expect(values.some((v) => /^\d+(\.\d)?[kMB]$/.test(v))).toBe(true);
      expect(values.some((v) => /K$|\.\d\dM$/.test(v))).toBe(false);
    } finally {
      h.dispose();
    }
  });
});

describe('the Overview headline', () => {
  it('counts cache tokens, which it used to drop', async () => {
    // `inputTokens` is recorded as UNCACHED input, so the headline previously omitted a
    // cached workload's cache component entirely while looking exact.
    // A genuinely cached workload: the shared fixture's 4.5K of cache disappears at two
    // decimal places, so a test against it would render the same string either way and
    // prove nothing. These numbers are chosen so the two answers differ AS DISPLAYED.
    const cached = {
      inputTokens: 100_000,
      outputTokens: 20_000,
      cacheReadTokens: 400_000,
      cacheWriteTokens: 80_000,
    };
    const h = await mountPage('Overview', cached);
    try {
      const expected = fmtTokensCompact(
        cached.inputTokens + cached.outputTokens + cached.cacheReadTokens + cached.cacheWriteTokens,
      );
      const uncachedOnly = fmtTokensCompact(cached.inputTokens + cached.outputTokens);
      expect(
        expected,
        'the fixture renders identically either way — this test would prove nothing',
      ).not.toBe(uncachedOnly);

      const values = [...h.host.querySelectorAll<HTMLElement>('.readout-figure')].map(
        (e) => e.textContent ?? '',
      );
      // Compact through the one formatter (adopt-figure-states 3.2): `600k`, not `0.60M`.
      expect(values).toContain('600k');
      expect(values).toContain(expected);
      expect(values).not.toContain(uncachedOnly);
    } finally {
      h.dispose();
    }
  });

  it('FOLLOWS the shared metric — it offers the selector too', async () => {
    // This assertion used to be the opposite: "keeps the Overview on SPEND even though it
    // shares the breakdown slice". That was only ever half of the archived requirement, which
    // covers "the Overview and Costs pages" and says a breakdown panel's heading, empty state
    // and units SHALL follow the selected metric. Overview offered no selector and rendered
    // spend unconditionally.
    //
    // The old test had also gone vacuous: it mounted Overview fresh, where the default metric
    // is already `spend`, so it passed by coincidence rather than by asserting the behaviour
    // its name described.
    const h = await mountPage('Overview');
    try {
      expect(breakdownCalls(h.fake).every((c) => c.args[3] === 'spend')).toBe(true);
      expect(h.host.textContent).toContain('Spend by model');

      const before = breakdownCalls(h.fake).length;
      h.store.setBreakdownMetric('tokens');
      await flush();

      const made = breakdownCalls(h.fake).slice(before);
      expect(made.length, 'flipping the metric on Overview issued no refetch').toBeGreaterThan(0);
      expect(made.every((c) => c.args[3] === 'tokens')).toBe(true);
      expect(h.host.textContent).toContain('Tokens by model');
      expect(h.host.textContent).not.toContain('Spend by model');

      // And the LOAD path, which the flip path does not exercise: `loadOverview` used to
      // hardcode `spend`, so a page load with tokens selected fetched the wrong metric. This
      // is the assertion that fails if that hardcoding returns — verified by degradation,
      // because the flip above passes either way.
      const beforeLoad = breakdownCalls(h.fake).length;
      await h.store.loadOverview();
      await flush();
      const onLoad = breakdownCalls(h.fake).slice(beforeLoad);
      expect(onLoad.length, 'loadOverview fetched no breakdown').toBeGreaterThan(0);
      expect(
        onLoad.every((c) => c.args[3] === 'tokens'),
        'loadOverview requested a metric the panel is not showing',
      ).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it('does not render the token top-N under a spend heading while a refetch is in flight', async () => {
    // The transient this closes: Overview requested `spend` while the shared slice could hold
    // token-ranked rows, so navigating here after a flip on Costs briefly showed the token
    // top-N — right values, wrong models, bars not descending — captioned "Spend by model".
    const h = await mountPage('Overview');
    try {
      h.store.setState('breakdownMetric', 'tokens');
      // Rows still belong to the previous metric: the panel must blank rather than mislabel.
      h.store.setState('breakdownLoadedFor', { range: h.store.state.range, metric: 'spend' });
      await flush();
      // Scoped to the panel: the page legitimately contains `$` in the Spend headline card,
      // so asserting on the whole host would fail for an unrelated reason.
      const panel = [...h.host.querySelectorAll<HTMLElement>('.panel.card')].find((c) =>
        /by model/i.test(c.textContent ?? ''),
      );
      expect(panel, 'no breakdown panel rendered').toBeDefined();
      expect(panel?.textContent).toContain('Tokens by model');
      // The rows themselves must be BLANKED, not merely reformatted. Asserting the absence of
      // `$` proves nothing: the panel formats by the selected metric, so token formatting
      // appears whether or not the stale guard exists. What the guard changes is that no rows
      // render at all until the refetch lands.
      expect(panel?.textContent, 'stale rows rendered under the new heading').not.toContain(
        'Model 0',
      );
      // The shared skeleton, named for what loads (adopt-figure-states D5), not a bare
      // visible `Loading…`.
      expect(panel?.querySelector('.fig-skel')?.getAttribute('aria-hidden')).toBe('true');
      expect(panel?.querySelector('.sr-only')?.textContent).toBe('Loading tokens by model');
      expect(panel?.textContent).not.toContain('Loading…');
    } finally {
      h.dispose();
    }
  });
});

/** The breakdown bars are figures from their own read (adopt-figure-states D5): a failed first
 * load ends in the failed state, never a `Loading…` that stays forever, and a failed refetch
 * removes the bars it would have replaced rather than leaving them on screen as current. */
describe('a failed breakdown read removes its bars, and never loads forever', () => {
  const panels = (host: HTMLElement): HTMLElement[] =>
    [...host.querySelectorAll<HTMLElement>('.panel.card')].filter((c) =>
      /by model|by provider|by agent/i.test(c.querySelector('.section-title')?.textContent ?? ''),
    );
  const retryButton = (host: HTMLElement): HTMLButtonElement | undefined =>
    [...host.querySelectorAll<HTMLButtonElement>('.notice button')].find(
      (b) => b.textContent?.trim() === 'Retry',
    );

  it('a failed first load shows no bars, no skeleton and no Loading, and Retry loads them', async () => {
    const fake = new FakeApiClient({ analyticsFailure: new ApiError(500, 'Internal', 'boom') });
    const store = createAppStore(fake);
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
    try {
      await flush();
      [...host.querySelectorAll<HTMLElement>('.nav-item span')]
        .find((e) => e.textContent?.trim() === 'Costs')
        ?.click();
      await flush();
      expect(store.state.breakdownLoadedFor).toBeNull();
      const failed = panels(host);
      expect(failed).toHaveLength(3);
      for (const p of failed) {
        expect(p.querySelector('.fig-skel, .bar-track')).toBeNull();
        expect(p.textContent).not.toMatch(/Loading|No spend|No usage|\$/);
      }
      expect(host.querySelector('.notice-body')?.textContent).toBe(
        'Cost analytics couldn’t be loaded. Routing is unaffected.',
      );
      // Retry: the bars load as skeletons named for what loads, then commit.
      fake.analyticsFailure = null;
      retryButton(host)!.click();
      await Promise.resolve();
      expect(panels(host).map((p) => p.querySelector('.sr-only')?.textContent)).toEqual([
        'Loading spend by model',
        'Loading spend by provider',
        'Loading spend by agent',
      ]);
      await flush();
      expect(panels(host)[0]!.textContent).toContain('Model 0');
      expect(host.querySelector('.panel.card .fig-skel')).toBeNull();
    } finally {
      dispose();
      host.remove();
    }
  });

  it('a failed refetch for the same range removes the bars it would have replaced', async () => {
    const h = await mountPage('Costs');
    try {
      expect(panels(h.host)[0]!.textContent).toContain('Model 0');
      h.fake.analyticsFailure = new ApiError(500, 'Internal', 'boom');
      await h.store.loadCosts();
      await flush();
      // The store keeps its last rows; the page must not show them as current.
      expect(h.store.state.analyticsBreakdown.model.length).toBeGreaterThan(0);
      for (const p of panels(h.host)) {
        expect(p.querySelector('.fig-skel, .bar-track')).toBeNull();
        expect(p.textContent).not.toMatch(/Model 0|Provider 0|agent-0|Loading/);
      }
      expect(h.host.querySelector('.notice')).not.toBeNull();
    } finally {
      h.dispose();
    }
  });

  it('a refetch that succeeds keeps the bars on screen while it runs', async () => {
    const h = await mountPage('Costs');
    try {
      const pending = h.store.loadCosts();
      expect(h.store.state.analyticsBreakdownLoading).toBe(true);
      expect(panels(h.host)[0]!.textContent).toContain('Model 0');
      expect(panels(h.host)[0]!.querySelector('.fig-skel')).toBeNull();
      await pending;
    } finally {
      h.dispose();
    }
  });
});

/** A spend bar's label (adopt-figure-states 3.3; D1, D2, D4): money at cents, below precision
 * as `<$0.01`, and a free bar as `$0 free` with only `free` green, so the word names the state
 * and `$0` keeps the row's Ink. */
describe('a spend bar names its state in words', () => {
  it('reads cents, `<$0.01` below a cent, and `$0 free` with only `free` green', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const dispose = render(
      () => (
        <BarRows
          data={[
            { n: 'priced', v: 1.5 },
            { n: 'speck', v: 0.004 },
            { n: 'local', v: 0, fv: 0, free: true },
          ]}
        />
      ),
      host,
    );
    try {
      const figures = [...host.querySelectorAll<HTMLElement>('.figure')];
      expect(figures.map((f) => f.textContent)).toEqual(['$1.50', '<$0.01', '$0 free']);
      for (const f of figures) expect(f.style.color).toBe('var(--text)');
      const parts = [...figures[2]!.querySelectorAll<HTMLElement>('span')];
      expect(parts.map((p) => [p.textContent, p.style.color])).toEqual([
        ['$0', ''],
        ['free', 'var(--green-text)'],
      ]);
    } finally {
      dispose();
      host.remove();
    }
  });
});
