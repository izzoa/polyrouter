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
import { cellText, expandStage, openAutoTab } from './test/routingTabs';

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
/** The matrix holds no range-scoped figure in ANY state (split-auto-routing-readout-setup
 * D9): no Detected column, no unroutable note, no routed count, and so no placeholder for
 * one — the counts are the Pipeline's. Asserted against a store that may hold real data. */
const expectMatrixFigureFree = (h: Harness): void => {
  const m = targets(h);
  expect(m.querySelector('[data-testid="targets-detected"]')).toBeNull();
  expect(m.querySelector('[data-testid="wt-routed"]')).toBeNull();
  expect(m.querySelector('[data-testid="cell-unroutable"]')).toBeNull();
  expect(m.querySelectorAll('.ar-skel')).toHaveLength(0);
  expect(m.textContent).not.toContain('unroutable in the selected');
  expect(m.textContent).not.toContain('Detected');
};
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
    expect(figureKinds(h)).toEqual(Array<string>(6).fill('placeholder'));
    // The Cascade row's savings line waits as a placeholder — never a figure.
    expect(q(h.host, 'auto-savings')).toBeNull();
    expect(q(h.host, 'savings-loading')).not.toBeNull();
    // No range-wide notice while loading: every row shows its own placeholder.
    for (const id of ['auto-load-error', 'auto-zero', 'auto-unavailable'])
      expect(q(h.host, id)).toBeNull();
    // The unroutable alert may not appear, so it reserves no space: absent, no placeholder.
    expect(q(h.host, 'band-alert')).toBeNull();
    expect(h.host.querySelector('[data-stage="band"] .ar-later')).toBeNull();
    // A detail's figures wait too — once, as a placeholder…
    const classify = await expandStage(h.host, 'Classify');
    expect(q(classify, 'detail-loading')).not.toBeNull();
    expect(q(classify, 'ap-band-verdicts')).toBeNull();
    // …while the configuration is already there: its tuning entry, in Setup.
    expect(q(h.host, 'tuning-entry')?.dataset['tuning']).toBe('calibration');
    // The targets never wait, and carry no figure that could.
    expect(targets(h).querySelector<HTMLSelectElement>('select')?.disabled).toBe(false);
    expectMatrixFigureFree(h);
    // Status-now phrases render from routing state alone.
    expect(
      cellText(h.host.querySelector('[data-stage="band"] [data-testid="stage-status-now"]')),
    ).toBe('Strong to not set · Cheap to not set For requests no claim took');
    // The row bars and Classify's verdicts wait as placeholders too — never a zero.
    expect(h.host.querySelectorAll('[data-testid="stage-bar"]')).toHaveLength(0);
    expect(h.host.querySelectorAll('.ar-figbar .ar-skel')).toHaveLength(5);
    expect(
      h.host.querySelector('[data-stage="classify"] [data-testid="stage-verdicts"]'),
    ).toBeNull();
    expect(h.host.querySelector('[data-stage="classify"] .ar-figline .ar-skel')).not.toBeNull();
    await flipCascade(h);
    expect(fake.calls).toContain('setAutoLayers');

    pending[0]!.resolve(DEFAULT_AUTO_PERF);
    await flush();
    expect(q(h.host, 'savings-loading')).toBeNull();
    expect(figureKinds(h)).toEqual(Array<string>(6).fill('count'));
    expect(cellText(q(h.host, 'stage-figure'))).toMatch(/^40 evaluated/);
    expect(h.host.querySelectorAll('[data-testid="stage-bar"]')).toHaveLength(5);
    expect(q(classify, 'ap-band-verdicts')).not.toBeNull();
    // Loaded, the matrix still shows no count — the unroutable one is the Pipeline's.
    expectMatrixFigureFree(h);
    expect(q(h.host, 'band-alert')?.textContent).toContain(
      '1 confident high verdict had no usable Strong target',
    );
  });

  it('a same-range refetch keeps the figures it replaces; a range change shows placeholders', async () => {
    const fake = new FakeApiClient();
    const pending = deferAggregation(fake);
    h = await mount(fake);
    await openAutoTab(h.host);
    pending[0]!.resolve(DEFAULT_AUTO_PERF);
    await flush();
    expect(cellText(q(h.host, 'stage-figure'))).toMatch(/^40 evaluated/);

    // Same range, still in flight: the prior figures stay until the new ones commit.
    void h.store.loadAutoPerf();
    await flush();
    expect(pending).toHaveLength(2);
    expect(cellText(q(h.host, 'stage-figure'))).toMatch(/^40 evaluated/);
    pending[1]!.resolve({ ...DEFAULT_AUTO_PERF, evaluated: 41 });
    await flush();
    expect(cellText(q(h.host, 'stage-figure'))).toMatch(/^41 evaluated/);

    // A new range never shows the old range's figures under its label.
    [...h.host.querySelectorAll<HTMLButtonElement>('[data-testid="auto-range"] button')]
      .find((b) => b.textContent?.trim() === '30d')!
      .click();
    await flush();
    expect(h.store.state.autoPerf.range).toBe('30d');
    expect(figureKinds(h)).toEqual(Array<string>(6).fill('placeholder'));
    expect(q(h.host, 'savings-loading')).not.toBeNull();
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
    expect(cellText(q(h.host, 'stage-figure'))).toMatch(/^40 evaluated/);

    // A later refetch fails. The store keeps the earlier data — the trap.
    fake.analyticsFailure = new ApiError(504, 'Gateway Timeout', 'the analytics query timed out');
    await h.store.loadAutoPerf();
    await flush();
    expect(h.store.state.autoPerf.data?.evaluated).toBe(40);
    expect(h.store.state.autoPerf.error).not.toBeNull();

    const notice = q(h.host, 'auto-load-error')!;
    expect(notice.textContent).toContain('Couldn’t load the Pipeline’s figures');
    expect(notice.textContent).toContain('the analytics query timed out');
    expect(notice.textContent).toContain('Routing is unaffected');
    // Nothing from the earlier load is presented as current — anywhere on the tab.
    expect(figureKinds(h)).toEqual(Array<string>(6).fill('unavailable'));
    expect(h.host.querySelectorAll('[data-testid="stage-bar"]')).toHaveLength(0);
    expect(q(h.host, 'auto-savings')).toBeNull();
    expect(h.host.textContent).not.toContain('$1.62');
    for (const stage of ['Classify', 'Workload claim', 'Default'] as const) {
      const detail = await expandStage(h.host, stage);
      expect(q(detail, 'detail-failed'), `${stage} says its figures failed`).not.toBeNull();
    }
    for (const id of ['ap-band-verdicts', 'calibration-evidence', 'workload-mix', 'ap-default']) {
      expect(q(h.host, id), `${id} rendered a stale figure`).toBeNull();
    }
    // No matrix figure either — and no placeholder pretending one is on its way.
    expectMatrixFigureFree(h);
    // The alert is a figure too: absent, never stale.
    expect(q(h.host, 'band-alert')).toBeNull();
    // Configuration never waited on the aggregation, and does not now.
    expect(q(h.host, 'tuning-entry')?.dataset['tuning']).toBe('calibration');
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
    // The pressed button unmounted with the notice; focus lands on the Pipeline panel it
    // belonged to, never on <body> (where the next Tab would restart the page).
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(q(h.host, 'auto-pipeline'));
    expect(figureKinds(h)).toEqual(Array<string>(6).fill('count'));
    expect(h.host.querySelectorAll('[data-testid="stage-bar"]')).toHaveLength(5);
    expect(q(h.host, 'ap-band-verdicts')).not.toBeNull();
    expectMatrixFigureFree(h);
    expect(q(h.host, 'band-alert')).not.toBeNull();
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
    expect(
      [...h.host.querySelectorAll<HTMLElement>('[data-testid="stage-figure"]')].map((e) =>
        cellText(e),
      ),
    ).toEqual([
      '0 evaluated verdicts: 0 high · 0 low · 0 ambiguous',
      '0 — routed here',
      // The default fake sets no band target and has L2 unavailable: history captions.
      '0 — routed under earlier targets',
      '0 — routed while on',
      '0 — routed while it could run',
      '0 — routed here',
    ]);
    // No bar track renders in a zero range.
    expect(h.host.querySelectorAll('[data-testid="stage-bar"]')).toHaveLength(0);
    // A null savings aggregation renders no savings content — never a fabricated $0.
    expect(q(h.host, 'auto-savings')).toBeNull();
    // The matrix carries no count at zero either; the Workload claim detail does.
    expectMatrixFigureFree(h);
    // Nothing fell through, so there is no alert to raise.
    expect(q(h.host, 'band-alert')).toBeNull();
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

  it('a loaded range where nothing fell to default still shows its zeros', async () => {
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
    // A 0 is a figure, not an absence: it must not vanish on a falsy check.
    const text = squash(q(fallback, 'ap-default')?.textContent);
    expect(text).toContain('confident high, no usable Strong target 0');
    expect(text).toContain('ambiguous, no later stage took it 0');
    expect(
      cellText(h.host.querySelector('[data-stage="default"] [data-testid="stage-figure"]')),
    ).toMatch(/^0 /);
  });
});

