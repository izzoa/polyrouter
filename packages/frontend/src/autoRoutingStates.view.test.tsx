/** The Auto routing tab's designed states (redesign-auto-routing-pipeline, task 6.3).
 *
 * The rule under test is the same in every state: configuration never waits on the
 * aggregation, and no measured figure is fabricated, stale-as-current, or `NaN`. The
 * hazard is the store's own behaviour — it KEEPS the last data on a failed load — so
 * the failure cases assert absence against a store that still holds real figures.
 * (The arithmetic lives in `data/pipeline.test.ts`; this asserts what renders.)
 */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { ApiError, type AutoPerformance } from './data/api';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { DEFAULT_AUTO_PERF, FakeApiClient } from './test/fakeClient';
import { expandStage, openAutoTab } from './test/routingTabs';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

interface Harness {
  host: HTMLElement;
  store: AppStore;
  fake: FakeApiClient;
  dispose: () => void;
}

/** A controllable aggregation response: each call parks until settled. */
interface Pending {
  resolve: (d: AutoPerformance) => void;
  reject: (e: unknown) => void;
}

async function mount(fake: FakeApiClient): Promise<Harness> {
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
    .find((e) => e.textContent?.trim() === 'Routing')
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

/** Park every aggregation call until the test settles it. */
function deferAggregation(fake: FakeApiClient): Pending[] {
  const queue: Pending[] = [];
  fake.autoPerformance = () =>
    new Promise<AutoPerformance>((resolve, reject) => {
      queue.push({ resolve, reject });
    });
  return queue;
}

const q = (root: ParentNode, id: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const figureKinds = (h: Harness): string[] =>
  [...h.host.querySelectorAll<HTMLElement>('[data-testid="stage-figure"]')].map(
    (e) => e.dataset['kind'] ?? '',
  );
const squash = (t: string | null | undefined): string => (t ?? '').replace(/\s+/g, ' ').trim();
const targets = (h: Harness): HTMLElement => {
  const el = h.host.querySelector<HTMLElement>('#auto-targets');
  if (!el) throw new Error('the Targets area is not rendered');
  return el;
};
/** The matrix's Detected cells, row by row, as their designed state. */
const detectedKinds = (h: Harness): string[] =>
  [...targets(h).querySelectorAll<HTMLElement>('[data-testid="targets-detected"]')].map(
    (e) => e.dataset['kind'] ?? '',
  );
const detectedText = (h: Harness, row: string): string =>
  squash(
    targets(h).querySelector(`[data-row="${row}"] [data-testid="targets-detected"] .tm-body`)
      ?.textContent,
  );
/** Loading placeholders inside the target cells (the generic cells' unroutable notes). */
const cellPlaceholders = (h: Harness): number =>
  targets(h).querySelectorAll('[data-testid="targets-cell"] .ar-skel').length;
/** A configuration write must still go through in this state. */
const flipCascade = async (h: Harness): Promise<void> => {
  h.host.querySelector<HTMLButtonElement>('[aria-label="Toggle L3 · Cascade"]')!.click();
  await flush();
};

describe('loading: placeholders while the range has no data, configuration operable', () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.dispose();
    h = null;
  });

  it('shows a neutral placeholder for every figure, then the figures once they land', async () => {
    const fake = new FakeApiClient();
    const pending = deferAggregation(fake);
    h = await mount(fake);
    await openAutoTab(h.host);

    expect(pending).toHaveLength(1);
    expect(q(h.host, 'auto-loading')?.textContent).toContain('Loading auto performance…');
    expect(figureKinds(h)).toEqual(Array<string>(6).fill('placeholder'));
    expect(q(h.host, 'exit-bar')).toBeNull();
    expect(q(h.host, 'auto-savings')).toBeNull();
    // A detail's figures wait too — once, as a placeholder…
    const classify = await expandStage(h.host, 'Classify');
    expect(q(classify, 'detail-loading')).not.toBeNull();
    expect(q(classify, 'ap-band-verdicts')).toBeNull();
    // …while its configuration is already there.
    expect(classify.querySelector('[aria-label="Self-calibration"]')).not.toBeNull();
    // The targets' measured notes wait; the targets themselves do not.
    expect(targets(h).textContent).not.toContain('unroutable in the selected');
    expect(targets(h).querySelector<HTMLSelectElement>('select')?.disabled).toBe(false);
    // Every Detected cell is a placeholder, and so are the two unset generic cells'
    // unroutable notes — never a zero standing in for "not loaded".
    expect(detectedKinds(h)).toEqual(Array<string>(6).fill('placeholder'));
    expect(cellPlaceholders(h)).toBe(2);
    // Setup summaries render from routing state alone.
    expect(
      squash(h.host.querySelector('[data-stage="band"] [data-testid="stage-setup"]')?.textContent),
    ).toBe('Strong to unset · Cheap to unset');
    await flipCascade(h);
    expect(fake.calls).toContain('setAutoLayers');

    pending[0]!.resolve(DEFAULT_AUTO_PERF);
    await flush();
    expect(q(h.host, 'auto-loading')).toBeNull();
    expect(figureKinds(h)).toEqual(Array<string>(6).fill('count'));
    expect(squash(q(h.host, 'stage-figure')?.textContent)).toBe('40 evaluated');
    expect(q(h.host, 'exit-bar')).not.toBeNull();
    expect(q(classify, 'ap-band-verdicts')).not.toBeNull();
    expect(targets(h).textContent).toContain('(1 unroutable in the selected 7d range)');
    expect(detectedKinds(h)).toEqual(Array<string>(6).fill('value'));
    expect(detectedText(h, 'any')).toBe('40 evaluated');
    expect(cellPlaceholders(h)).toBe(0);
  });

  it('a same-range refetch keeps the figures it replaces; a range change shows placeholders', async () => {
    const fake = new FakeApiClient();
    const pending = deferAggregation(fake);
    h = await mount(fake);
    await openAutoTab(h.host);
    pending[0]!.resolve(DEFAULT_AUTO_PERF);
    await flush();
    expect(squash(q(h.host, 'stage-figure')?.textContent)).toBe('40 evaluated');

    // Same range, still in flight: the prior figures stay until the new ones commit.
    void h.store.loadAutoPerf();
    await flush();
    expect(pending).toHaveLength(2);
    expect(squash(q(h.host, 'stage-figure')?.textContent)).toBe('40 evaluated');
    pending[1]!.resolve({ ...DEFAULT_AUTO_PERF, evaluated: 41 });
    await flush();
    expect(squash(q(h.host, 'stage-figure')?.textContent)).toBe('41 evaluated');

    // A new range never shows the old range's figures under its label.
    [...h.host.querySelectorAll<HTMLButtonElement>('[data-testid="auto-range"] button')]
      .find((b) => b.textContent?.trim() === '30d')!
      .click();
    await flush();
    expect(h.store.state.autoPerf.range).toBe('30d');
    expect(figureKinds(h)).toEqual(Array<string>(6).fill('placeholder'));
    expect(q(h.host, 'auto-loading')).not.toBeNull();
  });
});

