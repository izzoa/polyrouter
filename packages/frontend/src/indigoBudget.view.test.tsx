/**
 * The Indigo Budget on screen (adopt-design-tokens-v2 tasks 7.2 and 7.3; design.md D11;
 * dashboard-core "Indigo is spent by a per-view budget").
 *
 * happy-dom draws nothing, so this file holds what the markup can prove — each page offers
 * at most one primary, each data series declares whether it is focal (and which measure) or
 * neutral, and the marks the budget forbids (running dots, the setup ring) are neutral. What
 * the browser renders — no other element computing the raw accent, one focal measure per
 * view, every overlay too, in both themes — is `browser/indigoBudget.spec.ts`.
 *
 * uPlot is mocked here, as in `Chart.series.test.tsx`, so a chart's series configuration can
 * be read: a canvas has no computed style, so the budget card's spend line and ceiling are
 * held by what the chart is told to draw.
 */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type uPlot from 'uplot';
import { App } from './App';
import type { BatchJobDto, BudgetDto } from './data/api';
import { createAppStore, DOCK_QUERY, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';
import type { Page } from './types';

const plots = vi.hoisted(() => [] as { options: uPlot.Options; root: HTMLElement }[]);
vi.mock('uplot', () => ({
  default: class {
    static tzDate(date: Date) {
      return date;
    }
    constructor(options: uPlot.Options, _data: unknown, root: HTMLElement) {
      const item = { options, root, setData: vi.fn(), setSize: vi.fn(), destroy: vi.fn() };
      plots.push(item);
      return item;
    }
  },
}));

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

interface Mounted {
  host: HTMLElement;
  store: AppStore;
  dispose: () => void;
}

async function mount(client = new FakeApiClient()): Promise<Mounted> {
  const store = createAppStore(client);
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
  return {
    host,
    store,
    dispose: () => {
      dispose();
      host.remove();
    },
  };
}

afterEach(() => {
  plots.length = 0;
  document.body.innerHTML = '';
  localStorage.clear();
});

const BUDGET: BudgetDto = {
  id: 'b-1',
  name: 'Daily cap',
  scope: 'global',
  agentId: null,
  amount: 25,
  window: 'day',
  action: 'alert',
  meteringBasis: 'cash',
  enabled: true,
  notifyChannelIds: [],
  createdAt: '2026-10-08T00:00:00.000Z',
};

const job = (id: string, status: string): BatchJobDto => ({
  id,
  upstreamBatchId: `up-${id}`,
  status,
  terminal: false,
  endpoint: '/v1/chat/completions',
  agentId: 'ag',
  providerId: 'p1',
  providerLabel: 'OpenRouter',
  modelId: 'm1',
  modelLabel: `model-${id}`,
  tierAssigned: 'nightly',
  counts: { total: 50, completed: 12, failed: 0 },
  submittedAt: new Date(Date.now() - 3_600_000).toISOString(),
  updatedAt: new Date().toISOString(),
  terminalAt: null,
  reservedCeilingMicros: 25_000,
  settledCostMicros: null,
  resultsExpireAt: null,
  errorKind: null,
});

/** A fixture with something on every page: a budget card, batch jobs, an agent, a provider. */
const busyClient = (): FakeApiClient =>
  new FakeApiClient({
    budgets: [BUDGET],
    batchJobs: [job('run', 'in_progress'), job('queued', 'validating')],
  });

const primaries = (root: ParentNode): string[] =>
  [...root.querySelectorAll<HTMLElement>('.btn-primary')].map((b) =>
    (b.getAttribute('aria-label') ?? b.textContent ?? '').trim(),
  );
function atMostOnePrimary(root: ParentNode, view: string): void {
  const found = primaries(root);
  expect(
    found.length,
    `${view} offers ${found.length} primaries: ${found.join(', ')}`,
  ).toBeLessThanOrEqual(1);
}

describe('each page offers at most one indigo-filled control (D11 page rule)', () => {
  const PAGES: readonly Page[] = [
    'overview',
    'requests',
    'batches',
    'costs',
    'agents',
    'providers',
    'routing',
    'limits',
    'settings',
    'users',
  ];

  for (const page of PAGES) {
    it(`${page}: at most one .btn-primary with no overlay open`, async () => {
      const h = await mount(busyClient());
      try {
        h.store.go(page);
        await flush();
        expect(h.store.state.modal, 'no overlay is open').toBeNull();
        atMostOnePrimary(h.host, `${page} primaries`);
        if (page === 'routing') {
          h.store.setRoutingSection('auto');
          await flush();
          atMostOnePrimary(h.host, 'routing / auto primaries');
        }
      } finally {
        h.dispose();
      }
    });
  }

  it('setup: at most one .btn-primary on each step', async () => {
    const h = await mount();
    try {
      h.store.go('setup');
      for (const step of [1, 2, 3] as const) {
        h.store.obGo(step);
        await flush();
        // Each step offers its one committed action as the primary, and nothing else.
        expect(primaries(h.host), `setup step ${String(step)}`).toHaveLength(1);
      }
    } finally {
      h.dispose();
    }
  });

  it('a checked native checkbox is a state mark, not a filled control: it is never a .btn-primary', async () => {
    const h = await mount(busyClient());
    try {
      h.store.go('limits');
      await flush();
      h.store.openBudget();
      await flush();
      for (const box of h.host.querySelectorAll('input[type="checkbox"], input[type="radio"]'))
        expect(box.classList.contains('btn-primary')).toBe(false);
    } finally {
      h.dispose();
    }
  });
});

describe('every data series declares its role (task 7.3)', () => {
  const roots = (root: ParentNode): { series: string; measure: string | null }[] =>
    [...root.querySelectorAll<HTMLElement>('[data-series]')].map((e) => ({
      series: e.dataset['series'] ?? '',
      measure: e.dataset['measure'] ?? null,
    }));
  const focalMeasures = (root: ParentNode): string[] => [
    ...new Set(
      roots(root)
        .filter((r) => r.series === 'focal')
        .map((r) => r.measure ?? '(unnamed)'),
    ),
  ];

  it('Overview: the requests chart is focal; the spend-by-model bars are neutral', async () => {
    const h = await mount();
    try {
      expect(focalMeasures(h.host)).toEqual(['requests']);
      expect(roots(h.host).filter((r) => r.series === 'neutral').length).toBeGreaterThan(0);
    } finally {
      h.dispose();
    }
  });

  it('Costs: the request mix (bar and legend) is focal; the breakdown bars are neutral', async () => {
    const h = await mount();
    try {
      h.store.go('costs');
      await flush();
      expect(focalMeasures(h.host)).toEqual(['request-mix']);
      const mix = h.host.querySelectorAll('[data-series="focal"][data-measure="request-mix"]');
      expect(mix.length, 'the bar and its legend').toBe(2);
      expect(roots(h.host).filter((r) => r.series === 'neutral').length).toBeGreaterThan(0);
    } finally {
      h.dispose();
    }
  });

  it('Batches: each progress fill is the one focal measure, repeated per row', async () => {
    const h = await mount(busyClient());
    try {
      h.store.go('batches');
      await flush();
      expect(focalMeasures(h.host)).toEqual(['batch-progress']);
      expect(h.host.querySelectorAll('.rs-batch-bar[data-series="focal"]').length).toBe(2);
    } finally {
      h.dispose();
    }
  });

  it('Routing / Auto routing: the Pipeline bars are focal; the band chart is neutral', async () => {
    const h = await mount();
    try {
      h.store.go('routing');
      await flush();
      h.store.setRoutingSection('auto');
      await flush();
      await flush();
      // Every stage detail open: the band chart lives in the Classify stage's detail.
      for (const ex of h.host.querySelectorAll<HTMLButtonElement>(
        'button.ar-expander[aria-expanded="false"]',
      ))
        ex.click();
      await flush();
      // One measure, repeated per stage.
      expect(focalMeasures(h.host)).toEqual(['pipeline']);
      expect(
        h.host.querySelectorAll('[data-testid="stage-bar"][data-series="focal"]').length,
      ).toBeGreaterThan(1);
      // The charts still on the page (Overview's, built at mount, has left with its page).
      const onPage = plots.filter((p) => p.root.isConnected);
      expect(onPage.length, 'the band chart was built').toBeGreaterThan(0);
      for (const band of onPage) {
        expect(band.root.dataset['series']).toBe('neutral');
        expect(band.root.dataset['measure']).toBeUndefined();
        expect(JSON.stringify(band.options.series)).not.toContain('#4f5dff');
      }
    } finally {
      h.dispose();
    }
  });

  it("Inspector: the route trace's lit branch is the one focal measure, on a served row only (add-route-trace-inspector 4.2)", async () => {
    const h = await mount();
    try {
      h.store.go('requests');
      await flush();
      const rows = h.store.state.requestList;
      const served = rows.find((r) => r.status === 'success');
      const failed = rows.find((r) => r.status === 'error');
      expect(served, 'the fixture has a served row').toBeDefined();
      expect(failed, 'the fixture has an error row').toBeDefined();
      for (const [row, want] of [
        [served!, ['route-trace']],
        [failed!, []],
      ] as const) {
        h.store.select(row.id);
        await flush();
        const drawer = h.host.querySelector('#inspector-drawer');
        expect(drawer, `the inspector opened on ${row.id}`).not.toBeNull();
        expect(focalMeasures(drawer!), `${row.status}: focal measures`).toEqual(want);
        // The root is the served outcome node itself, so nothing else in the drawer is focal.
        for (const f of drawer!.querySelectorAll<HTMLElement>('[data-series="focal"]')) {
          expect(f.tagName).toBe('LI');
          expect(f.classList.contains('rt-node--lit')).toBe(true);
        }
        h.store.select(null);
        await flush();
      }
    } finally {
      h.dispose();
    }
  });

  it('Requests, docked: the page and the docked panel are ONE view — one focal series (the lit branch) and at most one primary across both (add-docked-inspector 6.4, D16)', async () => {
    // At the dock threshold the inspector is part of the board, not a layer above it, so the
    // budget counts the list and the panel together. The matchMedia stand-in matches only the
    // dock query, so the inspector docks; every other query keeps happy-dom's answer.
    const real = globalThis.matchMedia.bind(globalThis);
    vi.stubGlobal('matchMedia', (q: string) =>
      q === DOCK_QUERY
        ? {
            matches: true,
            media: q,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
          }
        : real(q),
    );
    const h = await mount(busyClient());
    try {
      h.store.go('requests');
      await flush();
      // The live job band too, so the busiest Requests view is counted.
      await h.store.loadBatchBand();
      await flush();
      const served = h.store.state.requestList.find((r) => r.status === 'success')!;
      const row = [...h.host.querySelectorAll<HTMLElement>('button.req-row')].find(
        (r) => r.dataset['requestId'] === served.id,
      )!;
      row.focus();
      row.click();
      await flush();
      const drawer = h.host.querySelector<HTMLElement>('#inspector-drawer')!;
      expect(drawer.getAttribute('role'), 'the inspector docked').toBe('complementary');
      expect(h.host.querySelector('[data-pane="content"]')?.classList.contains('rs-docked')).toBe(
        true,
      );
      expect(
        h.host.querySelector('.overlay'),
        'no scrim: the page beside it is in view',
      ).toBeNull();
      // One view: the page and the panel counted together.
      atMostOnePrimary(h.host, 'Requests + docked inspector');
      expect(focalMeasures(h.host), 'one indigo series across the page and the panel').toEqual([
        'route-trace',
      ]);
      const focal = [...h.host.querySelectorAll<HTMLElement>('[data-series="focal"]')];
      expect(focal, 'the lit branch is the only focal root').toHaveLength(1);
      expect(drawer.contains(focal[0]!)).toBe(true);
      // The state marks are present and are not counted: the open row's Selected state, and
      // the focus that stays on it (docked, opening moves no focus).
      expect(row.getAttribute('aria-expanded'), 'the open row has its Selected state').toBe('true');
      expect(document.activeElement, 'the focus ring is on the row').toBe(row);
      expect(row.classList.contains('btn-primary')).toBe(false);
      expect(row.hasAttribute('data-series')).toBe(false);
    } finally {
      h.dispose();
      vi.unstubAllGlobals();
    }
  });

  it('Limits: the budget card keeps the accent spend line and the neutral dashed ceiling', async () => {
    const h = await mount(busyClient());
    try {
      h.store.go('limits');
      await flush();
      await flush();
      expect(h.host.querySelector('.budget-card'), 'a budget card rendered').not.toBeNull();
      expect(focalMeasures(h.host)).toEqual(['budget-spend']);
      const card = plots.find((p) => p.root.dataset['measure'] === 'budget-spend');
      expect(card, 'the budget chart was built').toBeDefined();
      const [, spend, ceiling] = card!.options.series;
      // happy-dom resolves no CSS variable, so Chart.tsx's documented fallbacks show through.
      expect(spend?.stroke, 'the spend line is the accent').toBe('#4f5dff');
      expect(spend?.dash).toBeUndefined();
      expect(ceiling?.stroke, 'the ceiling is Ink 3, never the accent').toBe('#6a6c73');
      expect(ceiling?.dash, 'the ceiling is dashed').toEqual([5, 4]);
      expect(ceiling?.fill).toBeUndefined();
    } finally {
      h.dispose();
    }
  });
});

describe('the marks the budget forbids are neutral (task 7.2)', () => {
  it('the sidebar setup ring is an Ink arc on its hairline track', async () => {
    const h = await mount();
    try {
      const ring = h.host.querySelector('button.setup-card svg');
      expect(ring, 'the setup card shows its ring').not.toBeNull();
      expect(ring!.querySelector('circle')?.getAttribute('stroke')).toBe('var(--border)');
      expect(ring!.querySelector('path')?.getAttribute('stroke')).toBe('var(--text)');
    } finally {
      h.dispose();
    }
  });

  it("the Batches page's running and queued dots are Ink 3", async () => {
    const h = await mount(busyClient());
    try {
      h.store.go('batches');
      await flush();
      const rowDots = [...h.host.querySelectorAll<HTMLElement>('.rs-batch-row')].map((r) =>
        r.querySelector<HTMLElement>('[aria-hidden="true"][style*="border-radius"]'),
      );
      expect(rowDots.length, 'a dot per job').toBe(2);
      for (const d of rowDots) {
        expect(d, 'the status dot').not.toBeNull();
        expect(d!.style.background).toBe('var(--text3)');
        expect(d!.getAttribute('style')).not.toMatch(/--accent/);
      }
    } finally {
      h.dispose();
    }
  });

  it('the brand mark keeps its lit route: it is identity, not spend', async () => {
    const h = await mount();
    try {
      const mark = h.host.querySelector('svg[data-brand-mark]');
      expect(mark, 'the sidebar brand mark is named').not.toBeNull();
      const lit = [...mark!.querySelectorAll('[fill="var(--accent)"], [stroke="var(--accent)"]')];
      expect(lit).toHaveLength(2);
    } finally {
      h.dispose();
    }
  });
});