describe('the Cascade row’s savings line follows its honesty rules', () => {
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
    expect(sv.textContent).toContain('cheap routing cost $0.50 MORE than premium would have');
    expect(sv.querySelector('.ar-savings-amount')).toBeNull(); // the caution replaces it
    expect(sv.textContent).toContain('residual cascade');
  });

  it('shows cents from $0.01, four decimals below, and never a non-zero amount as zero', async () => {
    for (const [netUsd, shown] of [
      [1.62, '$1.62'],
      [0.004, '$0.0040'],
      [0.00004, '< $0.0001'],
    ] as const) {
      h = await mount(new FakeApiClient({ autoPerf: savings({ netUsd }) }));
      await openAutoTab(h.host);
      expect(q(h.host, 'auto-savings')!.querySelector('.ar-savings-amount')?.textContent).toBe(
        shown,
      );
      expect(q(h.host, 'auto-savings')!.textContent).not.toContain('$0.00 ');
      h.dispose();
      h = null;
    }
  });

  it('a small negative net keeps its sign as a caution, at the same precision', async () => {
    h = await mount(new FakeApiClient({ autoPerf: savings({ netUsd: -0.003, excessUsd: 0.003 }) }));
    await openAutoTab(h.host);
    expect(q(h.host, 'auto-savings')!.textContent).toContain(
      'cheap routing cost $0.0030 MORE than premium would have',
    );
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
    expect(h.host.querySelectorAll('[data-testid="stage-bar"]')).toHaveLength(0);
    expect(q(h.host, 'auto-unavailable')?.textContent).toContain(
      'Per-stage counts are unavailable',
    );
    // It sits above the column header, inside the Pipeline.
    const pipe = q(h.host, 'auto-pipeline')!;
    const notice = q(h.host, 'auto-unavailable')!;
    expect(pipe.contains(notice)).toBe(true);
    expect(
      notice.compareDocumentPosition(pipe.querySelector('.ar-colhead')!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Every other figure still renders.
    expect(q(h.host, 'auto-savings')).not.toBeNull();
  });
});