describe('failure: a notice and a Retry, and no figure from an earlier load', () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.dispose();
    h = null;
  });

  it('withholds every figure the store still holds, keeps configuration operable, and retries', async () => {
    const fake = new FakeApiClient();
    h = await mount(fake);
    await openAutoTab(h.host);
    expect(squash(q(h.host, 'stage-figure')?.textContent)).toBe('40 evaluated');

    // A later refetch fails. The store keeps the earlier data — the trap.
    fake.analyticsFailure = new ApiError(504, 'Gateway Timeout', 'the analytics query timed out');
    await h.store.loadAutoPerf();
    await flush();
    expect(h.store.state.autoPerf.data?.evaluated).toBe(40);
    expect(h.store.state.autoPerf.error).not.toBeNull();

    const notice = q(h.host, 'auto-load-error')!;
    expect(notice.textContent).toContain('Couldn’t load auto performance');
    expect(notice.textContent).toContain('the analytics query timed out');
    expect(notice.textContent).toContain('Routing is unaffected');
    // Nothing from the earlier load is presented as current — anywhere on the tab.
    expect(figureKinds(h)).toEqual(Array<string>(6).fill('unavailable'));
    expect(q(h.host, 'exit-bar')).toBeNull();
    expect(q(h.host, 'auto-savings')).toBeNull();
    expect(h.host.textContent).not.toContain('$1.6200');
    for (const stage of ['Classify', 'Workload claim', 'Default'] as const) {
      const detail = await expandStage(h.host, stage);
      expect(q(detail, 'detail-failed'), `${stage} says its figures failed`).not.toBeNull();
    }
    for (const id of ['ap-band-verdicts', 'calibration-evidence', 'workload-mix', 'ap-default']) {
      expect(q(h.host, id), `${id} rendered a stale figure`).toBeNull();
    }
    expect(targets(h).textContent).not.toContain('unroutable in the selected');
    expect(q(targets(h), 'wt-routed')).toBeNull();
    // No Detected figure either — and no placeholder pretending one is on its way.
    expect(detectedKinds(h)).toEqual(Array<string>(6).fill('none'));
    expect(detectedText(h, 'any')).toContain('unavailable');
    expect(detectedText(h, 'any')).not.toMatch(/\d/); // the store still holds 40
    expect(cellPlaceholders(h)).toBe(0);
    // Configuration never waited on the aggregation, and does not now.
    expect(h.host.querySelector('[aria-label="Self-calibration"]')).not.toBeNull();
    await flipCascade(h);
    expect(fake.calls).toContain('setAutoLayers');

    // Retry refetches for the selected range, and the figures return.
    const fetches = fake.calls.filter((c) => c === 'autoPerformance').length;
    fake.analyticsFailure = null;
    const retry = [...notice.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'Retry',
    )!;
    retry.focus();
    retry.click();
    await flush();
    expect(fake.calls.filter((c) => c === 'autoPerformance').length).toBe(fetches + 1);
    expect(q(h.host, 'auto-load-error')).toBeNull();
    // The pressed button unmounted with the notice; focus lands on the summary it
    // belonged to, never on <body> (where the next Tab would restart the page).
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(q(h.host, 'auto-summary'));
    expect(figureKinds(h)).toEqual(Array<string>(6).fill('count'));
    expect(q(h.host, 'exit-bar')).not.toBeNull();
    expect(q(h.host, 'ap-band-verdicts')).not.toBeNull();
    expect(targets(h).textContent).toContain('(1 unroutable in the selected 7d range)');
    expect(detectedKinds(h)).toEqual(Array<string>(6).fill('value'));
    expect(q(targets(h), 'wt-routed')).not.toBeNull();
  });
});