describe('Setup never waits on figures (split-auto-routing-readout-setup 3.1)', () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.dispose();
    h = null;
  });

  const layerSwitches = (root: HTMLElement): HTMLButtonElement[] => [
    ...root.querySelectorAll<HTMLButtonElement>('[data-testid="auto-layers"] [role="switch"]'),
  ];

  it('the three layer switches are operable while the aggregation is loading', async () => {
    const fake = new FakeApiClient();
    deferAggregation(fake);
    h = await mount(fake);
    await openAutoTab(h.host);
    expect(figureKinds(h)).toEqual(Array<string>(6).fill('placeholder'));
    expect(layerSwitches(h.host)).toHaveLength(3);
    expect(q(h.host, 'auto-setup')?.querySelector('.ar-skel')).toBeNull();
    await flipCascade(h);
    expect(fake.calls).toContain('setAutoLayers');
  });

  it('the three layer switches are operable after the aggregation failed', async () => {
    const fake = new FakeApiClient();
    const pending = deferAggregation(fake);
    h = await mount(fake);
    await openAutoTab(h.host);
    pending[0]!.reject(new ApiError(503, 'unavailable', 'boom'));
    await flush();
    expect(q(h.host, 'auto-load-error')).not.toBeNull();
    expect(layerSwitches(h.host)).toHaveLength(3);
    // The available layers stay live (the default fake's L2 is unavailable instance-wide).
    for (const label of ['Toggle L1 · Structural', 'Toggle L3 · Cascade'])
      expect(
        h.host.querySelector(`[aria-label="${label}"]`)?.getAttribute('aria-disabled'),
      ).toBeNull();
    await flipCascade(h);
    expect(fake.calls).toContain('setAutoLayers');
  });
});