describe('zero: stated, not drawn as zeros', () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.dispose();
    h = null;
  });

  const ZERO: AutoPerformance = {
    ...DEFAULT_AUTO_PERF,
    evaluated: 0,
    bands: {
      high: { requests: 0, declared: 0, unroutable: 0 },
      low: { requests: 0, declared: 0, unroutable: 0 },
      ambiguous: { requests: 0 },
    },
    cascade: {
      requests: 0,
      qualityPassed: 0,
      qualityUnknown: 0,
      failedOrCancelled: 0,
      escalated: 0,
    },
    semantic: {
      evaluated: 0,
      routed: { high: 0, low: 0 },
      outcomes: { success: 0, fallback: 0, error: 0, cancelled: 0 },
      source: { bundled: 0, learned: 0 },
    },
    fallthrough: 0,
    exits: { workload: 0, structural: 0, semantic: 0, cascade: 0, default: 0 },
    series: [],
    savings: null,
    signalQuality: [],
    workloadMix: {
      evaluated: 0,
      unclassified: 0,
      since: '2026-07-10T00:00:00.000Z',
      revisions: [],
      classes: [
        {
          class: 'code',
          requests: 0,
          unpricedRequests: 0,
          unpricedAttempts: 0,
          spendUsd: 0.25,
          routed: 0,
        },
      ],
    },
  };

  it('distinguishes an empty range from no telemetry, draws no bar, and reads shares as "—"', async () => {
    h = await mount(new FakeApiClient({ autoPerf: ZERO }));
    await openAutoTab(h.host);
    expect(q(h.host, 'auto-zero')?.textContent).toContain(
      'No evaluated telemetry in this range — telemetry begins',
    );
    expect(q(h.host, 'exit-bar')).toBeNull();
    expect(
      [...h.host.querySelectorAll<HTMLElement>('[data-testid="stage-figure"]')].map((e) =>
        squash(e.textContent),
      ),
    ).toEqual([
      '0 evaluated',
      '0 — · routed here',
      '0 — · routed here',
      '0 — · routed here',
      '0 — · routed here',
      '0 — · routed here',
    ]);
    // A null savings aggregation renders no savings content — never a fabricated $0.
    expect(q(h.host, 'auto-savings')).toBeNull();
    // Once loaded, the matrix's Detected cells read zero — for an absent class too.
    expect(detectedText(h, 'any')).toBe('0 evaluated');
    expect(detectedText(h, 'code')).toBe('0 detected · 0 routed');
    expect(detectedText(h, 'vision')).toBe('0 detected · 0 routed');
    expect(h.host.textContent).not.toContain('NaN');
    // The Workload claim stage still renders attempt-only classes, with their zero
    // share and their spend.
    const claim = await expandStage(h.host, 'Workload claim');
    expect(q(claim, 'workload-mix-attempt-only')).not.toBeNull();
    const row = q(claim, 'workload-row')!;
    expect(row.textContent).toContain('0%');
    expect(row.textContent).toContain('$0.25');
    // Classify says why it has no verdicts rather than drawing zero shares.
    const classify = await expandStage(h.host, 'Classify');
    expect(q(classify, 'ap-band-verdicts')?.textContent).toContain(
      'No evaluated telemetry in this range',
    );
    // Default states its zero too, rather than drawing three bare zeros.
    const fallback = await expandStage(h.host, 'Default');
    expect(q(fallback, 'ap-default')?.textContent).toContain(
      'No evaluated telemetry in this range',
    );
    expect(q(fallback, 'default-fallthrough')).toBeNull();
    expect(h.host.textContent).not.toContain('NaN');
    h.dispose();

    h = await mount(new FakeApiClient({ autoPerf: { ...ZERO, telemetrySince: null } }));
    await openAutoTab(h.host);
    expect(q(h.host, 'auto-zero')?.textContent).toContain('No auto telemetry yet');
  });

  it('a loaded range where nothing fell to default still shows its total of 0', async () => {
    const clean: AutoPerformance = {
      ...DEFAULT_AUTO_PERF,
      bands: {
        ...DEFAULT_AUTO_PERF.bands,
        high: { ...DEFAULT_AUTO_PERF.bands.high, unroutable: 0 },
        low: { ...DEFAULT_AUTO_PERF.bands.low, unroutable: 0 },
      },
      fallthrough: 0,
      exits: {
        workload: 0,
        structural: 25,
        semantic: 5,
        cascade: 10,
        default: 0,
      },
    };
    h = await mount(new FakeApiClient({ autoPerf: clean }));
    await openAutoTab(h.host);
    const fallback = await expandStage(h.host, 'Default');
    // A total of 0 is a figure, not an absence: it must not vanish on a falsy check.
    expect(squash(q(fallback, 'ap-default')?.textContent)).toContain(
      'routed to the default tier 0',
    );
  });
});

describe('the focal savings figure follows its honesty rules', () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.dispose();
    h = null;
  });

  const savings = (over: Partial<NonNullable<AutoPerformance['savings']>>): AutoPerformance => ({
    ...DEFAULT_AUTO_PERF,
    savings: { ...DEFAULT_AUTO_PERF.savings!, ...over },
  });

  it('a negative net is a caution naming the excess, still scoped to the residual cascade', async () => {
    h = await mount(new FakeApiClient({ autoPerf: savings({ netUsd: -0.5, excessUsd: 0.5 }) }));
    await openAutoTab(h.host);
    const sv = q(h.host, 'auto-savings')!;
    expect(sv.textContent).toContain('cheap routing cost $0.5000 MORE than premium would have');
    expect(sv.querySelector('.ar-focal-figure')).toBeNull(); // never the accent figure
    expect(sv.textContent).toContain('residual cascade');
  });

  it('an all-uncostable population keeps the coverage and shows no money', async () => {
    h = await mount(
      new FakeApiClient({ autoPerf: savings({ netUsd: null, rows: 0, uncostedRows: 3 }) }),
    );
    await openAutoTab(h.host);
    const sv = q(h.host, 'auto-savings')!;
    expect(sv.textContent).toContain('savings unavailable');
    expect(sv.textContent).toContain('based on 0 of 3 quality-passed requests');
    expect(sv.textContent).not.toMatch(/\$\d/);
  });

  it('an older server with no exits reads the stage counts as unavailable, never zero', async () => {
    const legacy: AutoPerformance = { ...DEFAULT_AUTO_PERF };
    delete legacy.exits;
    h = await mount(new FakeApiClient({ autoPerf: legacy }));
    await openAutoTab(h.host);
    expect(figureKinds(h)).toEqual(['count', ...Array<string>(5).fill('unavailable')]);
    expect(q(h.host, 'exit-bar')).toBeNull();
    expect(q(h.host, 'auto-summary')?.textContent).toContain('Per-stage counts are unavailable');
    // Every other figure still renders.
    expect(q(h.host, 'auto-savings')).not.toBeNull();
  });
});
