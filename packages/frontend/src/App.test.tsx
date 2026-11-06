import { APP_NAME } from '@polyrouter/shared';
import { render } from 'solid-js/web';
import { ApiError } from './data/api';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentCalibration,
  AutoLayers,
  ChannelDto,
  ModelDto,
  RuleDto,
  TierDto,
  TierEntryDto,
} from './data/api';
import { App } from './App';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import {
  DEFAULT_AUTO_PERF,
  DEFAULT_PRICING_STATUS,
  DEFAULT_SESSION,
  DEFAULT_CALIBRATION,
  FakeApiClient,
  UNRECORDED_HEALTH,
} from './test/fakeClient';
import {
  EXPANDABLE_STAGES,
  buttonByText,
  expandAllStages,
  expandStage,
  openAutoTab,
  openTab,
  openTuning,
  stageExpander,
  targetPicker,
  targetsCell,
  targetsMatrix,
  targetsRow,
  tuningDrawerOrNull,
  cellText,
} from './test/routingTabs';
import { labelText } from './test/labelText';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

const NOW = '2026-07-15T00:00:00.000Z';
function mkModel(id: string): ModelDto {
  return {
    id,
    providerId: 'p1',
    externalModelId: `ext-${id}`,
    displayName: null,
    // contextWindow omitted: absent = unknown (honest-model-capabilities)
    supportsTools: false,
    supportsVision: false,
    supportsReasoning: false,
    isFree: false,
    inputPricePer1m: 1,
    outputPricePer1m: 2,
    effectivePrice: {
      inputPricePer1m: 1,
      outputPricePer1m: 2,
      isFree: false,
      source: 'model',
      estimated: false,
    },
    listedPrice: null,
    variant: null,
    baseExternalModelId: null,
    batchCapable: true,
    batchEffectivePrice: null,
    lastSyncedAt: null,
    unlistedSince: null,
  };
}
function mkEntry(modelId: string, position: number, mode: 'any' | 'batch' = 'any'): TierEntryDto {
  return { id: `e-${modelId}`, tierId: 't1', modelId, position, mode, model: null };
}
const DEFAULT_TIER: TierDto = {
  id: 't1',
  key: 'default',
  displayName: 'Default',
  description: null,
  createdAt: NOW,
};

function mount(store: AppStore = createAppStore(new FakeApiClient())): {
  host: HTMLElement;
  store: AppStore;
  dispose: () => void;
} {
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

function clickByText(host: HTMLElement, selector: string, text: string): void {
  const el = [...host.querySelectorAll<HTMLElement>(selector)].find((e) => labelText(e) === text);
  if (!el) throw new Error(`No element ${selector} with text "${text}"`);
  el.click();
}

describe('dashboard shell (auth-gated)', () => {
  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset['theme'];
  });

  it('shows the login gate when unauthenticated (me 401)', async () => {
    const { host, dispose } = mount(createAppStore(new FakeApiClient({ session: null })));
    try {
      await flush();
      expect(host.textContent).toContain('Sign in');
      expect(host.querySelector('nav')).toBeNull();
    } finally {
      dispose();
    }
  });

  it('renders the branded shell with all nav items once ready', async () => {
    const { host, dispose } = mount();
    try {
      await flush();
      expect(APP_NAME).toBe('polyrouter');
      expect(host.textContent).toContain(APP_NAME);
      for (const label of [
        'Overview',
        'Requests',
        'Costs',
        'Agents',
        'Providers',
        'Routing',
        'Limits',
        'Settings',
      ]) {
        expect(host.querySelector('nav')?.textContent).toContain(label);
      }
      expect(host.textContent).toContain('Recent requests');
    } finally {
      dispose();
    }
  });

  it('navigates between pages from the sidebar', async () => {
    const { host, store, dispose } = mount();
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      expect(store.state.page).toBe('routing');
      // The visit lands on Tiers & headers, which holds the header rules…
      expect(host.textContent).toContain('x-polyrouter-tier');
      // …and the automatic-routing controls are one tab away.
      await openAutoTab(host);
      expect(host.querySelector('[data-testid="auto-pipeline"]')).not.toBeNull();
      clickByText(host, '.nav-item span', 'Settings');
      expect(host.textContent).toContain('Prompt & response bodies');
    } finally {
      dispose();
    }
  });

  it('opens the decision inspector on a request row and shows the routing reason', async () => {
    const { host, store, dispose } = mount();
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Requests');
      await flush();
      const row = host.querySelector<HTMLElement>('.req-row');
      expect(row).not.toBeNull();
      row?.click();
      const first = store.state.requestList[0];
      expect(first).toBeDefined();
      expect(store.state.selId).toBe(first?.id);
      const drawer = host.querySelector('.drawer');
      expect(drawer).not.toBeNull();
      expect(drawer?.textContent).toContain('Decision');
      expect(drawer?.textContent).toContain('Usage & cost');
      expect(drawer?.textContent).toContain('Timing');
      if (first) expect(drawer?.textContent).toContain(first.routingReason);
      host.querySelector<HTMLElement>('.overlay')?.click();
      expect(store.state.selId).toBeNull();
    } finally {
      dispose();
    }
  });

  it('shows the matched routing header row only when recorded (add-routing-header-visibility)', async () => {
    const { host, store, dispose } = mount();
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Requests');
      await flush();
      const rows = host.querySelectorAll<HTMLElement>('.req-row');
      // buildRequestRows: header rows are i ≡ 1 (mod 5); i%15 cycles the shape —
      // 1 → built-in (name+value), 6 → custom rule (name only), 11 → legacy (null).
      rows[1]?.click();
      expect(store.state.requestList[1]?.routingHeaderName).toBe('x-polyrouter-tier');
      expect(host.querySelector('.drawer')?.textContent).toContain('x-polyrouter-tier: default');
      host.querySelector<HTMLElement>('.overlay')?.click();
      rows[6]?.click(); // custom rule → bare name, never a trailing colon/value
      expect(store.state.requestList[6]?.routingHeaderValue).toBeNull();
      const drawer = host.querySelector('.drawer');
      expect(drawer?.textContent).toContain('x-team');
      expect(drawer?.textContent).not.toContain('x-team:');
      host.querySelector<HTMLElement>('.overlay')?.click();
      rows[11]?.click(); // legacy header-layer row (pre-capture) → no header row at all
      expect(store.state.requestList[11]?.routingHeaderName).toBeNull();
      const drawer2 = host.querySelector('.drawer');
      expect(drawer2?.textContent).not.toContain('x-polyrouter-tier');
      expect(drawer2?.textContent).not.toContain('x-team');
    } finally {
      dispose();
    }
  });

  it('shows the ERROR card for a detailed error row and hides it for others (add-request-error-detail)', async () => {
    const { host, store, dispose } = mount();
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Requests');
      await flush();
      const rows = host.querySelectorAll<HTMLElement>('.req-row');
      // buildRequestRows: status cycles success,success,fallback,error → index 3 errors.
      rows[3]?.click();
      const errRow = store.state.requestList[3];
      expect(errRow?.status).toBe('error');
      const drawer = host.querySelector('.drawer');
      expect(drawer?.textContent).toContain('Error');
      expect(drawer?.textContent).toContain('rate_limit · HTTP 429');
      expect(drawer?.textContent).toContain('provider said');
      expect(drawer?.textContent).toContain(errRow!.errorMessage!);
      expect(drawer?.textContent).toContain(errRow!.errorRequestId!);
      host.querySelector<HTMLElement>('.overlay')?.click();
      rows[0]?.click(); // a success row renders exactly as before — no card
      const drawer2 = host.querySelector('.drawer');
      expect(drawer2?.textContent).not.toContain('provider said');
    } finally {
      dispose();
    }
  });

  it('toggles the theme, persists it, and re-applies it on a fresh mount', async () => {
    const first = mount();
    try {
      await flush();
      // The theme toggle lives in the current-user menu (user-administration).
      first.host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.click();
      await flush();
      clickByText(first.host, '[role="menuitem"]', 'Switch to dark');
      expect(document.documentElement.dataset['theme']).toBe('dark');
      expect(localStorage.getItem('polyrouter-theme')).toBe('dark');
    } finally {
      first.dispose();
    }
    delete document.documentElement.dataset['theme'];
    const second = mount();
    try {
      await flush();
      expect(document.documentElement.dataset['theme']).toBe('dark');
    } finally {
      second.dispose();
    }
  });

  it('enforces the 5-model tier cap through the Routing UI with a toast', async () => {
    const fake = new FakeApiClient({
      models: { p1: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map(mkModel) },
      tiers: [DEFAULT_TIER],
      tierEntries: { t1: [mkEntry('m1', 0), mkEntry('m2', 1), mkEntry('m3', 2)] },
    });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      const firstTierCard = host.querySelector<HTMLElement>('.panel');
      expect(firstTierCard).not.toBeNull();
      if (!firstTierCard) return;
      // Commit through the combobox: ArrowDown opens with the first addable model
      // active, Enter adds it (the same addTierModel chain the old select drove).
      const addViaPicker = (): void => {
        const input = firstTierCard.querySelector<HTMLInputElement>('input[role="combobox"]');
        if (!input) throw new Error('add-model combobox missing');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      };
      const rows = () => firstTierCard.querySelectorAll('.chain-row').length;
      const start = rows();
      expect(start).toBe(3);
      addViaPicker();
      addViaPicker();
      expect(rows()).toBe(5);
      addViaPicker();
      expect(rows()).toBe(5);
      expect(host.querySelector('.toast')?.textContent).toBe('Max 5 models per tier');
    } finally {
      dispose();
    }
  });

  it('greys an instance-disabled auto layer with the ROUTING_AUTO_LAYERS hint', async () => {
    const fake = new FakeApiClient({
      tiers: [DEFAULT_TIER],
      autoLayers: {
        structural: false,
        cascade: false,
        structuralAvailable: false,
        cascadeAvailable: false,
        semantic: false,
        semanticAvailable: false,
        semanticLearning: false,
        semanticLearningAvailable: false,
        calibration: DEFAULT_CALIBRATION,
      },
    });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      await openTab(host, 'Auto routing');
      // The hint is in the Classify layer's cell in Setup, beside its unavailable switch.
      const classify = host.querySelector<HTMLElement>(
        '[data-testid="auto-layers"] [data-layer="structural"]',
      )!;
      expect(classify.querySelector('[data-testid="layer-hint"]')?.textContent).toBe(
        'off instance-wide (ROUTING_AUTO_LAYERS)',
      );
      expect(
        classify
          .querySelector('[aria-label="Toggle L1 · Structural"]')
          ?.getAttribute('aria-disabled'),
      ).toBe('true');
      // add-auto-performance-view: no structural layer -> no range control and no stage
      // carries a figure slot at all.
      expect(host.querySelector('[data-testid="auto-range"]')).toBeNull();
      expect(host.querySelectorAll('[data-testid="stage-figure"]')).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it('L2 · Semantic is a real driven toggle when available (add-semantic-dashboard 1.2)', async () => {
    const fake = new FakeApiClient({
      tiers: [DEFAULT_TIER],
      autoLayers: {
        structural: true,
        cascade: false,
        structuralAvailable: true,
        cascadeAvailable: true,
        semantic: false,
        semanticAvailable: true,
        semanticLearning: false,
        semanticLearningAvailable: true,
        calibration: DEFAULT_CALIBRATION,
      },
    });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      await openTab(host, 'Auto routing');
      // Honest available copy — no "cloud tier" contradiction survives. The layer's
      // description is its Layers cell's, always visible — never a stage detail's.
      const cell = host.querySelector<HTMLElement>(
        '[data-testid="auto-layers"] [data-layer="semantic"]',
      )!;
      expect(cell.textContent).toContain(
        "Embedding classifier over the ambiguous slice — routes what structural can't read",
      );
      const detail = await expandStage(host, 'Semantic');
      expect(detail.textContent).not.toContain('Embedding classifier over the ambiguous slice');
      expect(host.textContent).not.toContain('cloud tier');
      const sw = host.querySelector<HTMLButtonElement>('[aria-label="Toggle L2 · Semantic"]');
      expect(sw).not.toBeNull();
      expect(sw?.getAttribute('aria-disabled')).not.toBe('true');
      sw?.click();
      await flush();
      // Enabling semantic forces structural on and carries the pair (mirrors the server).
      expect(fake.lastArgs('setAutoLayers')?.[0]).toEqual({
        structural: true,
        cascade: false,
        semantic: true,
      });
    } finally {
      dispose();
    }
  });

  /** The single off-instance-wide hint rendered for the (only) unavailable
   * layer in these fakes — exact-matched so a hint can never smuggle in a
   * mention of a half that is already satisfied. Read from the Setup panel's Layers
   * cells, where each layer's switch and hint live (split-auto-routing-readout-setup). */
  const offInstanceHint = (host: HTMLElement): string | undefined =>
    Array.from(host.querySelectorAll('[data-testid="auto-layers"] [data-testid="layer-hint"]'))
      .map((el) => el.textContent ?? '')
      .find((t) => t.startsWith('off instance-wide'));

  it('L2 · Semantic names BOTH enablement halves when unavailable with no split signal — inert, not dead (add-semantic-dashboard 1.2; fix-image-healthcheck-and-l2-hint)', async () => {
    const fake = new FakeApiClient({
      tiers: [DEFAULT_TIER],
      autoLayers: {
        structural: true,
        cascade: true,
        structuralAvailable: true,
        cascadeAvailable: true,
        semantic: false,
        semanticAvailable: false,
        // No semanticFlagEnabled/semanticClassifierReady (older API): the
        // hint must degrade to naming both halves, never a wrong single one.
        semanticLearning: false,
        semanticLearningAvailable: false,
        calibration: DEFAULT_CALIBRATION,
      },
    });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      await openTab(host, 'Auto routing');
      // The affordance explains its own absence and names both enabling envs.
      expect(offInstanceHint(host)).toBe(
        'off instance-wide — optional module; needs SEMANTIC_MODEL_PATH (or the -semantic image) + semantic in ROUTING_AUTO_LAYERS',
      );
      // No inert-control contradiction (the deleted stub) remains anywhere.
      expect(host.textContent).not.toContain('cloud tier');
      const sw = host.querySelector<HTMLButtonElement>('[aria-label="Toggle L2 · Semantic"]');
      expect(sw).not.toBeNull();
      expect(sw?.getAttribute('aria-disabled')).toBe('true');
      // Inert: activating an unavailable layer sends no write.
      sw?.click();
      await flush();
      expect(fake.calls).not.toContain('setAutoLayers');
    } finally {
      dispose();
    }
  });

  it('unavailable L2 with the classifier ready points ONLY at ROUTING_AUTO_LAYERS (fix-image-healthcheck-and-l2-hint)', async () => {
    const fake = new FakeApiClient({
      tiers: [DEFAULT_TIER],
      autoLayers: {
        structural: true,
        cascade: true,
        structuralAvailable: true,
        cascadeAvailable: true,
        semantic: false,
        semanticAvailable: false,
        semanticFlagEnabled: false,
        semanticClassifierReady: true, // the -semantic image without the env
        semanticLearning: false,
        semanticLearningAvailable: false,
        calibration: DEFAULT_CALIBRATION,
      },
    });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      await openTab(host, 'Auto routing');
      const hint = offInstanceHint(host);
      expect(hint).toBe('off instance-wide — model loaded; add semantic to ROUTING_AUTO_LAYERS');
      // Never points at the half that is already satisfied.
      expect(hint).not.toContain('SEMANTIC_MODEL_PATH');
    } finally {
      dispose();
    }
  });

  it('unavailable L2 with the flag set points ONLY at the model half — verify, never "unset" (fix-image-healthcheck-and-l2-hint)', async () => {
    const fake = new FakeApiClient({
      tiers: [DEFAULT_TIER],
      autoLayers: {
        structural: true,
        cascade: true,
        structuralAvailable: true,
        cascadeAvailable: true,
        semantic: false,
        semanticAvailable: false,
        semanticFlagEnabled: true,
        semanticEmbedderReady: false, // no bundle at all — the path IS the fix
        semanticClassifierReady: false,
        semanticLearning: false,
        semanticLearningAvailable: false,
        calibration: DEFAULT_CALIBRATION,
      },
    });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      await openTab(host, 'Auto routing');
      const hint = offInstanceHint(host);
      expect(hint).toBe(
        'off instance-wide — no ready model; check SEMANTIC_MODEL_PATH + boot logs, or run the -semantic image',
      );
      // Never points at the satisfied flag half, and never claims the var is unset.
      expect(hint).not.toContain('ROUTING_AUTO_LAYERS');
      expect(hint).not.toContain('set SEMANTIC_MODEL_PATH to enable');
    } finally {
      dispose();
    }
  });

  it('a LOADED model whose centroids failed points at the centroid build, never the path (fix-semantic-boot-embed-budget)', async () => {
    // The reported field defect: the bundle loaded perfectly and the anchor
    // build ran out of budget. The old copy sent the operator to check
    // SEMANTIC_MODEL_PATH — which was never wrong.
    const fake = new FakeApiClient({
      tiers: [DEFAULT_TIER],
      autoLayers: {
        structural: true,
        cascade: true,
        structuralAvailable: true,
        cascadeAvailable: true,
        semantic: false,
        semanticAvailable: false,
        semanticFlagEnabled: true,
        semanticEmbedderReady: true,
        semanticClassifierReady: false,
        semanticLearning: false,
        semanticLearningAvailable: false,
        calibration: DEFAULT_CALIBRATION,
      },
    });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      await openTab(host, 'Auto routing');
      const hint = offInstanceHint(host);
      expect(hint).toContain('centroids did not build');
      expect(hint).toContain('boot log');
      // Neither satisfied half may be named: the path is correct and so is the flag.
      expect(hint).not.toContain('SEMANTIC_MODEL_PATH');
      expect(hint).not.toContain('-semantic image');
      expect(hint).not.toContain('ROUTING_AUTO_LAYERS');
    } finally {
      dispose();
    }
  });

  it('a loaded model with the flag off names the centroids AND the flag, never the path', async () => {
    const fake = new FakeApiClient({
      tiers: [DEFAULT_TIER],
      autoLayers: {
        structural: true,
        cascade: true,
        structuralAvailable: true,
        cascadeAvailable: true,
        semantic: false,
        semanticAvailable: false,
        semanticFlagEnabled: false,
        semanticEmbedderReady: true,
        semanticClassifierReady: false,
        semanticLearning: false,
        semanticLearningAvailable: false,
        calibration: DEFAULT_CALIBRATION,
      },
    });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      await openTab(host, 'Auto routing');
      const hint = offInstanceHint(host);
      expect(hint).toContain('centroids did not build');
      expect(hint).toContain('ROUTING_AUTO_LAYERS');
      expect(hint).not.toContain('SEMANTIC_MODEL_PATH');
    } finally {
      dispose();
    }
  });

  const learningLayers = (over: Partial<AutoLayers> = {}): AutoLayers => ({
    structural: true,
    cascade: false,
    structuralAvailable: true,
    cascadeAvailable: true,
    semantic: true,
    semanticAvailable: true,
    semanticLearning: false,
    semanticLearningAvailable: true,
    calibration: DEFAULT_CALIBRATION,
    ...over,
  });

  it('learning card is hidden until the semantic layer is EFFECTIVE (add-semantic-dashboard 2.1)', async () => {
    const fake = new FakeApiClient({
      tiers: [DEFAULT_TIER],
      autoLayers: { ...learningLayers(), semantic: false }, // available but not enabled
    });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      // Open the card's own tab AND stage first — otherwise this would pass because
      // the tab or the detail is closed, not because the semantic layer is ineffective.
      await openTab(host, 'Auto routing');
      const detail = await expandStage(host, 'Semantic');
      expect(detail.querySelector('[data-testid="ap-semantic-slice"]')).not.toBeNull(); // open
      expect(host.textContent).not.toContain('Semantic learning');
    } finally {
      dispose();
    }
  });

  it('learning card: off state, then toggling on writes semanticLearning (add-semantic-dashboard 2.1)', async () => {
    const fake = new FakeApiClient({
      tiers: [DEFAULT_TIER],
      autoLayers: learningLayers(),
      semanticLearningStatus: {
        enabled: false,
        available: true,
        epoch: 0,
        generation: 0,
        source: 'bundled',
        freshHigh: 0,
        freshLow: 0,
        lastAppliedAt: null,
        history: [],
      },
    });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      await openTab(host, 'Auto routing');
      await openTuning(host, 'learning'); // the card is the Semantic learning drawer's
      expect(host.textContent).toContain('Semantic learning');
      expect(host.textContent).toContain('active: bundled anchors');
      expect(host.textContent).toContain('No learning events yet.');
      const sw = host.querySelector<HTMLButtonElement>('[aria-label="Semantic learning"]');
      expect(sw?.getAttribute('aria-checked')).toBe('false');
      sw?.click();
      await flush();
      expect(fake.lastArgs('setAutoLayers')?.[0]).toEqual({
        structural: true,
        cascade: false,
        semantic: true,
        semanticLearning: true,
      });
    } finally {
      dispose();
    }
  });

  it('learning card: applied learned state offers a confirmed revert (add-semantic-dashboard 2.1)', async () => {
    const fake = new FakeApiClient({
      tiers: [DEFAULT_TIER],
      autoLayers: { ...learningLayers(), semanticLearning: true },
      semanticLearningStatus: {
        enabled: true,
        available: true,
        epoch: 1,
        generation: 2,
        source: 'learned',
        freshHigh: 5,
        freshLow: 12,
        lastAppliedAt: '2026-07-03T00:00:00.000Z',
        history: [
          {
            id: 'ev1',
            occurrenceId: 'occ:1',
            trigger: 'apply',
            epoch: 1,
            generation: 2,
            highSamples: 5,
            lowSamples: 12,
            highDrift: 0.05,
            lowDrift: 0.03,
            highSimilarity: 0.95,
            lowSimilarity: 0.97,
            reason: 'promoted',
            createdAt: '2026-07-03T00:00:00.000Z',
          },
        ],
      },
    });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      await openTab(host, 'Auto routing');
      await openTuning(host, 'learning'); // the card is the Semantic learning drawer's
      expect(host.textContent).toContain('active: learned centroids');
      expect(host.textContent).toContain('learning from 12 low · 5 high');
      expect(host.textContent).toContain('drift 0.03/0.05 · sim 0.97/0.95');
      // Two-step confirm: the ghost reveals the confirm affordance; no write yet.
      clickByText(host, 'button', 'Revert to bundled');
      await flush();
      expect(host.textContent).toContain('Revert all learned centroids?');
      expect(fake.calls).not.toContain('semanticLearningRevert');
      clickByText(host, 'button', 'Confirm revert');
      await flush();
      expect(fake.calls).toContain('semanticLearningRevert');
    } finally {
      dispose();
    }
  });

  it('learning card: a stale learned centroid shows bundled WITH the reason, never a wrong badge (add-semantic-dashboard 2.1)', async () => {
    const fake = new FakeApiClient({
      tiers: [DEFAULT_TIER],
      autoLayers: { ...learningLayers(), semanticLearning: true },
      semanticLearningStatus: {
        enabled: true,
        available: true,
        epoch: 1,
        generation: 2,
        source: 'bundled', // promoted but inactive — embedder/revision moved
        freshHigh: 0,
        freshLow: 0,
        lastAppliedAt: '2026-07-03T00:00:00.000Z',
        history: [],
      },
    });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      await openTab(host, 'Auto routing');
      await openTuning(host, 'learning'); // the card is the Semantic learning drawer's
      expect(host.textContent).toContain('active: bundled anchors');
      expect(host.textContent).toContain('inactive');
      expect(host.textContent).not.toContain('active: learned centroids');
      // Revert is still reachable for the stale centroid.
      expect(host.textContent).toContain('Revert to bundled');
    } finally {
      dispose();
    }
  });

  it('learning card: a failed initial status load still shows the card + toggle + Retry (add-semantic-dashboard 2.1, clink Med-4)', async () => {
    const fake = new FakeApiClient({
      tiers: [DEFAULT_TIER],
      autoLayers: { ...learningLayers(), semanticLearning: true },
    });
    // The status GET fails — the card must not vanish (its own Retry lives inside).
    fake.semanticLearningStatus = () =>
      Promise.reject(new ApiError(500, 'Internal', 'learning status boom'));
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      await openTab(host, 'Auto routing');
      await openTuning(host, 'learning'); // the card is the Semantic learning drawer's
      // Shell renders: title + a toggle reflecting the auto-layers truth (on).
      expect(host.textContent).toContain('Semantic learning');
      const sw = host.querySelector<HTMLButtonElement>('[aria-label="Semantic learning"]');
      expect(sw).not.toBeNull();
      expect(sw?.getAttribute('aria-checked')).toBe('true'); // from autoLayers, not the failed GET
      // The error + its own Retry are present (not hidden behind the null VM).
      expect(host.textContent).toContain('Couldn’t load learning status');
      expect(host.textContent).toContain('learning status boom');
      const retry = [...host.querySelectorAll<HTMLElement>('button')].find(
        (b) => labelText(b) === 'Retry',
      );
      expect(retry).not.toBeUndefined();
    } finally {
      dispose();
    }
  });

  it('Band targets: set, retarget, clear, shadowed cleanup, warnings, cascade note (add-band-target-ui)', async () => {
    const mkRule = (over: Partial<RuleDto>): RuleDto => ({
      id: 'r-b1',
      matchType: 'auto_high',
      workloadClass: null,
      headerName: 'x-polyrouter-tier',
      headerValue: null,
      target: 'tier:premium',
      priority: 0,
      createdAt: NOW,
      ...over,
    });
    const premium: TierDto = {
      id: 't-premium',
      key: 'premium',
      displayName: null,
      description: null,
      createdAt: NOW,
    };
    const fake = new FakeApiClient({
      tiers: [DEFAULT_TIER, premium],
      tierEntries: {
        t1: [mkEntry('m1', 0)],
        't-premium': [
          {
            id: 'ep1',
            tierId: 't-premium',
            modelId: 'm2',
            position: 0,
            mode: 'any' as const,
            model: null,
          },
        ],
      },
      models: { p1: [mkModel('m1'), mkModel('m2')] },
      rules: [
        mkRule({ id: 'r-eff', priority: 5 }),
        mkRule({ id: 'r-shadow', priority: 0 }), // shadowed duplicate
      ],
    });
    const { host, store, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      await openTab(host, 'Auto routing');
      // The Any request row's Strong and Cheap cells are the GENERIC bands.
      const any = () => targetsRow(host, 'any');
      const strong = () => targetsCell(host, 'any', 'strong');
      const cheap = () => targetsCell(host, 'any', 'cheap');
      // Effective (priority 5) shown with chain preview; duplicate disclosed.
      expect(strong().textContent).toContain('tier:premium');
      expect(strong().textContent).toContain('1 shadowed duplicate rule');
      // The cheap band is unset with its consequence copy; cascade needs both — a note on
      // the Any request row, which is the only row the check reads.
      expect(cheap().textContent).toContain(
        'Not set — confident low verdicts fall through to default',
      );
      expect(any().textContent).toContain('Cascade needs both Any request bands usable');
      // Cleanup removes only the shadowed rule.
      buttonByText(strong(), 'clean up')!.click();
      await flush();
      expect(store.state.rules.filter((r) => r.matchType === 'auto_high')).toHaveLength(1);
      expect(store.state.rules.some((r) => r.id === 'r-eff')).toBe(true);
      // Keyboard-native picker, named for its cell: setting the cheap band via the select.
      // The pickers REST on their placeholder — never on a real option (the
      // v0.5.0 bug showed "default" because nothing selected the placeholder).
      expect(targetPicker(host, 'Strong target for any request').value).toBe('');
      const cheapSelect = targetPicker(host, 'Cheap target for any request');
      expect(cheapSelect.value).toBe('');
      expect(cheap().contains(cheapSelect)).toBe(true);
      cheapSelect.value = 'tier:default';
      cheapSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
      expect(store.state.rules.some((r) => r.matchType === 'auto_low')).toBe(true);
      // The same element, back on the placeholder after applying — the cell updated in
      // place rather than rebuilding under the user.
      expect(cheapSelect.isConnected).toBe(true);
      expect(cheapSelect.value).toBe('');
      expect(any().textContent).not.toContain('Cascade needs both Any request bands usable');
      expect(cheap().textContent).toContain('uses the Layer-0 default chain');
      // Clear removes the whole band again.
      buttonByText(cheap(), 'Clear')!.click();
      await flush();
      expect(store.state.rules.some((r) => r.matchType === 'auto_low')).toBe(false);
    } finally {
      dispose();
    }
  });

  it('Workload targets: live rows pick/clear, reserved rows read-only, precedence copy, routed counts + Auto-performance disclosure (add-workload-routing)', async () => {
    const mkRule = (over: Partial<RuleDto>): RuleDto => ({
      id: 'r-w1',
      matchType: 'auto_workload',
      workloadClass: 'code',
      headerName: 'x-polyrouter-tier',
      headerValue: null,
      target: 'tier:premium',
      priority: 0,
      createdAt: NOW,
      ...over,
    });
    const premium: TierDto = {
      id: 't-premium',
      key: 'premium',
      displayName: null,
      description: null,
      createdAt: NOW,
    };
    const fake = new FakeApiClient({
      tiers: [DEFAULT_TIER, premium],
      tierEntries: {
        t1: [mkEntry('m1', 0)],
        't-premium': [
          {
            id: 'ep1',
            tierId: 't-premium',
            modelId: 'm2',
            position: 0,
            mode: 'any' as const,
            model: null,
          },
        ],
      },
      models: { p1: [mkModel('m1'), mkModel('m2')] },
      rules: [
        mkRule({ id: 'r-eff', priority: 5 }),
        mkRule({ id: 'r-shadow', priority: 0 }), // shadowed duplicate of code
        mkRule({ id: 'r-res', workloadClass: 'research', target: 'model:m1' }), // API-created reserved
        mkRule({ id: 'r-res-dupe', workloadClass: 'research', target: 'model:m2', priority: -1 }), // its duplicate
      ],
      autoPerf: {
        ...DEFAULT_AUTO_PERF,
        workloadMix: {
          evaluated: 9,
          unclassified: 0,
          since: NOW,
          revisions: [],
          classes: [
            {
              class: 'code',
              requests: 6,
              unpricedRequests: 0,
              unpricedAttempts: 0,
              spendUsd: 1,
              routed: 2,
            },
            {
              class: 'none',
              requests: 3,
              unpricedRequests: 0,
              unpricedAttempts: 0,
              spendUsd: 0,
              routed: 0,
            },
          ],
        },
      },
    });
    const { host, store, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      await openTab(host, 'Auto routing');
      const matrix = targetsMatrix(host);
      const claimCell = (cls: 'code' | 'vision' | 'research' | 'writing') =>
        targetsCell(host, cls, 'claim');
      // The precedence line, stated plainly at the top of the matrix.
      const precedence = matrix.querySelector('[data-testid="targets-precedence"]')!.textContent;
      expect(precedence).toContain('before band targets, Layer 2, and the cascade');
      expect(precedence).toContain('An explicit model or the tier header still wins');
      // One row per taxonomy class after the Any request row, every class's Claim cell
      // naming the rule type it reads and writes.
      const rows = [...matrix.querySelectorAll<HTMLElement>('[data-testid="targets-row"]')];
      expect(rows.map((r) => r.dataset['row'])).toEqual([
        'any',
        'code',
        'vision',
        'structured',
        'research',
        'writing',
      ]);
      for (const r of rows.slice(1)) {
        const label = r.querySelector('[data-column="claim"] .tm-label')!.textContent;
        expect(label?.trim()).toBe('Claim');
      }
      // Effective (priority 5) shown with chain preview; duplicate disclosed. The routed
      // count is no longer in the matrix — it is the Workload claim detail's (below).
      expect(targetsRow(host, 'code').textContent).toContain('Code');
      expect(claimCell('code').textContent).toContain('tier:premium');
      expect(claimCell('code').textContent).toContain('1 shadowed duplicate rule');
      expect(matrix.querySelector('[data-testid="targets-detected"]')).toBeNull();
      expect(matrix.querySelector('[data-testid="wt-routed"]')).toBeNull();
      // Unset live claims carry their short value and a picker resting on the placeholder;
      // the row label names the class's detection signal.
      expect(claimCell('vision').textContent).toContain(
        'No claim — takes the complexity path (bands, then L2 and the cascade, then default)',
      );
      expect(targetsRow(host, 'vision').textContent).toContain('an image in the request');
      const matrixFoot = matrix.querySelector('[data-testid="targets-footnote"]')!.textContent;
      expect(matrixFoot).toContain('vision › structured › code'); // classifier precedence disclosed (clink r5 L1)
      expect(matrixFoot).toContain('configured code thresholds');
      expect(matrixFoot).toContain('auto_workload'); // the rule ids moved to the foot
      const visionSelect = targetPicker(host, 'Claim target for vision');
      expect(claimCell('vision').contains(visionSelect)).toBe(true);
      expect(visionSelect.value).toBe('');
      // Reserved claims: no picker, no Clear — the API-created research rule is disclosed
      // read-only, and the row says it is inert, naming the missing half.
      expect(
        matrix.querySelector('[data-testid="targets-reserved-footnote"]')!.textContent,
      ).toContain('not detected here yet');
      expect(claimCell('research').querySelector('select')).toBeNull();
      expect(buttonByText(claimCell('research'), 'Clear')).toBeUndefined();
      expect(
        claimCell('research').querySelector('[data-testid="cell-reserved-note"]')!.textContent,
      ).toContain('stays inert until the semantic workload source emits research');
      // ONE note shared by the reserved rows, which each inert Claim cell points at.
      const reservedNote = matrix.querySelector<HTMLElement>(
        '[data-testid="targets-reserved-note"]',
      )!;
      expect(reservedNote.textContent).toContain(
        'inert until the semantic workload source is effective',
      );
      for (const cls of ['research', 'writing'] as const)
        expect(claimCell(cls).getAttribute('aria-describedby')).toBe(reservedNote.id);
      // A reserved duplicate is DISCLOSED but never actionable here (clink r5 M3).
      const reservedDupe = claimCell('research').querySelector('[data-testid="cell-shadowed"]')!;
      expect(reservedDupe.textContent).toContain('1 shadowed duplicate rule');
      expect(reservedDupe.textContent).toContain('API-created');
      expect(buttonByText(claimCell('research'), 'clean up')).toBeUndefined();
      expect(claimCell('writing').textContent).toContain('inert (read-only)');
      expect(claimCell('writing').querySelector('select')).toBeNull();
      // Cleanup removes only the shadowed code rule; the research rule is untouched.
      buttonByText(claimCell('code'), 'clean up')!.click();
      await flush();
      expect(store.state.rules.filter((r) => r.workloadClass === 'code').map((r) => r.id)).toEqual([
        'r-eff',
      ]);
      expect(store.state.rules.filter((r) => r.workloadClass === 'research')).toHaveLength(2); // reserved rows untouched
      // Setting vision via the picker creates an auto_workload rule carrying the class.
      visionSelect.value = 'tier:default';
      visionSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
      expect(store.state.rules.find((r) => r.workloadClass === 'vision')).toMatchObject({
        matchType: 'auto_workload',
        target: 'tier:default',
      });
      expect(visionSelect.value).toBe('');
      expect(claimCell('vision').textContent).toContain('uses the Layer-0 default chain');
      // Clear removes the vision rule again.
      buttonByText(claimCell('vision'), 'Clear')!.click();
      await flush();
      expect(store.state.rules.some((r) => r.workloadClass === 'vision')).toBe(false);
      // Auto-performance: the disclosure + widened residual note + per-row routed, each
      // in the stage it describes on the same Auto routing tab.
      const classify = await expandStage(host, 'Classify');
      expect(
        classify.querySelector('[data-testid="ap-workload-disclosure"]')!.textContent,
      ).toContain('include 2 workload-routed requests');
      // DEFAULT_AUTO_PERF also routes semantically — the note names BOTH causes.
      const cascade = await expandStage(host, 'Cascade');
      expect(cascade.querySelector('[data-testid="ap-residual-note"]')!.textContent).toContain(
        'Semantically- and workload-routed requests never enter the cascade',
      );
      const claim = await expandStage(host, 'Workload claim');
      const mixRows = [...claim.querySelectorAll<HTMLElement>('[data-testid="workload-row"]')];
      expect(
        mixRows[0]!.querySelector('[data-testid="workload-row-routed"]')!.textContent,
      ).toContain('2 routed');
      expect(mixRows[1]!.querySelector('[data-testid="workload-row-routed"]')).toBeNull(); // `none` never routes
      const footnote = claim.querySelector('[data-testid="workload-mix-footnote"]')!.textContent;
      expect(footnote).toContain('Classification itself never routes');
      // Names the Claim's home, never a position or a card that no longer exists.
      expect(footnote).toContain('its Claim in the Targets matrix');
      expect(footnote).not.toContain('Workload targets card');
    } finally {
      dispose();
    }
  });

  it('Workload targets: reserved rows go LIVE when the semantic workload source is effective; the missing half is named otherwise (add-semantic-workloads)', async () => {
    const premium: TierDto = {
      id: 't-premium',
      key: 'premium',
      displayName: null,
      description: null,
      createdAt: NOW,
    };
    const base = {
      tiers: [DEFAULT_TIER, premium],
      tierEntries: {
        t1: [mkEntry('m1', 0)],
        't-premium': [
          {
            id: 'ep1',
            tierId: 't-premium',
            modelId: 'm2',
            position: 0,
            mode: 'any' as const,
            model: null,
          },
        ],
      },
      models: { p1: [mkModel('m1'), mkModel('m2')] },
      rules: [] as RuleDto[],
    };
    const live = {
      structural: true,
      cascade: true,
      structuralAvailable: true,
      cascadeAvailable: true,
      semantic: true,
      semanticAvailable: true,
      semanticFlagEnabled: true,
      semanticClassifierReady: true,
      semanticWorkloadAvailable: true,
      semanticWorkload: true,
      semanticLearning: false,
      semanticLearningAvailable: true,
      calibration: DEFAULT_CALIBRATION,
    };
    // 1) effective → research/writing rows carry controls; heading + footnotes flip.
    let fake = new FakeApiClient({ ...base, autoLayers: live });
    let mounted = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(mounted.host, '.nav-item span', 'Routing');
      await flush();
      await openTab(mounted.host, 'Auto routing');
      const host = mounted.host;
      const research = () => targetsCell(host, 'research', 'claim');
      const select = targetPicker(host, 'Claim target for research');
      expect(research().contains(select)).toBe(true);
      expect(targetsRow(host, 'research').textContent).toContain('the semantic workload source');
      // A live reserved row is no longer inert: the shared note goes.
      expect(targetsMatrix(host).querySelector('[data-testid="targets-reserved-note"]')).toBeNull();
      expect(
        targetsMatrix(host).querySelector('[data-testid="targets-reserved-footnote"]')!.textContent,
      ).toContain('detected by the semantic workload source (one bounded embed');
      // setting research via the picker creates the rule like any structural class
      select.value = 'tier:premium';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
      expect(mounted.store.state.rules.find((r) => r.workloadClass === 'research')).toMatchObject({
        matchType: 'auto_workload',
        target: 'tier:premium',
      });
      // the cell re-rendered with the reconciled rule
      expect(research().textContent).toContain('tier:premium');
      // and Clear is offered for the live reserved row
      expect(buttonByText(research(), 'Clear')).toBeDefined();
      // the Auto-performance mix footnote flips too (the Workload claim stage, same tab)
      const claim = await expandStage(mounted.host, 'Workload claim');
      expect(claim.querySelector('[data-testid="workload-mix-footnote"]')!.textContent).toContain(
        'detected by the semantic workload source',
      );
    } finally {
      mounted.dispose();
    }
    // 2) capability present but the tenant's semantic layer OFF → read-only, naming the toggle.
    fake = new FakeApiClient({
      ...base,
      autoLayers: { ...live, semantic: false, semanticWorkload: false },
    });
    mounted = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(mounted.host, '.nav-item span', 'Routing');
      await flush();
      await openTab(mounted.host, 'Auto routing');
      const research = targetsCell(mounted.host, 'research', 'claim');
      expect(research.querySelector('select')).toBeNull();
      expect(
        targetsMatrix(mounted.host).querySelector('[data-testid="targets-reserved-note"]')!
          .textContent,
      ).toContain('toggled off for this tenant');
      expect(research.textContent).toContain('inert (read-only)');
    } finally {
      mounted.dispose();
    }
    // 3) model loaded but the workload anchors did not build → names the centroid half.
    fake = new FakeApiClient({
      ...base,
      autoLayers: { ...live, semanticWorkloadAvailable: false, semanticWorkload: false },
    });
    mounted = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(mounted.host, '.nav-item span', 'Routing');
      await flush();
      await openTab(mounted.host, 'Auto routing');
      expect(
        targetsMatrix(mounted.host).querySelector('[data-testid="targets-reserved-note"]')!
          .textContent,
      ).toContain('workload anchors did not build');
      expect(
        targetsMatrix(mounted.host).querySelector('[data-testid="targets-reserved-footnote"]')!
          .textContent,
      ).toContain('workload anchors did not build');
    } finally {
      mounted.dispose();
    }
  });

  it("Targets matrix: every class row's own Strong/Cheap pair at once — scoped set/clear, generic cells untouched, claim annotations (add-workload-scoped-bands)", async () => {
    const mkRule = (over: Partial<RuleDto>): RuleDto => ({
      id: 'r-x',
      matchType: 'auto_high',
      workloadClass: null,
      headerName: 'x-polyrouter-tier',
      headerValue: null,
      target: 'tier:premium',
      priority: 0,
      createdAt: NOW,
      ...over,
    });
    const premium: TierDto = {
      id: 't-premium',
      key: 'premium',
      displayName: null,
      description: null,
      createdAt: NOW,
    };
    const empty: TierDto = {
      id: 't-empty',
      key: 'empty',
      displayName: null,
      description: null,
      createdAt: NOW,
    };
    const fake = new FakeApiClient({
      tiers: [DEFAULT_TIER, premium, empty],
      tierEntries: {
        t1: [mkEntry('m1', 0)],
        't-premium': [
          {
            id: 'ep1',
            tierId: 't-premium',
            modelId: 'm2',
            position: 0,
            mode: 'any' as const,
            model: null,
          },
        ],
        't-empty': [],
      },
      models: { p1: [mkModel('m1'), mkModel('m2')] },
      rules: [
        mkRule({ id: 'g-high' }), // generic strong → premium
        mkRule({ id: 'code-high', workloadClass: 'code', target: 'tier:default', priority: 9 }), // scoped strong
        mkRule({
          id: 'vision-low',
          matchType: 'auto_low',
          workloadClass: 'vision',
          target: 'tier:empty',
        }), // scoped cheap, EMPTY tier
        mkRule({
          id: 'claim',
          matchType: 'auto_workload',
          workloadClass: 'vision',
          target: 'tier:premium',
        }), // usable claim for vision
      ],
    });
    const { host, store, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      await openTab(host, 'Auto routing');
      // The Any request cells consider generic rules only: the higher-priority scoped rule
      // is NOT the generic effective one, and is no generic duplicate either.
      expect(targetsCell(host, 'any', 'strong').textContent).toContain('tier:premium');
      expect(targetsRow(host, 'any').textContent).not.toContain('shadowed duplicate');
      // code: Strong is its own scoped rule (default tier); Cheap inherits and names the
      // Any request target it falls back to — here unset, so it says where verdicts go.
      const codeHigh = () => targetsCell(host, 'code', 'strong');
      const codeLow = () => targetsCell(host, 'code', 'cheap');
      expect(codeHigh().dataset['kind']).toBe('set');
      expect(codeHigh().textContent).toContain('tier:default');
      expect(codeLow().dataset['kind']).toBe('inherit');
      expect(codeLow().textContent).toContain(
        '= Any request · not set — confident low verdicts go to Default',
      );
      // vision: Strong inherits the generic premium target BY NAME.
      expect(targetsCell(host, 'vision', 'strong').textContent).toContain(
        '= Any request · tier:premium',
      );
      // No claim for code → no claimed annotation, no claim note on its row.
      expect(targetsRow(host, 'code').querySelector('[data-testid="cell-claimed"]')).toBeNull();
      expect(
        targetsRow(host, 'code').querySelector('[data-testid="targets-claim-note"]'),
      ).toBeNull();
      // Set the code Cheap cell via its picker → a scoped auto_low rule with the class;
      // generic rules untouched.
      const cheapPicker = targetPicker(host, 'Cheap target for code');
      expect(codeLow().contains(cheapPicker)).toBe(true);
      cheapPicker.value = 'tier:premium';
      cheapPicker.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
      expect(
        store.state.rules.find((r) => r.matchType === 'auto_low' && r.workloadClass === 'code'),
      ).toMatchObject({ target: 'tier:premium' });
      expect(store.state.rules.find((r) => r.id === 'g-high')!.target).toBe('tier:premium');
      expect(
        store.state.rules.some((r) => r.matchType === 'auto_low' && r.workloadClass === null),
      ).toBe(false); // no generic cheap was created
      expect(codeLow().dataset['kind']).toBe('set');
      expect(codeLow().textContent).not.toContain('= Any request');
      // vision has a usable claim: both band cells are annotated as not consulted, and the
      // empty scoped cheap is still flagged unroutable-for-class beneath the annotation.
      const visionLow = () => targetsCell(host, 'vision', 'cheap');
      for (const col of ['strong', 'cheap'] as const) {
        const cell = targetsCell(host, 'vision', col);
        expect(cell.dataset['claimed']).toBe('true');
        expect(cell.querySelector('[data-testid="cell-claimed"]')!.textContent).toBe(
          'Not consulted — the Vision claim wins',
        );
      }
      expect(visionLow().textContent).toContain('unroutable for the class');
      // Clear the vision cheap cell → only that scope's rule goes.
      buttonByText(visionLow(), 'Clear')!.click();
      await flush();
      expect(store.state.rules.some((r) => r.id === 'vision-low')).toBe(false);
      expect(store.state.rules.some((r) => r.id === 'code-high')).toBe(true);
      expect(store.state.rules.some((r) => r.id === 'g-high')).toBe(true);
      // An UNUSABLE claim (empty tier) does not claim: the annotations go, and the row
      // says the bands apply.
      store.setState('rules', (rs) =>
        rs.map((r) => (r.id === 'claim' ? { ...r, target: 'tier:empty' } : r)),
      );
      await flush();
      expect(targetsRow(host, 'vision').querySelector('[data-testid="cell-claimed"]')).toBeNull();
      const note = targetsRow(host, 'vision').querySelector('[data-testid="targets-claim-note"]');
      expect(note!.textContent).toContain('set but unusable');
      expect(note!.textContent).toContain('the bands apply');
    } finally {
      dispose();
    }
  });

  it("Targets matrix: a claimed class keeps each band cell's own target, disclosures, picker and Clear — the claim is an annotation, never a replacement", async () => {
    // A usable claim on code, over a scoped Strong rule whose tier was deleted. Hidden
    // under the claim, that broken rule would go live, unwarned, the moment the claim is
    // cleared — so the cell must keep presenting it, and keep it fixable.
    const coding: TierDto = { ...DEFAULT_TIER, id: 't-coding', key: 'coding', displayName: null };
    const rule = (over: Partial<RuleDto>): RuleDto => ({
      id: 'r',
      matchType: 'auto_workload',
      workloadClass: 'code',
      headerName: 'x-polyrouter-tier',
      headerValue: null,
      target: 'tier:coding',
      priority: 0,
      createdAt: NOW,
      ...over,
    });
    const fake = new FakeApiClient({
      tiers: [DEFAULT_TIER, coding],
      tierEntries: {
        t1: [mkEntry('m1', 0)],
        't-coding': [{ ...mkEntry('m2', 0), id: 'e-coding', tierId: 't-coding' }],
      },
      models: { p1: [mkModel('m1'), mkModel('m2')] },
      rules: [
        rule({ id: 'code-claim' }),
        rule({ id: 'code-high', matchType: 'auto_high', target: 'tier:gone' }),
        rule({ id: 'code-high-dupe', matchType: 'auto_high', target: 'tier:gone', priority: -1 }),
      ],
    });
    const { host, store, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      await openTab(host, 'Auto routing');
      const strong = () => targetsCell(host, 'code', 'strong');
      // Claimed — and still the cell's own unresolved state, with its disclosures.
      expect(strong().dataset['claimed']).toBe('true');
      expect(strong().dataset['kind']).toBe('unresolved');
      expect(strong().querySelector('[data-testid="cell-claimed"]')).not.toBeNull();
      expect(strong().textContent).toContain('tier:gone');
      expect(strong().textContent).toContain('unroutable for the class');
      expect(strong().textContent).toContain('Recreating the tier key rebinds this rule.');
      expect(strong().textContent).toContain('1 shadowed duplicate rule');
      // …and still operable: the picker is live and Clear is offered.
      const picker = targetPicker(host, 'Strong target for code');
      expect(strong().contains(picker)).toBe(true);
      expect(picker.disabled).toBe(false);
      const clear = buttonByText(strong(), 'Clear')!;
      expect(clear.getAttribute('aria-label')).toBe('Clear Strong target for code');
      expect(clear.disabled).toBe(false);
      // The Cheap cell is claimed too, and inherits — still with its own picker.
      expect(targetsCell(host, 'code', 'cheap').dataset['claimed']).toBe('true');
      expect(targetPicker(host, 'Cheap target for code').disabled).toBe(false);
      // Fixing the broken rule under the claim retargets THAT rule — the claim stays.
      picker.value = 'tier:coding';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
      expect(store.state.rules.find((r) => r.id === 'code-high')!.target).toBe('tier:coding');
      expect(store.state.rules.find((r) => r.id === 'code-claim')!.target).toBe('tier:coding');
      expect(strong().dataset['kind']).toBe('set');
      expect(strong().dataset['claimed']).toBe('true');
    } finally {
      dispose();
    }
  });

  it('Targets matrix: ONE unverified notice names the paused column and retries; a batch-only target is flagged in its cell', async () => {
    const batchOnly: ModelDto = {
      ...mkModel('m-batch'),
      variant: 'batch',
      baseExternalModelId: 'ext-m1',
    };
    const fake = new FakeApiClient({
      tiers: [DEFAULT_TIER],
      tierEntries: { t1: [mkEntry('m1', 0)] },
      models: { p1: [mkModel('m1'), batchOnly] },
      rules: [
        {
          id: 'vision-low',
          matchType: 'auto_low',
          workloadClass: 'vision',
          headerName: 'x-polyrouter-tier',
          headerValue: null,
          target: 'model:m-batch',
          priority: 0,
          createdAt: NOW,
        },
      ],
    });
    const { host, store, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      await openTab(host, 'Auto routing');
      // The batch-only note sits in the cell whose rule targets the variant, and only there.
      const note = targetsCell(host, 'vision', 'cheap').querySelector(
        '[data-testid="cell-nonroutable"]',
      );
      expect(note?.textContent).toBe('batch-only — cannot serve; use ext-m1');
      expect(targetsMatrix(host).querySelectorAll('[data-testid="cell-nonroutable"]')).toHaveLength(
        1,
      );
      const notices = () =>
        targetsMatrix(host).querySelectorAll<HTMLElement>('[data-testid="targets-unverified"]');
      expect(notices()).toHaveLength(0);

      // A band write could not be verified: the Strong and Cheap columns pause, in EVERY
      // row; the Claim column does not.
      store.setState('bt', 'unverified', true);
      await flush();
      expect(notices()).toHaveLength(1);
      expect(notices()[0]!.textContent).toContain('Routing may have changed — the refresh failed');
      expect(notices()[0]!.textContent).toContain('Strong and Cheap columns');
      expect(notices()[0]!.textContent).not.toContain('Claim column');
      expect(targetPicker(host, 'Strong target for any request').disabled).toBe(true);
      expect(targetPicker(host, 'Cheap target for vision').disabled).toBe(true);
      expect(buttonByText(targetsCell(host, 'vision', 'cheap'), 'Clear')!.disabled).toBe(true);
      expect(targetPicker(host, 'Claim target for code').disabled).toBe(false);

      // A claim write too: still ONE notice, now naming both, and the Claim column pauses.
      store.setState('wt', 'unverified', true);
      await flush();
      expect(notices()).toHaveLength(1);
      expect(notices()[0]!.textContent).toContain('Claim column');
      expect(targetPicker(host, 'Claim target for code').disabled).toBe(true);

      // Retry is the reconcile: it re-lists the rules and, once that commits, clears both.
      const lists = fake.calls.filter((c) => c === 'listRules').length;
      buttonByText(notices()[0]!, 'Retry')!.click();
      await flush();
      expect(fake.calls.filter((c) => c === 'listRules').length).toBeGreaterThan(lists);
      expect(notices()).toHaveLength(0);
      expect(targetPicker(host, 'Strong target for any request').disabled).toBe(false);
      expect(targetPicker(host, 'Claim target for code').disabled).toBe(false);
    } finally {
      dispose();
    }
  });

  it('body-capture card: consent-gated enable flips the badge; master-kill copy (add-body-capture)', async () => {
    const { host, dispose } = mount();
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Settings');
      await flush();
      const card = () =>
        [...host.querySelectorAll<HTMLElement>('.panel')].find((p) =>
          p.textContent?.includes('Prompt & response bodies'),
        )!;
      expect(card().textContent).toContain('Metadata-only'); // off = green truth
      expect(card().textContent).toContain('Off by default');
      // Picking a capture mode opens the consent modal — nothing applies yet.
      const radio = [...card().querySelectorAll<HTMLInputElement>('input[type=radio]')][2]!; // All requests
      radio.click();
      await flush();
      const modal = host.querySelector<HTMLElement>('[aria-label="Confirm body capture"]');
      expect(modal).not.toBeNull();
      expect(modal!.textContent).toContain('secrets');
      expect(card().textContent).toContain('Metadata-only'); // still off pre-consent
      [...modal!.querySelectorAll<HTMLElement>('button')]
        .find((b) => labelText(b) === 'Capture bodies')!
        .click();
      await flush();
      expect(card().textContent).toContain('Bodies captured'); // amber, honest
      // Disable offers keep-or-purge.
      [...card().querySelectorAll<HTMLInputElement>('input[type=radio]')][0]!.click();
      await flush();
      const off = host.querySelector<HTMLElement>('[aria-label="Disable body capture"]');
      expect(off).not.toBeNull();
      [...off!.querySelectorAll<HTMLElement>('button')]
        .find((b) => labelText(b) === 'Keep until retention')!
        .click();
      await flush();
      expect(card().textContent).toContain('Metadata-only');
      expect(card().textContent).toContain('Inert while capture is off'); // overrides = master kill
    } finally {
      dispose();
    }
  });

  it('inspector Payload: lazy fetch, truncation notice, delete collapses; absent rows unchanged (add-body-capture)', async () => {
    const { host, store, dispose } = mount();
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Requests');
      await flush();
      const rows = host.querySelectorAll<HTMLElement>('.req-row');
      rows[0]?.click(); // req-000: hasBodies fixture
      await flush();
      const drawer = () => host.querySelector<HTMLElement>('.drawer')!;
      expect(drawer().textContent).toContain('Payload');
      expect(drawer().textContent).not.toContain('prompt for req-000'); // lazy — not yet fetched
      [...drawer().querySelectorAll<HTMLElement>('button')]
        .find((b) => labelText(b) === 'Show bodies')!
        .click();
      await flush();
      expect(drawer().textContent).toContain('prompt for req-000');
      expect(drawer().textContent).toContain('answer for req-000');
      // Delete asks first (adopt-red-destructive-actions task 4.5); its commit removes the
      // payloads and the section (hasBodies flips).
      [...drawer().querySelectorAll<HTMLElement>('button')]
        .find((b) => labelText(b) === 'Delete')!
        .click();
      await flush();
      expect(drawer().textContent).toContain('Payload');
      host
        .querySelector<HTMLElement>('[role="dialog"].confirm-card button.btn-destructive')!
        .click();
      await flush();
      expect(drawer().textContent).not.toContain('Payload');
      expect(store.state.requestList[0]?.hasBodies).toBe(false);
      // A row with no stored bodies renders no Payload section at all.
      host.querySelector<HTMLElement>('.overlay')?.click();
      rows[1]?.click();
      await flush();
      expect(store.state.requestList[1]?.hasBodies).toBe(false);
      expect(drawer().textContent).not.toContain('Payload');
    } finally {
      dispose();
    }
  });

  it('Settings pricing-catalog panel: status, never-refreshed callout, refresh flow (add-pricing-refresh-ui)', async () => {
    const { host, dispose } = mount(); // DEFAULT_SESSION is an admin
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Settings');
      await flush();
      const panel = () =>
        [...host.querySelectorAll<HTMLElement>('.panel')].find((p) =>
          p.textContent?.includes('Pricing catalog'),
        );
      const text = () => panel()?.textContent ?? '';
      expect(text()).toContain('67 models');
      expect(text()).toContain('newest: bundled');
      expect(text()).toContain('never'); // the literal never-refreshed callout
      expect(text()).toContain('scheduled — 30 4 * * * (UTC)'); // cadence-neutral copy (r3-Low-7)
      expect(text()).toContain('recorded costs never change');
      const btn = [...panel()!.querySelectorAll<HTMLElement>('button')].find(
        (b) => labelText(b) === 'Refresh now',
      );
      btn?.click();
      await flush();
      expect(text()).not.toContain('Last refreshed: never');
      expect(text()).toContain('+124');
    } finally {
      dispose();
    }
  });

  it('pricing panel branches: +0 toast, empty catalog, opted-out line, refresh error (add-pricing-refresh-ui)', async () => {
    // +0 completion is a SUCCESS with its own honest toast.
    const zero = new FakeApiClient({ pricingRefreshAdded: 0 });
    const a = mount(createAppStore(zero));
    try {
      await flush();
      clickByText(a.host, '.nav-item span', 'Settings');
      await flush();
      const btn = [...a.host.querySelectorAll<HTMLElement>('button')].find(
        (b) => labelText(b) === 'Refresh now',
      );
      btn?.click();
      await flush();
      expect(a.store.state.toast).toEqual({ kind: 'confirm', text: '+0 — no changes' });
      expect(a.host.textContent).not.toContain('Last refreshed: never');
    } finally {
      a.dispose();
    }
    // Empty catalog → neutral copy, no diagnosed cause.
    const empty = new FakeApiClient({
      pricingStatus: { ...DEFAULT_PRICING_STATUS, entryCount: 0, newest: null },
    });
    const b = mount(createAppStore(empty));
    try {
      await flush();
      clickByText(b.host, '.nav-item span', 'Settings');
      await flush();
      expect(b.host.textContent).toContain('Catalog is empty; pricing is unavailable.');
    } finally {
      b.dispose();
    }
    // Opted out → the off state names the flag; refresh failure → inline
    // report, the button itself re-enabled as the retry.
    const err = new FakeApiClient({
      pricingStatus: {
        ...DEFAULT_PRICING_STATUS,
        scheduler: {
          configuredEnabled: false,
          modePermitted: true,
          effectiveEnabled: false,
          cron: '30 4 * * *',
        },
      },
    });
    err.pricingRefresh = () => Promise.reject(new ApiError(502, 'BadGateway', 'source down'));
    const c = mount(createAppStore(err));
    try {
      await flush();
      clickByText(c.host, '.nav-item span', 'Settings');
      await flush();
      expect(c.host.textContent).toContain('off — PRICING_REFRESH_SCHED_ENABLED=false is set');
      const btn = [...c.host.querySelectorAll<HTMLElement>('button')].find(
        (x) => labelText(x) === 'Refresh now',
      );
      btn?.click();
      await flush();
      expect(c.host.textContent).toContain('Refresh failed — source down');
      expect((btn as HTMLButtonElement).disabled).toBe(false); // the retry IS the button
    } finally {
      c.dispose();
    }
  });

  it('the pricing panel hides for non-admins and drops the button in cloud mode', async () => {
    // Non-admin: no panel at all.
    const nonAdmin = new FakeApiClient({
      session: { ...DEFAULT_SESSION, role: null },
    });
    const a = mount(createAppStore(nonAdmin));
    try {
      await flush();
      clickByText(a.host, '.nav-item span', 'Settings');
      await flush();
      expect(a.host.textContent).not.toContain('Pricing catalog');
    } finally {
      a.dispose();
    }
    // Cloud admin: read-only status, no doomed button.
    const cloud = new FakeApiClient({
      pricingStatus: {
        ...DEFAULT_PRICING_STATUS,
        scheduler: {
          configuredEnabled: true,
          modePermitted: false,
          effectiveEnabled: false,
          cron: '30 4 * * *',
        },
      },
    });
    const b = mount(createAppStore(cloud));
    try {
      await flush();
      clickByText(b.host, '.nav-item span', 'Settings');
      await flush();
      const panel = [...b.host.querySelectorAll<HTMLElement>('.panel')].find((p) =>
        p.textContent?.includes('Pricing catalog'),
      );
      expect(panel?.textContent).toContain('unavailable in cloud mode');
      expect(
        [...(panel?.querySelectorAll<HTMLElement>('button') ?? [])].some(
          (x) => labelText(x) === 'Refresh now',
        ),
      ).toBe(false);
    } finally {
      b.dispose();
    }
  });

  it('renders Self-calibration: toggle, thresholds line, revert only when calibrated, history', async () => {
    const fake = new FakeApiClient({
      tiers: [DEFAULT_TIER],
      autoLayers: {
        structural: true,
        cascade: true,
        structuralAvailable: true,
        cascadeAvailable: true,
        semantic: false,
        semanticAvailable: false,
        semanticLearning: false,
        semanticLearningAvailable: false,
        calibration: {
          enabled: true,
          calibratedHigh: 0.58,
          calibratedLow: 0.27,
          instanceHigh: 0.6,
          instanceLow: 0.25,
          effectiveHigh: 0.58,
          effectiveLow: 0.27,
          agents: [],
          tenantPairStarved: null,
        },
      },
      calibrationEvents: [
        {
          id: 'ev1',
          trigger: 'calibrator',
          oldHigh: 0.6,
          oldLow: 0.27,
          newHigh: 0.58,
          newLow: 0.27,
          anchorHigh: 0.6,
          anchorLow: 0.25,
          windowFrom: null,
          windowTo: null,
          edge: 'high',
          edgeSamples: 57,
          edgeFailures: 43,
          reason: 'r',
          createdAt: '2026-07-19T04:00:00.000Z',
        },
      ],
    });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      await openTab(host, 'Auto routing');
      await openTuning(host, 'calibration'); // the card is the Self-calibration drawer's
      const text = host.textContent ?? '';
      expect(text).toContain('Self-calibration');
      expect(text).toContain('high 0.58 · low 0.27');
      expect(text).toContain('calibrated');
      expect(text).toContain('Revert to defaults');
      expect(text).toContain('0.6 to 0.58 (high)');
      expect(text).toContain('57 samples · 75% failed');
      // Revert: one click clears the pair; the section returns to defaults.
      const btn = [...host.querySelectorAll<HTMLElement>('button')].find(
        (b) => labelText(b) === 'Revert to defaults',
      );
      btn?.click();
      await flush();
      expect(fake.calls).toContain('calibrationRevert');
      expect(host.textContent).toContain('instance defaults');
      expect(host.textContent).not.toContain('Revert to defaults');
    } finally {
      dispose();
    }
  });

  it('Self-calibration lists per-agent pairs with their own revert, and discloses a frozen tenant pair (add-per-agent-calibration)', async () => {
    const agent = (over: Partial<AgentCalibration>): AgentCalibration => ({
      id: 'a-x',
      name: 'x',
      calibratedHigh: null,
      calibratedLow: null,
      anchorHigh: null,
      anchorLow: null,
      epoch: 0,
      active: false,
      evidence: null,
      ...over,
    });
    const fake = new FakeApiClient({
      tiers: [DEFAULT_TIER],
      autoLayers: {
        structural: true,
        cascade: true,
        structuralAvailable: true,
        cascadeAvailable: true,
        semantic: false,
        semanticAvailable: false,
        semanticLearning: false,
        semanticLearningAvailable: false,
        calibration: {
          ...DEFAULT_CALIBRATION,
          enabled: true,
          calibratedHigh: 0.58,
          calibratedLow: 0.27,
          effectiveHigh: 0.58,
          effectiveLow: 0.27,
          tenantPairStarved: true,
          agents: [
            agent({ id: 'a-inherit', name: 'lobechat' }),
            agent({
              id: 'a-own',
              name: 'markus',
              calibratedHigh: 0.53,
              calibratedLow: 0.32,
              anchorHigh: 0.58,
              anchorLow: 0.27,
              epoch: 2,
              active: true,
              evidence: { highSamples: 30, lowSamples: 8 },
            }),
          ],
        },
      },
    });
    const { host, store, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      await openAutoTab(host);
      const detail = await openTuning(host, 'calibration');
      // The frozen tenant pair is disclosed, not presented as current.
      expect(detail.querySelector('[data-testid="tenant-pair-starved"]')?.textContent).toContain(
        'no longer being informed by the traffic it governs',
      );
      // Pair-holders first; an inheriting agent is named as a state, with no revert.
      const rows = () => [
        ...detail.querySelectorAll<HTMLElement>('[data-testid="agent-calibration-row"]'),
      ];
      expect(rows().map((r) => r.querySelector('span')?.textContent)).toEqual([
        'markus',
        'lobechat',
      ]);
      expect(rows()[0]!.textContent).toContain('high 0.53 · low 0.32');
      expect(rows()[0]!.textContent).toContain('anchored to 0.58 / 0.27');
      expect(rows()[1]!.textContent).toContain('inheriting');
      expect(rows()[1]!.querySelector('[data-testid="agent-revert"]')).toBeNull();
      expect(detail.textContent).toContain('1 inheriting this tenant');
      // The agent's revert touches that agent only: its row returns to inheriting.
      const revert = rows()[0]!.querySelector<HTMLButtonElement>('[data-testid="agent-revert"]')!;
      expect(revert.getAttribute('aria-label')).toBe('Revert markus to inherited thresholds');
      revert.click();
      await flush();
      expect(fake.calls).toContain('agentCalibrationRevert');
      expect(fake.calls).not.toContain('calibrationRevert');
      expect(
        store.state.autoLayers?.calibration.agents?.find((a) => a.id === 'a-own')?.active,
      ).toBe(false);
      const after = tuningDrawerOrNull(host, 'calibration')!;
      expect(after.querySelectorAll('[data-testid="agent-revert"]')).toHaveLength(0);
      expect(after.textContent).toContain('2 inheriting this tenant');
      // The tenant pair is untouched by an agent revert.
      expect(after.textContent).toContain('Revert to defaults');
    } finally {
      dispose();
    }
  });

  it('renders the Pipeline figures with rates, savings + coverage on the Cascade row, and a local range', async () => {
    const fake = new FakeApiClient({ tiers: [DEFAULT_TIER] });
    const { host, store, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      await openTab(host, 'Auto routing');
      // DEFAULT_AUTO_PERF: evaluated 40 on Classify; cascade 10 with 7 passed / 1 escalated.
      const pipeline = host.querySelector<HTMLElement>('[data-testid="auto-pipeline"]')!;
      expect(
        cellText(pipeline.querySelector('[data-stage="classify"] [data-testid="stage-figure"]')),
      ).toMatch(/^40 evaluated/);
      // Savings honesty contract: net + basis label + '· est.' + visible coverage —
      // and labelled as covering the residual cascade only, never all auto traffic. It
      // is the Cascade row's line, framed to the range — no longer a separate panel.
      expect(host.querySelector('[data-testid="auto-summary"]')).toBeNull();
      const savings = pipeline.querySelector<HTMLElement>(
        '[data-stage="cascade"] [data-testid="auto-savings"]',
      )!;
      expect(savings.textContent).toContain('Est. net savings · 7d');
      expect(savings.querySelector('.ar-savings-amount')?.textContent).toBe('$1.62');
      expect(savings.textContent).toContain('at today’s premium rate');
      expect(savings.textContent).toContain('· est.');
      expect(savings.textContent).toContain(
        'Covers only the residual cascade’s quality-passed requests — never all auto traffic',
      );
      expect(savings.textContent).toContain('based on 6 of 7 quality-passed requests');
      expect(savings.textContent).toContain('(some rows uncostable)');
      // No class-scoped band rules in the fixture → no basis disclosure (add-workload-scoped-bands).
      expect(host.querySelector('[data-testid="ap-basis-scoped"]')).toBeNull();
      // The four-way cascade split is the Cascade stage's.
      const cascade = await expandStage(host, 'Cascade');
      expect(cascade.textContent).toContain('quality-pass');
      expect(cascade.textContent).toContain('70%');
      expect(cascade.textContent).toContain('failed/cancelled before escalation');
      // Unroutable diagnostic (1 in the fixture, high band): the Default stage names
      // the AFFECTED band and points at its column in the Targets matrix
      // (cause-neutral — scoped to the detail so a target cell's keys can't satisfy it).
      const fallback = await expandStage(host, 'Default');
      const callout = fallback.querySelector<HTMLElement>('[data-testid="default-unroutable"]');
      expect(callout?.textContent).toContain('strong (auto_high)');
      expect(callout?.textContent).not.toContain('cheap (auto_low)');
      // Names the matrix and its column, never a position (a cross-reference names its target).
      expect(callout?.textContent).toContain('the Targets matrix’s Strong column');
      expect(callout?.textContent).not.toMatch(/above|below/);
      // The tab's range control is LOCAL: clicking 30d must not move the global
      // Observe range (24h default), only autoPerf.range.
      expect(store.state.autoPerf.range).toBe('7d');
      const globalBefore = store.state.range;
      const range = host.querySelector<HTMLElement>('[data-testid="auto-range"]');
      if (!range) throw new Error('the tab range control is missing');
      expect(range.getAttribute('role')).toBe('group');
      const btn = [...range.querySelectorAll<HTMLElement>('button')].find(
        (b) => labelText(b) === '30d',
      );
      if (!btn) throw new Error('30d range button missing');
      btn.click();
      await flush();
      expect(store.state.autoPerf.range).toBe('30d');
      expect(store.state.range).toBe(globalBefore);
      // Every figure is framed to the new range.
      expect(host.querySelector('[data-testid="auto-pipeline"]')?.textContent).toContain(
        'in the selected 30d range',
      );
      expect(fake.calls.filter((c) => c === 'autoPerformance').length).toBeGreaterThanOrEqual(2);
    } finally {
      dispose();
    }
  });

  it('Auto performance renders the semantic slice + residual-cascade footnote (add-semantic-dashboard 3.2)', async () => {
    const fake = new FakeApiClient({ tiers: [DEFAULT_TIER] });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      await openTab(host, 'Auto routing');
      // DEFAULT_AUTO_PERF.semantic: evaluated 8, routed 5 (3 high / 2 low),
      // source 2 learned / 6 bundled, outcomes 3/1/1/0 — in the Semantic stage.
      const semantic = (await expandStage(host, 'Semantic')).textContent ?? '';
      expect(semantic).toContain('L2 evaluated');
      expect(semantic).toContain('L2 routed');
      expect(semantic).toContain('3 high / 2 low');
      expect(semantic).toContain('learned');
      expect(semantic).toContain('bundled');
      // Routed traffic ⇒ residual-cascade labeling + the denominator footnote, on the
      // Cascade stage's split — and the note names the focal figure, not a position.
      const cascade = await expandStage(host, 'Cascade');
      expect(cascade.textContent).toContain('residual cascade');
      const note = cascade.querySelector('[data-testid="ap-residual-note"]')?.textContent ?? '';
      expect(note).toContain('never enter the cascade');
      expect(note).toContain('the Cascade row’s savings line');
      expect(note).not.toMatch(/above|below/);
    } finally {
      dispose();
    }
  });

  it('Auto performance discloses the GENERIC savings basis when class-scoped band rules exist (add-workload-scoped-bands)', async () => {
    const fake = new FakeApiClient({
      tiers: [DEFAULT_TIER],
      autoPerf: {
        ...DEFAULT_AUTO_PERF,
        savings: {
          ...DEFAULT_AUTO_PERF.savings!,
          basis: { ...DEFAULT_AUTO_PERF.savings!.basis, scoped: true },
        },
      },
    });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      await openTab(host, 'Auto routing');
      const note = host.querySelector<HTMLElement>('[data-testid="ap-basis-scoped"]');
      expect(note).not.toBeNull();
      expect(note!.textContent).toContain('basis = the generic strong target');
      expect(note!.textContent).toContain('class-scoped traffic is not separated');
    } finally {
      dispose();
    }
  });

  it('Band targets: a failed SCOPED write shows its error under the scoped row, never under the generic one (add-workload-scoped-bands)', async () => {
    const fake = new FakeApiClient({
      tiers: [DEFAULT_TIER],
      tierEntries: { t1: [mkEntry('m1', 0)] },
      models: { p1: [mkModel('m1')] },
      rules: [
        {
          id: 'g-high',
          matchType: 'auto_high',
          workloadClass: null,
          headerName: 'x-polyrouter-tier',
          headerValue: null,
          target: 'tier:default',
          priority: 0,
          createdAt: NOW,
        },
      ],
    });
    fake.createRule = () => Promise.reject(new ApiError(422, 'Unprocessable', 'bad scoped target'));
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      await openTab(host, 'Auto routing');
      const low = () => targetsCell(host, 'code', 'cheap');
      // Set the code Cheap cell (no code rule exists → create → the server rejects it).
      const picker = targetPicker(host, 'Cheap target for code');
      picker.value = 'tier:default';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
      const err = low().querySelector<HTMLElement>('[data-testid="cell-error"]');
      expect(err).not.toBeNull();
      expect(err!.textContent).toContain('bad scoped target');
      // Exactly ONE rendering of the message in the whole matrix — the Any request Cheap
      // cell, and every other class's Cheap cell, are clean.
      const matrix = targetsMatrix(host);
      expect(matrix.textContent.split('bad scoped target').length - 1).toBe(1);
      expect(matrix.querySelectorAll('[data-testid="cell-error"]')).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  it('Auto performance hides the semantic row when nothing was evaluated — zero-data honesty (add-semantic-dashboard 3.2)', async () => {
    const fake = new FakeApiClient({
      tiers: [DEFAULT_TIER],
      autoPerf: {
        ...DEFAULT_AUTO_PERF,
        semantic: {
          evaluated: 0,
          routed: { high: 0, low: 0 },
          outcomes: { success: 0, fallback: 0, error: 0, cancelled: 0 },
          source: { bundled: 0, learned: 0 },
        },
      },
    });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      await openTab(host, 'Auto routing');
      // No fabricated zeros: the slice is stated as empty, never drawn as measured 0s…
      const semantic = await expandStage(host, 'Semantic');
      const slice = semantic.querySelector('[data-testid="ap-semantic-slice"]')?.textContent ?? '';
      expect(slice).not.toContain('L2 evaluated');
      expect(slice).toContain('Nothing reached Layer 2 in this range.');
      // …and no residual labeling of the cascade split when nothing was routed.
      const cascade = await expandStage(host, 'Cascade');
      const split = cascade.querySelector('[data-testid="ap-cascade"]')?.textContent ?? '';
      expect(split).toContain('quality-pass'); // the split itself still renders
      expect(split).not.toContain('residual cascade');
      expect(cascade.querySelector('[data-testid="ap-residual-note"]')).toBeNull();
    } finally {
      dispose();
    }
  });

  it('provider patience fields: server-fetched placeholders, set + clear round-trip (fix-long-call-timeouts)', async () => {
    const fake = new FakeApiClient({
      providers: [
        {
          id: 'prov-1',
          name: 'OpenRouter',
          kind: 'api_key',
          protocol: 'openai_compatible',
          baseUrl: 'https://openrouter.ai/api/v1',
          status: 'ok',
          maxTokensSpelling: 'auto',
          hasCredential: true,
          oauthPreset: null,
          credentialExpiresAt: null,
          credentialError: null,
          firstByteTimeoutMs: null,
          idleTimeoutMs: null,
          createdAt: '2026-07-15T00:00:00.000Z',
          ...UNRECORDED_HEALTH,
        },
      ],
    });
    const { host, store, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Providers');
      await flush();
      // Edit the first provider — the modal's advanced section shows the
      // SERVER default as the placeholder (never a hard-coded value).
      const editBtn = [...host.querySelectorAll<HTMLElement>('button')].find(
        (b) => labelText(b) === 'Edit',
      );
      if (!editBtn) throw new Error('provider Edit button missing');
      editBtn.click();
      await flush();
      const fb = host.querySelector<HTMLInputElement>('#f-np-firstbyte');
      expect(fb).not.toBeNull();
      expect(fb!.placeholder).toContain('30 · instance default'); // fake default 30000ms
      expect(fake.calls).toContain('providerTimeoutDefaults');
      // Set 1800s and save → the PATCH carries ms; idle stays blank → null (inherit).
      fb!.value = '1800';
      fb!.dispatchEvent(new Event('input', { bubbles: true }));
      clickByText(host, 'button', 'Save changes');
      await flush();
      const edited = store.state.providers[0]!;
      expect(edited.firstByteTimeoutMs).toBe(1_800_000);
      expect(edited.idleTimeoutMs).toBeNull();
      // Re-open: the field shows the stored seconds; blanking it clears to inherit.
      [...host.querySelectorAll<HTMLElement>('button')]
        .find((b) => labelText(b) === 'Edit')!
        .click();
      await flush();
      const fb2 = host.querySelector<HTMLInputElement>('#f-np-firstbyte')!;
      expect(fb2.value).toBe('1800');
      fb2.value = '';
      fb2.dispatchEvent(new Event('input', { bubbles: true }));
      clickByText(host, 'button', 'Save changes');
      await flush();
      expect(store.state.providers[0]!.firstByteTimeoutMs).toBeNull();
    } finally {
      dispose();
    }
  });

  it('Auto performance refreshes on every page visit, not just the first (stale-card bug)', async () => {
    const fake = new FakeApiClient({ tiers: [DEFAULT_TIER] });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      await openTab(host, 'Auto routing');
      const first = fake.calls.filter((c) => c === 'autoPerformance').length;
      expect(first).toBeGreaterThanOrEqual(1);
      clickByText(host, '.nav-item span', 'Requests'); // leave…
      await flush();
      clickByText(host, '.nav-item span', 'Routing'); // …and return
      await flush();
      // A revisit refetches (stale-while-revalidate: old data stayed visible). The
      // remembered tab is Auto routing, so the revisit shows it — and that first show
      // of the visit is what fetches (redesign-auto-routing-pipeline D5).
      expect(fake.calls.filter((c) => c === 'autoPerformance').length).toBeGreaterThan(first);
      expect(host.querySelector('[data-testid="auto-pipeline"]')).not.toBeNull();
    } finally {
      dispose();
    }
  });

  it('shows only header rules in the Header rules panel (auto rules stay read-only)', async () => {
    const rules: RuleDto[] = [
      {
        id: 'r-hdr',
        matchType: 'header',
        workloadClass: null,
        headerName: 'x-polyrouter-tier',
        headerValue: 'heavy',
        target: 'tier:heavy',
        priority: 0,
        createdAt: NOW,
      },
      {
        id: 'r-auto',
        matchType: 'auto_high',
        workloadClass: null,
        headerName: 'x-polyrouter-tier',
        headerValue: null,
        target: 'model:auto-band-xyz',
        priority: 0,
        createdAt: NOW,
      },
    ];
    const fake = new FakeApiClient({ tiers: [DEFAULT_TIER], rules });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      // The header-rules card is on Tiers & headers, where the visit lands.
      expect(host.textContent).toContain('tier:heavy'); // the header rule is shown + deletable
      // The auto rule stays OUT of the Header-rules panel — but IS now presented by the
      // Targets matrix's Any request Strong cell (add-band-target-ui), as unresolved here.
      const headerPanel = [...host.querySelectorAll<HTMLElement>('.panel')].find((p) =>
        p.textContent?.includes('Header rules'),
      );
      expect(headerPanel?.textContent).not.toContain('auto-band-xyz');
      // The matrix sits on the Auto routing tab — switch rather than drop the half of
      // this test that proves the auto rule surfaces there.
      await openTab(host, 'Auto routing');
      const strong = targetsCell(host, 'any', 'strong');
      expect(strong.textContent).toContain('model:auto-band-xyz');
      expect(strong.textContent).toContain('Target unresolved');
    } finally {
      dispose();
    }
  });

  it('renders a failed channel test-send result inline in Settings', async () => {
    const channel: ChannelDto = {
      id: 'chan-1',
      name: 'homelab email',
      kind: 'smtp',
      enabled: true,
      eventsSubscribed: ['budget_alert'],
      hasConfig: true,
      lastTestAt: null,
      lastTestStatus: null,
    };
    const fake = new FakeApiClient({
      channels: [channel],
      channelTestResult: { ok: false, error: 'smtp_auth' },
    });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Settings');
      await flush();
      clickByText(host, '.btn-ghost', 'Send test');
      await flush();
      expect(host.textContent).toContain('test failed — smtp_auth');
    } finally {
      dispose();
    }
  });
});

describe('Routing tabs (redesign-auto-routing-pipeline)', () => {
  /** Everything the Routing page can write. The tab control touches none of it. */
  const ROUTING_WRITES = [
    'createTier',
    'updateTier',
    'deleteTier',
    'replaceTierEntries',
    'createRule',
    'updateRule',
    'deleteRule',
    'setAutoLayers',
    'calibrationRevert',
    'semanticLearningRevert',
  ];
  const writesOf = (fake: FakeApiClient): string[] =>
    fake.calls.filter((c) => ROUTING_WRITES.includes(c));
  const fetchesOf = (fake: FakeApiClient): number =>
    fake.calls.filter((c) => c === 'autoPerformance').length;

  const tabsFake = (
    over: Partial<AutoLayers> = {},
    chain: { models?: string[]; entries?: string[] } = {},
  ): FakeApiClient =>
    new FakeApiClient({
      tiers: [DEFAULT_TIER],
      models: { p1: (chain.models ?? ['m1', 'm2', 'm3']).map(mkModel) },
      tierEntries: { t1: (chain.entries ?? ['m1', 'm2', 'm3']).map((m, i) => mkEntry(m, i)) },
      autoLayers: {
        structural: true,
        cascade: true,
        structuralAvailable: true,
        cascadeAvailable: true,
        semantic: false,
        semanticAvailable: false,
        semanticLearning: false,
        semanticLearningAvailable: false,
        calibration: DEFAULT_CALIBRATION,
        ...over,
      },
    });

  const openRouting = async (host: HTMLElement): Promise<void> => {
    clickByText(host, '.nav-item span', 'Routing');
    await flush();
  };
  const segments = (host: HTMLElement): HTMLButtonElement[] => [
    ...host.querySelectorAll<HTMLButtonElement>('[data-testid="routing-sections"] .rs-seg'),
  ];
  const labels = (host: HTMLElement): string[] => segments(host).map((b) => labelText(b) ?? '');
  const pressed = (host: HTMLElement): string[] =>
    segments(host)
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
      .map((b) => labelText(b) ?? '');
  /** The Targets matrix, or null when it is not rendered — for absence assertions
   * (`targetsMatrix` throws instead, for presence). */
  const matrixOrNull = (host: HTMLElement): HTMLElement | null =>
    host.querySelector<HTMLElement>('[data-testid="targets-matrix"]');
  /** Each card's title, in DOM order — the tab's panels and the blocks inside its
   * stage details alike. */
  const panels = (host: HTMLElement): string[] =>
    [...host.querySelectorAll<HTMLElement>('.rs-page .section-title')].map(
      (t) => labelText(t) ?? '',
    );
  /** The first tier card's chain, in DOM order. */
  const chainRows = (host: HTMLElement): HTMLElement[] => [
    ...(host
      .querySelector<HTMLElement>('[data-tier-id="t1"]')
      ?.querySelectorAll<HTMLElement>('.chain-row') ?? []),
  ];
  const order = (host: HTMLElement): string[] =>
    chainRows(host).map((r) => r.dataset['modelId'] ?? '?');
  const replacements = (fake: FakeApiClient): string[][] =>
    fake.callLog
      .filter((c) => c.method === 'replaceTierEntries')
      .map((c) => (c.args[1] as { modelId: string }[]).map((e) => e.modelId));

  it('lands on Tiers & headers with ONLY the Layer-0 content mounted', async () => {
    const fake = tabsFake();
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      await openRouting(host);
      const group = host.querySelector<HTMLElement>('[data-testid="routing-sections"]');
      expect(group?.getAttribute('role')).toBe('group');
      expect(group?.getAttribute('aria-label')).not.toBe('');
      expect(labels(host)).toEqual(['Tiers & headers', 'Auto routing']);
      expect(pressed(host)).toEqual(['Tiers & headers']);
      // The selected state is programmatic on every segment, not only the active one.
      expect(segments(host).map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
      // The tier chains, the add-tier header and the header-rules card are here…
      const text = host.textContent ?? '';
      expect(host.querySelector('[data-tier-id="t1"]')).not.toBeNull();
      expect(text).toContain('New tier key');
      expect(text).toContain('Add tier');
      expect(text).toContain('Header rules');
      // …the first panel is still a tier card (the chain suites rely on it)…
      expect(host.querySelector('.panel')?.getAttribute('data-tier-id')).toBe('t1');
      // …and nothing from Auto routing is in the DOM at all (unmounted, not hidden).
      expect(host.querySelector('[data-testid="auto-pipeline"]')).toBeNull();
      expect(host.querySelector('[data-testid="auto-setup"]')).toBeNull();
      expect(matrixOrNull(host)).toBeNull();
      expect(host.querySelector('[aria-label="Strong target for any request"]')).toBeNull();
      expect(host.querySelector('[aria-label="Toggle L1 · Structural"]')).toBeNull();
      // A visit that never shows Auto routing never needs its aggregation.
      expect(fetchesOf(fake)).toBe(0);
    } finally {
      dispose();
    }
  });

  it('swaps the page body on a switch and writes nothing', async () => {
    const fake = tabsFake();
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      await openRouting(host);
      const before = writesOf(fake);

      await openTab(host, 'Auto routing');
      expect(pressed(host)).toEqual(['Auto routing']);
      expect(host.querySelector('[data-testid="auto-pipeline"]')).not.toBeNull();
      expect(matrixOrNull(host)).not.toBeNull();
      expect(host.querySelector('[data-testid="auto-setup"]')).not.toBeNull();
      // The Layer-0 content left with its tab.
      expect(host.textContent).not.toContain('New tier key');
      expect(host.textContent).not.toContain('Header rules');
      expect(host.querySelector('[data-tier-id]')).toBeNull();

      await openTab(host, 'Tiers & headers');
      expect(pressed(host)).toEqual(['Tiers & headers']);
      expect(host.textContent).toContain('Header rules');
      expect(host.querySelector('[data-tier-id="t1"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="auto-pipeline"]')).toBeNull();

      // A switch is presentation only: no routing configuration is written.
      expect(writesOf(fake)).toEqual(before);
    } finally {
      dispose();
    }
  });

  it('offers both tabs when the structural capability is unavailable — never selectable-but-empty', async () => {
    const fake = tabsFake({
      structural: false,
      structuralAvailable: false,
      cascadeAvailable: false,
    });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      await openRouting(host);
      expect(labels(host)).toEqual(['Tiers & headers', 'Auto routing']);
      await openTab(host, 'Auto routing');
      expect(pressed(host)).toEqual(['Auto routing']);
      // The layers still render, each explaining its own absence…
      expect(host.querySelector('[aria-label="Toggle L1 · Structural"]')).not.toBeNull();
      expect(host.textContent).toContain('off instance-wide');
      // …while every target and measured figure is absent, and nothing was fetched.
      expect(matrixOrNull(host)).toBeNull();
      expect(host.querySelector('[aria-label="Strong target for any request"]')).toBeNull();
      expect(host.querySelector('[data-testid="auto-range"]')).toBeNull();
      expect(host.querySelectorAll('[data-testid="stage-figure"]')).toHaveLength(0);
      expect(fetchesOf(fake)).toBe(0);
    } finally {
      dispose();
    }
  });

  it('hands focus to the tab control when an availability flip unmounts the focused content', async () => {
    const store = createAppStore(tabsFake());
    const { host, dispose } = mount(store);
    try {
      await flush();
      await openRouting(host);
      await openTab(host, 'Auto routing');
      // A Targets matrix picker — content gated on the structural capability. Focus it,
      // as a keyboard user working there would.
      const picker = host.querySelector<HTMLSelectElement>('.rs-page select');
      expect(picker).not.toBeNull();
      expect(targetsMatrix(host).contains(picker)).toBe(true);
      picker!.focus();
      expect(document.activeElement).toBe(picker);

      // The capability goes away underneath the user (a re-poll of auto-layers): the
      // focused picker leaves the DOM, which would otherwise drop focus to <body>.
      store.setState('autoLayers', 'structuralAvailable', false);
      await flush();
      expect(picker!.isConnected).toBe(false);
      const focused = document.activeElement as HTMLElement;
      expect(focused).not.toBe(document.body);
      expect(labelText(focused)).toBe('Auto routing');
      expect(focused.getAttribute('aria-pressed')).toBe('true');
      expect(focused.closest('[data-testid="routing-sections"]')).not.toBeNull();
    } finally {
      dispose();
    }
  });

  it('leaves focus alone on a flip when it was not inside the unmounted content', async () => {
    const store = createAppStore(tabsFake());
    const { host, dispose } = mount(store);
    try {
      await flush();
      await openRouting(host);
      await openTab(host, 'Auto routing');
      // Focus on a control that survives the flip — and is not the segment the guard
      // would pick — must stay exactly where the user put it.
      const tiers = segments(host).find((b) => labelText(b) === 'Tiers & headers')!;
      tiers.focus();
      store.setState('autoLayers', 'structuralAvailable', false);
      await flush();
      expect(document.activeElement).toBe(tiers);
    } finally {
      dispose();
    }
  });

  it('remembers the tab across in-app navigation without touching the URL; a reload lands on Tiers & headers', async () => {
    const store = createAppStore(tabsFake());
    const first = mount(store);
    try {
      await flush();
      await openRouting(first.host);
      expect(window.location.hash).toBe('#/routing');
      await openTab(first.host, 'Auto routing');
      expect(window.location.hash).toBe('#/routing'); // no `/auto` suffix is invented
      clickByText(first.host, '.nav-item span', 'Requests');
      await flush();
      clickByText(first.host, '.nav-item span', 'Routing');
      await flush();
      expect(window.location.hash).toBe('#/routing');
      expect(pressed(first.host)).toEqual(['Auto routing']);
      expect(first.host.querySelector('[data-testid="auto-pipeline"]')).not.toBeNull();
    } finally {
      first.dispose();
    }
    // A full reload is a fresh store: the choice was in memory only.
    const reloaded = mount(createAppStore(tabsFake()));
    try {
      await flush();
      await openRouting(reloaded.host);
      expect(window.location.hash).toBe('#/routing');
      expect(pressed(reloaded.host)).toEqual(['Tiers & headers']);
    } finally {
      reloaded.dispose();
    }
  });

  it('fetches the aggregation on the first show per visit: a round-trip does not refetch, a revisit does', async () => {
    const fake = tabsFake();
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      await openRouting(host);
      expect(fetchesOf(fake)).toBe(0); // landed on Tiers & headers
      await openTab(host, 'Auto routing');
      expect(fetchesOf(fake)).toBe(1);
      // What the fetch feeds is on screen (DEFAULT_AUTO_PERF: 1 unroutable, high band).
      // The unroutable count is the Pipeline's, never a matrix cell's.
      expect(targetsMatrix(host).textContent).not.toContain('unroutable in the selected');

      await openTab(host, 'Tiers & headers');
      await openTab(host, 'Auto routing');
      expect(fetchesOf(fake)).toBe(1); // a tab round-trip keeps this visit's figures

      clickByText(host, '.nav-item span', 'Requests'); // leave…
      await flush();
      clickByText(host, '.nav-item span', 'Routing'); // …and return, on the remembered tab
      await flush();
      expect(fetchesOf(fake)).toBe(2);

      // A revisit that stays on Tiers & headers does not fetch until the tab shows.
      await openTab(host, 'Tiers & headers');
      clickByText(host, '.nav-item span', 'Requests');
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      expect(fetchesOf(fake)).toBe(2);
      await openTab(host, 'Auto routing');
      expect(fetchesOf(fake)).toBe(3);
    } finally {
      dispose();
    }
  });

  it('persists the final order of a keyboard burst left mid-flight by a tab switch', async () => {
    const fake = tabsFake(
      {},
      { models: ['m1', 'm2', 'm3', 'm4'], entries: ['m1', 'm2', 'm3', 'm4'] },
    );
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      await openRouting(host);
      fake.deferTierWrites = true;
      // Walk m1 to the bottom, faster than a write completes: the first PUT goes out,
      // the rest coalesce in the store behind it.
      for (let i = 0; i < 3; i++) {
        const handle = chainRows(host)[i]!.querySelector<HTMLElement>('.drag-handle')!;
        handle.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }),
        );
        await flush();
      }
      expect(order(host)).toEqual(['m2', 'm3', 'm4', 'm1']);

      // Leave the tab with the burst unwritten — the chains unmount.
      await openTab(host, 'Auto routing');
      expect(host.querySelector('[data-tier-id]')).toBeNull();
      let guard = 0;
      while (fake.tierWriteQueue.length > 0 && guard++ < 6) {
        fake.tierWriteQueue.shift()?.settle('resolve');
        await flush();
      }
      expect(replacements(fake).at(-1)).toEqual(['m2', 'm3', 'm4', 'm1']);

      // Coming back shows the server's order — the burst's final order.
      await openTab(host, 'Tiers & headers');
      expect(order(host)).toEqual(['m2', 'm3', 'm4', 'm1']);
    } finally {
      dispose();
    }
  });

  it('abandons a live drag on a tab switch, exactly as a page teardown does', async () => {
    const fake = tabsFake();
    const { host, store, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      await openRouting(host);
      // happy-dom has no DragEvent; the handlers touch only these members (see
      // routingDrag.test.tsx). Rows 40px tall, so row i's midpoint is at 40i + 20.
      chainRows(host).forEach((row, i) => {
        row.getBoundingClientRect = (): DOMRect =>
          ({ top: i * 40, bottom: i * 40 + 40, height: 40 }) as DOMRect;
      });
      const fire = (el: HTMLElement, type: string, clientY?: number): void => {
        const ev = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'dataTransfer', {
          value: { effectAllowed: '', dropEffect: '', setData: () => undefined },
        });
        if (clientY !== undefined) Object.defineProperty(ev, 'clientY', { value: clientY });
        el.dispatchEvent(ev);
      };
      fire(chainRows(host)[0]!, 'dragstart');
      fire(chainRows(host)[2]!, 'dragover', 110); // past row 2's midpoint
      expect(order(host)).toEqual(['m2', 'm3', 'm1']); // the drag's local, unwritten move
      const before = writesOf(fake);

      await openTab(host, 'Auto routing');
      expect(writesOf(fake)).toEqual(before); // an abandoned drag writes nothing
      // The store's hold is released: a late completion from the vanished row is inert.
      store.endTierDrag('t1', 'changed');
      await flush();
      expect(writesOf(fake)).toEqual(before);

      // Returning shows the server's order, not the half-dragged one.
      await openTab(host, 'Tiers & headers');
      expect(order(host)).toEqual(['m1', 'm2', 'm3']);
    } finally {
      dispose();
    }
  });

  it('keeps every card intact across repeated tab switching (no card loses content)', async () => {
    const { host, dispose } = mount(createAppStore(tabsFake()));
    try {
      await flush();
      await openRouting(host);
      await openTab(host, 'Auto routing');
      // Stages start collapsed (a tab switch resets them), so open all five each time.
      await expandAllStages(host);
      const auto = panels(host);
      // Non-vacuous: the comparison below is over the real cards, in the tab's order —
      // self-calibration moved into a drawer opened from Setup, not out of the tab.
      expect(auto).toEqual(['Pipeline', 'Setup']);
      const blocks = (): string[] =>
        [...host.querySelectorAll<HTMLElement>('[data-testid="stage-detail"] [data-testid]')].map(
          (e) => e.dataset['testid'] ?? '',
        );
      const before = blocks();
      expect(before).toEqual(
        expect.arrayContaining(['ap-band-verdicts', 'calibration-evidence', 'workload-mix']),
      );
      for (let i = 0; i < 3; i++) {
        await openTab(host, 'Tiers & headers');
        await openTab(host, 'Auto routing');
      }
      expect(stageExpander(host, 'Classify').getAttribute('aria-expanded')).toBe('false');
      await expandAllStages(host);
      expect(panels(host)).toEqual(auto);
      expect(blocks()).toEqual(before);
      // The unroutable count is the Pipeline's, never a matrix cell's.
      expect(targetsMatrix(host).textContent).not.toContain('unroutable in the selected');
    } finally {
      dispose();
    }
  });

  const stageRows = (host: HTMLElement): HTMLElement[] => [
    ...host.querySelectorAll<HTMLElement>('[data-testid="pipeline-stage"]'),
  ];
  const stageRow = (host: HTMLElement, id: string): HTMLElement => {
    const row = host.querySelector<HTMLElement>(
      `[data-testid="pipeline-stage"][data-stage="${id}"]`,
    );
    if (!row) throw new Error(`no "${id}" stage row`);
    return row;
  };
  const squash = (t: string | null | undefined): string => (t ?? '').replace(/\s+/g, ' ').trim();

  it('renders the six stages in proxy order — switches only on 1, 4 and 5 — with disjoint counts that sum to evaluated', async () => {
    const fake = tabsFake();
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      await openRouting(host);
      await openTab(host, 'Auto routing');
      const rows = stageRows(host);
      expect(rows.map((r) => r.dataset['stage'])).toEqual([
        'classify',
        'workload',
        'band',
        'semantic',
        'cascade',
        'default',
      ]);
      expect(rows.map((r) => r.querySelector('.ar-num')?.textContent)).toEqual([
        '1',
        '2',
        '3',
        '4',
        '5',
        '6',
      ]);
      // No stage row carries a switch: the three layer switches are the Setup panel's
      // Layers cells', with their unchanged accessible names.
      expect(rows.map((r) => r.querySelector('[role="switch"]'))).toEqual([
        null,
        null,
        null,
        null,
        null,
        null,
      ]);
      expect(
        [...host.querySelectorAll('[data-testid="auto-layers"] [role="switch"]')].map((s) =>
          s.getAttribute('aria-label'),
        ),
      ).toEqual(['Toggle L1 · Structural', 'Toggle L2 · Semantic', 'Toggle L3 · Cascade']);
      expect(rows[0]!.textContent).toContain('L1 · Structural');
      expect(rows[3]!.textContent).toContain('L2 · Semantic');
      expect(rows[4]!.textContent).toContain('L3 · Cascade');
      // DEFAULT_AUTO_PERF exits {0, 22, 5, 10, 3} partition evaluated (40).
      expect(rows.map((r) => cellText(r.querySelector('[data-testid="stage-figure"]')))).toEqual([
        '40 evaluated verdicts: 12 high · 16 low · 12 ambiguous',
        '0 0% routed here',
        // This fake sets no band target, has L2 unavailable, and so no cascade pair: each
        // count is captioned as history rather than read as what the stage does now.
        '22 55% routed under earlier targets',
        '5 13% routed while on',
        '10 25% routed while it could run',
        '3 8% routed here',
      ]);
      // Each later stage draws its own bar, a zero exit an empty track; Classify none.
      expect(rows.map((r) => r.querySelector('[data-testid="stage-bar"] .ar-bar-fill'))).toEqual([
        null,
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      ]);
      expect(
        rows.map(
          (r) =>
            r.querySelector<HTMLElement>('[data-testid="stage-bar"] .ar-bar-fill')?.style.width ??
            null,
        ),
      ).toEqual([null, '0%', '55%', '12.5%', '25%', '7.5%']);
      // The list keeps its semantics: six items, the column header hidden from AT.
      const list = host.querySelector<HTMLElement>('[data-testid="auto-pipeline"] ol')!;
      expect(list.getAttribute('role')).toBe('list');
      expect(list.querySelectorAll(':scope > li:not([aria-hidden="true"])')).toHaveLength(6);
      // Every row names its fields in text — its status as now, its count as the range's.
      for (const r of rows) {
        expect([...r.querySelectorAll('.ar-fieldlabel')].map((l) => squash(l.textContent))).toEqual(
          ['Status now', 'Requests, 7d'],
        );
      }
      // Status now reads configuration, never a figure.
      expect(
        cellText(stageRow(host, 'band').querySelector('[data-testid="stage-status-now"]')),
      ).toBe('Strong to not set · Cheap to not set For requests no claim took');
      // Layer 0 decides first; unevaluated traffic is disclosed, not counted.
      const note = host.querySelector('[data-testid="layer0-note"]')?.textContent ?? '';
      expect(note).toContain('explicit model');
      expect(note).toContain('explicit tier');
      expect(note).toContain('x-polyrouter-tier');
      const foot = host.querySelector('[data-testid="pipeline-unevaluated"]')?.textContent ?? '';
      expect(foot).toContain('Layer 1 never evaluated');
      expect(foot).toContain('without being counted');
      expect(foot).toContain('selected 7d range');
    } finally {
      dispose();
    }
  });

  it('the Setup panel holds the tab’s only three switches (split-auto-routing-readout-setup 3.1)', async () => {
    const { host, dispose } = mount(
      createAppStore(tabsFake({ semantic: true, semanticAvailable: true })),
    );
    try {
      await flush();
      await openRouting(host);
      await openTab(host, 'Auto routing');
      const all = [...host.querySelectorAll<HTMLElement>('.rs-page [role="switch"]')];
      expect(all).toHaveLength(3);
      const layers = host.querySelector<HTMLElement>('[data-testid="auto-layers"]')!;
      for (const sw of all) expect(layers.contains(sw)).toBe(true);
      expect(host.querySelector('[data-testid="auto-pipeline"] [role="switch"]')).toBeNull();
      // One cell per layer, titled by its stage and naming its layer, with its state in text.
      const cells = [...layers.querySelectorAll<HTMLElement>('[data-testid="layer-cell"]')];
      expect(cells.map((c) => c.dataset['layer'])).toEqual(['structural', 'semantic', 'cascade']);
      const lines = (c: HTMLElement): string[] =>
        [...c.querySelectorAll<HTMLElement>('.ar-layer-name > div')].map((d) =>
          squash(d.textContent),
        );
      expect(cells.map(lines)).toEqual([
        ['Classify On', 'L1 · Structural · <1ms, local'],
        ['Semantic On', 'L2 · Semantic · local embed'],
        ['Cascade On', 'L3 · Cascade · cheap-first'],
      ]);
      // The layer's description is always visible in its cell.
      expect(cells[1]!.textContent).toContain('Embedding classifier over the ambiguous slice');
    } finally {
      dispose();
    }
  });

  it('a layer the instance cannot enable reads "Unavailable" and is drawn as unavailable, not off', async () => {
    const { host, dispose } = mount(
      createAppStore(tabsFake({ semantic: false, semanticAvailable: false })),
    );
    try {
      await flush();
      await openRouting(host);
      await openTab(host, 'Auto routing');
      const cell = host.querySelector<HTMLElement>(
        '[data-testid="auto-layers"] [data-layer="semantic"]',
      )!;
      expect(cell.querySelector('[data-testid="layer-state"]')?.textContent).toBe('Unavailable');
      const sw = cell.querySelector<HTMLButtonElement>('[aria-label="Toggle L2 · Semantic"]')!;
      expect(sw.classList.contains('toggle--unavailable')).toBe(true);
      expect(sw.classList.contains('toggle--off')).toBe(false);
      expect(sw.getAttribute('aria-disabled')).toBe('true');
      expect(cell.querySelector('[data-testid="layer-hint"]')?.textContent).toMatch(
        /^off instance-wide/,
      );
      // An available layer that is merely off reads "Off" and is drawn as off.
      const cascade = host.querySelector<HTMLElement>('[data-layer="cascade"]')!;
      expect(cascade.querySelector('[data-testid="layer-state"]')?.textContent).toBe('On');
    } finally {
      dispose();
    }
  });

  it('the Targets matrix sits in Setup with three columns and two focus anchors (split-auto-routing-readout-setup 3.4)', async () => {
    const { host, dispose } = mount(createAppStore(tabsFake()));
    try {
      await flush();
      await openRouting(host);
      await openTab(host, 'Auto routing');
      const matrix = targetsMatrix(host);
      expect(host.querySelector('[data-testid="auto-setup"]')!.contains(matrix)).toBe(true);
      expect(host.querySelector('[data-testid="auto-pipeline"]')!.contains(matrix)).toBe(false);
      // Three target columns, named with what they take; no Detected column.
      const head = [...matrix.querySelectorAll<HTMLElement>('.tm-head > div')].map((d) =>
        squash(d.textContent),
      );
      expect(head).toEqual([
        'Workload',
        'Claim · takes its class first',
        'Strong · confident high',
        'Cheap · confident low',
      ]);
      for (const r of matrix.querySelectorAll('[data-testid="targets-row"]'))
        expect(r.querySelectorAll('[data-testid="targets-cell"]')).toHaveLength(3);
      // The Any request Strong and Cheap cell wrappers are the landing spots — focusable
      // by script only, and named — and no other cell is one.
      for (const col of ['strong', 'cheap'] as const) {
        const cell = targetsCell(host, 'any', col);
        expect(cell.id).toBe(`auto-targets-any-${col}`);
        expect(cell.getAttribute('tabindex')).toBe('-1');
        expect(cell.getAttribute('aria-label')).toBe(
          `${col === 'strong' ? 'Strong' : 'Cheap'} column, Any request row`,
        );
      }
      expect(matrix.querySelectorAll('[data-testid="targets-cell"][id]')).toHaveLength(2);
      // A cell's three rows are separate elements, so the subgrid can align them.
      const cell = targetsCell(host, 'code', 'strong');
      expect(cell.querySelector('.tm-value')).not.toBeNull();
      expect(cell.querySelector('.tm-actions select')).not.toBeNull();
      expect(cell.querySelector('.tm-cell-notes')).not.toBeNull();
    } finally {
      dispose();
    }
  });

  it('pauses stages 2–5 in text at full contrast when Layer 1 is off — no dimming — while an opt-in L2/L3 off reads neutral', async () => {
    const off = mount(createAppStore(tabsFake({ structural: false })));
    try {
      await flush();
      await openRouting(off.host);
      await openTab(off.host, 'Auto routing');
      const status = (id: string): string | null =>
        stageRow(off.host, id).querySelector('[data-testid="stage-status"]')?.textContent ?? null;
      expect(['workload', 'band', 'semantic', 'cascade'].map(status)).toEqual([
        'paused · needs L1',
        'paused · needs L1',
        'paused · needs L1',
        'paused · needs L1',
      ]);
      expect(status('classify')).toBeNull();
      expect(status('default')).toBeNull();
      const classifyStatus = stageRow(off.host, 'classify').querySelector<HTMLElement>(
        '[data-testid="stage-status-now"] .ar-status-line',
      )!;
      expect(classifyStatus.textContent).toBe(
        'Off — new auto requests go straight to the default tier',
      );
      expect(classifyStatus.style.color).toBe('var(--amber-text)'); // Layer 1 off is a caution
      // Its counts are history, said beside them.
      expect(
        cellText(stageRow(off.host, 'band').querySelector('[data-testid="stage-caption"]')),
      ).toBe('routed while L1 was on');
      // Text, never dimming: no stage row — nor anything in it — is faded.
      for (const row of stageRows(off.host)) {
        const line = row.querySelector<HTMLElement>('.ar-row')!;
        expect(line.getAttribute('style') ?? '').not.toMatch(/opacity/);
        expect(line.querySelectorAll('[style*="opacity"]')).toHaveLength(0);
      }
    } finally {
      off.dispose();
    }

    const optIn = mount(
      createAppStore(tabsFake({ cascade: false, semantic: false, semanticAvailable: true })),
    );
    try {
      await flush();
      await openRouting(optIn.host);
      await openTab(optIn.host, 'Auto routing');
      expect(optIn.host.querySelectorAll('[data-testid="stage-status"]')).toHaveLength(0);
      for (const [id, copy] of [
        ['semantic', 'Off — the ambiguous slice goes straight to the default tier'],
        ['cascade', 'Off — still-ambiguous requests use the default tier'],
      ] as const) {
        const status = stageRow(optIn.host, id).querySelector<HTMLElement>(
          '[data-testid="stage-status-now"] .ar-status-line',
        )!;
        expect(status.textContent).toBe(copy);
        expect(status.style.color).toBe('var(--text2)'); // neutral, never the caution tone
        expect(
          cellText(stageRow(optIn.host, id).querySelector('[data-testid="stage-caption"]')),
        ).toBe('routed while on');
      }
    } finally {
      optIn.dispose();
    }
  });

  it('shows the switches loading — never "off instance-wide" — before the auto-layers view arrives', async () => {
    const fake = tabsFake();
    fake.getAutoLayers = () => new Promise<AutoLayers>(() => undefined); // never arrives
    const { host, store, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      await openRouting(host);
      await openTab(host, 'Auto routing');
      expect(store.state.autoLayers).toBeNull();
      expect(host.querySelectorAll('[data-testid="switch-loading"]')).toHaveLength(3);
      expect(host.querySelector('[data-testid="auto-pipeline"] [role="switch"]')).toBeNull();
      expect(host.textContent).not.toContain('off instance-wide');
      expect(host.querySelectorAll('[data-testid="layer-hint"]')).toHaveLength(0);
      for (const id of ['classify', 'workload', 'band', 'semantic', 'cascade']) {
        expect(
          stageRow(host, id).querySelector(
            '[data-testid="stage-status-now"] [data-testid="status-loading"]',
          ),
        ).not.toBeNull();
      }
      expect(stageRow(host, 'default').querySelector('[data-testid="status-loading"]')).toBeNull();
      // Nothing claims to be paused or off while the view is unknown.
      expect(host.querySelectorAll('[data-testid="stage-status"]')).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it('a landed band write whose refresh fails makes the target-reading stages say so (split-auto-routing-readout-setup 4.1)', async () => {
    const fake = tabsFake();
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      await openRouting(host);
      await openTab(host, 'Auto routing');
      // Before: no targets anywhere, so Confident band's count reads as earlier targets'.
      expect(cellText(stageRow(host, 'band').querySelector('[data-testid="stage-caption"]'))).toBe(
        'routed under earlier targets',
      );
      // The write lands; the re-list after it fails, so the snapshot may be stale.
      fake.listRules = () => Promise.reject(new ApiError(503, 'unavailable', 'list failed'));
      const picker = targetPicker(host, 'Strong target for any request');
      picker.value = 'tier:default';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
      expect(fake.calls).toContain('createRule');
      for (const id of ['workload', 'band', 'cascade']) {
        const status = stageRow(host, id).querySelector<HTMLElement>(
          '[data-testid="stage-status-now"]',
        )!;
        const notice = [...status.querySelectorAll<HTMLElement>('.ar-status-sub')].find((l) =>
          l.textContent?.startsWith('Last loaded targets'),
        );
        expect(notice?.textContent, `${id} says its targets are unverified`).toBe(
          'Last loaded targets — routing may have changed; see Targets',
        );
        expect(notice?.style.color).toBe('var(--amber-text)');
        // …and draws no conclusion from the stale snapshot.
        const caption = cellText(stageRow(host, id).querySelector('[data-testid="stage-caption"]'));
        expect(caption).not.toMatch(/earlier targets|earlier claims|could run/);
      }
      for (const id of ['classify', 'semantic', 'default'])
        expect(stageRow(host, id).textContent).not.toContain('Last loaded targets');
    } finally {
      dispose();
    }
  });

  it('while the band columns are unverified, Targets lands on the notice, never a disabled picker', async () => {
    const store = createAppStore(tabsFake());
    const { host, dispose } = mount(store);
    try {
      await flush();
      await openRouting(host);
      await openTab(host, 'Auto routing');
      store.setState('bt', 'unverified', true);
      await flush();
      const targets = stageRow(host, 'band').querySelector<HTMLButtonElement>('button')!;
      targets.focus();
      targets.click();
      await flush();
      const landed = document.activeElement as HTMLElement;
      expect(landed.dataset['testid']).toBe('targets-unverified');
      expect(landed).not.toBe(targets);
    } finally {
      dispose();
    }
  });

  it('rows carry no picker, and without the capability no action at all — a readout', async () => {
    const capable = mount(createAppStore(tabsFake()));
    try {
      await flush();
      await openRouting(capable.host);
      await openTab(capable.host, 'Auto routing');
      for (const row of stageRows(capable.host)) {
        expect(row.querySelector('select')).toBeNull();
        expect(row.querySelector('.toggle')).toBeNull();
      }
      expect(
        stageRows(capable.host).map((r) => r.querySelectorAll('.ar-action button').length),
      ).toEqual([1, 1, 1, 1, 1, 1]);
    } finally {
      capable.dispose();
    }
    const readout = mount(
      createAppStore(
        tabsFake({ structural: false, structuralAvailable: false, cascadeAvailable: false }),
      ),
    );
    try {
      await flush();
      await openRouting(readout.host);
      await openTab(readout.host, 'Auto routing');
      const rows = stageRows(readout.host);
      expect(rows).toHaveLength(6);
      for (const row of rows) expect(row.querySelectorAll('.ar-action button')).toHaveLength(0);
      // Stages 2–5 need Layer 1, which this instance cannot run — not "paused".
      for (const id of ['workload', 'band', 'semantic', 'cascade']) {
        expect(
          cellText(stageRow(readout.host, id).querySelector('[data-testid="stage-status-now"]')),
        ).toBe('Needs L1 — unavailable on this instance');
        expect(stageRow(readout.host, id).querySelector('[data-testid="stage-status"]')).toBeNull();
      }
      // The column header names no count column and no range.
      const head = readout.host.querySelector<HTMLElement>('.ar-colhead')!;
      expect(head.getAttribute('aria-hidden')).toBe('true');
      expect(head.textContent).not.toContain('Requests');
    } finally {
      readout.dispose();
    }
  });

  it('unroutable guidance reaches the fix: one control per affected band, landing on its column (split-auto-routing-readout-setup 4.5)', async () => {
    const both = new FakeApiClient({
      tiers: [DEFAULT_TIER],
      autoPerf: {
        ...DEFAULT_AUTO_PERF,
        bands: {
          ...DEFAULT_AUTO_PERF.bands,
          high: { ...DEFAULT_AUTO_PERF.bands.high, unroutable: 2 },
          low: { ...DEFAULT_AUTO_PERF.bands.low, unroutable: 5 },
        },
      },
    });
    const { host, dispose } = mount(createAppStore(both));
    try {
      await flush();
      await openRouting(host);
      await openTab(host, 'Auto routing');
      const alert = stageRow(host, 'band').querySelector<HTMLElement>(
        '[data-testid="band-alert"]',
      )!;
      expect(alert.textContent).toContain('2 confident high and 5 confident low verdicts');
      expect(alert.textContent).toContain('Strong and Cheap columns');
      expect(alert.textContent).not.toMatch(/\b(above|below)\b/);
      // Separate from the status line, and in a caution tone.
      expect(
        stageRow(host, 'band').querySelector('[data-testid="stage-status-now"]')!.contains(alert),
      ).toBe(false);
      const controls = (root: HTMLElement): HTMLButtonElement[] => [
        ...root.querySelectorAll<HTMLButtonElement>('[data-testid="go-to-column"]'),
      ];
      expect(controls(alert).map((b) => labelText(b))).toEqual([
        'Go to Strong column',
        'Go to Cheap column',
      ]);
      // Neutral text actions — never a second accent.
      for (const b of controls(alert)) expect(b.getAttribute('style')).not.toContain('accent');
      controls(alert)[1]!.focus();
      controls(alert)[1]!.click();
      await flush();
      expect(document.activeElement).toBe(targetsCell(host, 'any', 'cheap'));
      // The Default detail's callout ends in the same controls.
      const callout = (await expandStage(host, 'Default')).querySelector<HTMLElement>(
        '[data-testid="default-unroutable"]',
      )!;
      expect(controls(callout).map((b) => b.dataset['column'])).toEqual(['strong', 'cheap']);
      controls(callout)[0]!.focus();
      controls(callout)[0]!.click();
      await flush();
      expect(document.activeElement).toBe(targetsCell(host, 'any', 'strong'));
    } finally {
      dispose();
    }
    // One affected band: one control, naming its column.
    const one = mount(createAppStore(tabsFake()));
    try {
      await flush();
      await openRouting(one.host);
      await openTab(one.host, 'Auto routing');
      const alert = stageRow(one.host, 'band').querySelector<HTMLElement>(
        '[data-testid="band-alert"]',
      )!;
      expect(alert.textContent).toMatch(/^1 confident high verdict had no usable Strong target/);
      expect(
        [...alert.querySelectorAll('[data-testid="go-to-column"]')].map((b) => labelText(b)),
      ).toEqual(['Go to Strong column']);
    } finally {
      one.dispose();
    }
  });

  it('the stage bars are the tab’s only accent figure (split-auto-routing-readout-setup D11)', async () => {
    const { host, dispose } = mount(
      createAppStore(
        tabsFake({
          semantic: true,
          semanticAvailable: true,
          semanticLearning: true,
          // A calibrated pair, so the `calibrated` chip renders and is checked too.
          calibration: {
            ...DEFAULT_CALIBRATION,
            enabled: true,
            calibratedHigh: 0.58,
            calibratedLow: 0.27,
            effectiveHigh: 0.58,
            effectiveLow: 0.27,
          },
        }),
      ),
    );
    try {
      await flush();
      await openRouting(host);
      await openTab(host, 'Auto routing');
      await expandAllStages(host);
      // Every figure on the tab, details open: no inline style reaches for the accent —
      // the chart legend, the workload-mix bars, the calibrated chip and the target values
      // are all neutral. Controls keep their app-wide convention (switches, the range).
      const tab = (): HTMLElement[] =>
        [...host.querySelectorAll<HTMLElement>('.rs-page [style]')].filter(
          (el) => !el.closest('.toggle') && !el.closest('[data-testid="routing-sections"]'),
        );
      const accented = (): string[] =>
        tab()
          .filter((el) => /var\(--accent/.test(el.getAttribute('style') ?? ''))
          .map((el) => `${el.tagName}.${el.className}: ${el.getAttribute('style') ?? ''}`);
      expect(accented()).toEqual([]);
      for (const name of ['calibration', 'learning'] as const) {
        await openTuning(host, name);
        expect(accented(), `${name} drawer`).toEqual([]);
        tuningDrawerOrNull(host, name)!.querySelector<HTMLButtonElement>('.drawer-close')!.click();
        await flush();
      }
      // The bars draw it from a class: five tracks, one fill each.
      expect(host.querySelectorAll('[data-testid="stage-bar"] .ar-bar-fill')).toHaveLength(5);
    } finally {
      dispose();
    }
  });

  it('each expander is a real button toggling aria-expanded, and expanding writes nothing', async () => {
    const fake = tabsFake();
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      await openRouting(host);
      await openTab(host, 'Auto routing');
      const before = writesOf(fake);
      // Exactly five expanders: every stage but Confident band, which points at the
      // Targets area instead.
      expect(
        host.querySelectorAll('[data-testid="auto-pipeline"] button[aria-expanded]'),
      ).toHaveLength(5);
      const band = stageRow(host, 'band');
      expect(band.querySelector('button[aria-expanded]')).toBeNull();
      expect(band.querySelector('button')?.textContent?.trim()).toBe('Targets');
      for (const name of EXPANDABLE_STAGES) {
        const btn = stageExpander(host, name);
        expect(btn.tagName).toBe('BUTTON');
        expect(btn.getAttribute('type')).toBe('button');
        expect(btn.getAttribute('aria-expanded'), `${name} starts collapsed`).toBe('false');
        btn.click();
        await flush();
        expect(btn.getAttribute('aria-expanded')).toBe('true');
        const id = btn.getAttribute('aria-controls')!;
        const region = host.querySelector<HTMLElement>(`[id="${id}"]`);
        expect(region?.getAttribute('role')).toBe('region');
        expect(region?.getAttribute('aria-label')).toBe(`${name} details`);
        btn.click();
        await flush();
        expect(btn.getAttribute('aria-expanded')).toBe('false');
        expect(host.querySelector(`[id="${id}"]`)).toBeNull();
      }
      expect(writesOf(fake)).toEqual(before);
    } finally {
      dispose();
    }
  });

  it('the Default stage breaks down what fell through; the foot discloses unevaluated traffic', async () => {
    const { host, dispose } = mount(createAppStore(tabsFake()));
    try {
      await flush();
      await openRouting(host);
      await openTab(host, 'Auto routing');
      const detail = await expandStage(host, 'Default');
      // DEFAULT_AUTO_PERF: default 3 = high.unroutable 1 + low.unroutable 0 + fallthrough 2.
      // The total is the Default ROW's count; the detail breaks it down without repeating it.
      expect(
        cellText(stageRow(host, 'default').querySelector('[data-testid="stage-figure"]')),
      ).toMatch(/^3 /);
      const figures = squash(detail.querySelector('[data-testid="ap-default"]')?.textContent);
      expect(figures).not.toContain('routed to the default tier');
      expect(figures).toContain('confident high, no usable Strong target 1');
      expect(figures).toContain('confident low, no usable Cheap target 0');
      expect(squash(detail.querySelector('[data-testid="default-fallthrough"]')?.textContent)).toBe(
        'ambiguous, no later stage took it 2',
      );
      // Said ONCE, at the Pipeline's foot — never repeated in the Default detail.
      expect(detail.querySelector('[data-testid="default-unevaluated"]')).toBeNull();
      expect(host.querySelector('[data-testid="pipeline-unevaluated"]')?.textContent).toContain(
        'Layer 1 never evaluated',
      );
    } finally {
      dispose();
    }
  });

  it('the Confident band row points at the Targets area, and the Layer-0 note at Tiers & headers', async () => {
    const { host, dispose } = mount(createAppStore(tabsFake()));
    try {
      await flush();
      await openRouting(host);
      await openTab(host, 'Auto routing');
      const targets = stageRow(host, 'band').querySelector<HTMLButtonElement>('button')!;
      expect(targets.getAttribute('aria-label')).toBe('Go to Targets, Strong column');
      targets.focus();
      targets.click();
      await flush();
      // It lands on the Any request row's Strong cell — the wrapper, never its picker, so
      // a stray Arrow key cannot retarget routing — and the picker is the next Tab stop.
      const landed = document.activeElement as HTMLElement;
      expect(landed).toBe(targetsCell(host, 'any', 'strong'));
      expect(landed.tagName).not.toBe('SELECT');
      expect(landed.querySelector('select')).toBe(
        targetPicker(host, 'Strong target for any request'),
      );
      // The note's cross-reference is a real control naming its tab — and focus follows.
      const link = [
        ...host.querySelectorAll<HTMLButtonElement>('[data-testid="layer0-note"] button'),
      ].find((b) => labelText(b) === 'Tiers & headers')!;
      link.focus();
      link.click();
      await flush();
      expect(pressed(host)).toEqual(['Tiers & headers']);
      expect((document.activeElement as HTMLElement).textContent?.trim()).toBe('Tiers & headers');
    } finally {
      dispose();
    }
  });

  it('hands focus to the tab control when an availability flip unmounts a focused tuning drawer', async () => {
    const store = createAppStore(tabsFake());
    const { host, dispose } = mount(store);
    try {
      await flush();
      await openRouting(host);
      await openTab(host, 'Auto routing');
      await expandStage(host, 'Classify');
      const drawer = await openTuning(host, 'calibration');
      const sw = drawer.querySelector<HTMLButtonElement>('[aria-label="Self-calibration"]')!;
      sw.focus();
      expect(document.activeElement).toBe(sw);
      // The capability goes away: the drawer AND its entry (its invoker) unmount.
      store.setState('autoLayers', 'structuralAvailable', false);
      await flush();
      expect(sw.isConnected).toBe(false);
      expect(tuningDrawerOrNull(host, 'calibration')).toBeNull();
      const focused = document.activeElement as HTMLElement;
      expect(labelText(focused)).toBe('Auto routing');
      expect(focused.closest('[data-testid="routing-sections"]')).not.toBeNull();
      // The rows stay as a readout — only what needs the capability went.
      expect(stageRows(host)).toHaveLength(6);
      expect(host.querySelector('[data-testid="stage-detail"]')).toBeNull();
    } finally {
      dispose();
    }
  });
});

// add-provider-health-signals (task 8.4): ONE truthful status line from the
// server's displayed health; the token lifetime on its own neutral line; Reconnect
// on every OAuth card — never gated on the reauthorize-required state.
describe('provider card health line and Reconnect (add-provider-health-signals)', () => {
  const base = {
    kind: 'subscription',
    protocol: 'openai_responses',
    baseUrl: 'https://chatgpt.com/',
    status: 'error',
    maxTokensSpelling: 'auto' as const,
    hasCredential: true,
    oauthPreset: 'chatgpt',
    credentialExpiresAt: new Date(Date.now() + 240 * 3_600_000).toISOString(),
    credentialError: null,
    firstByteTimeoutMs: null,
    idleTimeoutMs: null,
    createdAt: '2026-07-15T00:00:00.000Z',
    ...UNRECORDED_HEALTH,
  };

  const cardOf = (host: HTMLElement, name: string): HTMLElement => {
    const card = [...host.querySelectorAll<HTMLElement>('.card')].find((c) =>
      c.textContent?.includes(name),
    );
    if (!card) throw new Error(`card ${name} missing`);
    return card;
  };

  it('a failing card states the reason and age once — no "Connected" or "Healthy" beside it', async () => {
    const fake = new FakeApiClient({
      providers: [
        {
          ...base,
          id: 'prov-failing',
          name: 'OpenAI',
          health: {
            state: 'failing',
            kind: 'auth',
            message: 'authentication failed',
            source: 'traffic',
            at: new Date(Date.now() - 12 * 60_000).toISOString(),
          },
        },
      ],
    });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Providers');
      await flush();
      const card = cardOf(host, 'OpenAI');
      const line = card.querySelector('[data-health-line]')?.textContent ?? '';
      expect(line).toContain('authentication failed');
      expect(line).toContain('seen in live traffic 12m ago');
      expect(line).toContain('reconnect if this persists');
      expect(card.querySelectorAll('[data-health-line]')).toHaveLength(1);
      expect(card.textContent).not.toMatch(/Connected|Healthy|Last action failed/);
      // The token lifetime is a separate, neutral line.
      expect(card.querySelector('[data-token-line]')?.textContent).toMatch(
        /Signed in · renews automatically · expires in 240h/,
      );
    } finally {
      dispose();
    }
  });

  it('Reconnect is offered on a HEALTHY OAuth card and starts the reauthorize flow', async () => {
    const fake = new FakeApiClient({
      providers: [
        {
          ...base,
          id: 'prov-healthy',
          name: 'Claude',
          protocol: 'anthropic_compatible',
          oauthPreset: 'claude',
          status: 'ok',
          health: {
            state: 'ok',
            kind: null,
            message: null,
            source: 'test',
            at: new Date().toISOString(),
          },
        },
      ],
    });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Providers');
      await flush();
      const card = cardOf(host, 'Claude');
      const reconnect = [...card.querySelectorAll<HTMLElement>('button')].find(
        (b) => labelText(b) === 'Reconnect',
      );
      expect(reconnect).toBeDefined();
      reconnect!.click();
      await flush();
      expect(
        fake.callLog.some((c) => c.method === 'oauthReauthorize' && c.args[0] === 'prov-healthy'),
      ).toBe(true);
    } finally {
      dispose();
    }
  });

  it('the Edit dialog of an OAuth provider (incl. a Responses row) offers the Reconnect it names', async () => {
    const fake = new FakeApiClient({
      providers: [{ ...base, id: 'prov-resp', name: 'ChatGPT' }],
    });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Providers');
      await flush();
      const card = cardOf(host, 'ChatGPT');
      [...card.querySelectorAll<HTMLElement>('button')]
        .find((b) => labelText(b) === 'Edit')!
        .click();
      await flush();
      const dialog = host.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog).not.toBeNull();
      const text = dialog!.textContent ?? '';
      expect(text).toContain('Reconnect');
      expect(text).not.toContain('Reauthorize'); // never names a control that isn't there
      const reconnect = [...dialog!.querySelectorAll<HTMLElement>('button')].find(
        (b) => labelText(b) === 'Reconnect',
      );
      expect(reconnect).toBeDefined();
      reconnect!.click();
      await flush();
      expect(
        fake.callLog.some((c) => c.method === 'oauthReauthorize' && c.args[0] === 'prov-resp'),
      ).toBe(true);
    } finally {
      dispose();
    }
  });

  it('opening the Providers page, and returning to its tab, reloads the provider list', async () => {
    const fake = new FakeApiClient({ providers: [{ ...base, id: 'prov-r', name: 'Reloaded' }] });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      const lists = (): number => fake.callLog.filter((c) => c.method === 'listProviders').length;
      const atLogin = lists();
      clickByText(host, '.nav-item span', 'Providers');
      await flush();
      expect(lists()).toBe(atLogin + 1);
      document.dispatchEvent(new Event('visibilitychange'));
      await flush();
      expect(lists()).toBe(atLogin + 2);
    } finally {
      dispose();
    }
  });

  it('the reconnect-required state shows its banner in the status slot with exactly one Reconnect', async () => {
    const fake = new FakeApiClient({
      providers: [
        {
          ...base,
          id: 'prov-dead',
          name: 'Expired',
          credentialError: 'reauthorize_required',
          health: {
            state: 'reauthorize_required',
            kind: 'credential',
            message: 'credential needs reauthorization',
            source: 'refresh',
            at: new Date().toISOString(),
          },
        },
      ],
    });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Providers');
      await flush();
      const card = cardOf(host, 'Expired');
      expect(card.querySelectorAll('[data-health-line]')).toHaveLength(1);
      expect(card.querySelector('[data-health-line]')?.textContent).toMatch(/Sign-in expired/);
      const reconnects = [...card.querySelectorAll('button')].filter(
        (b) => labelText(b) === 'Reconnect',
      );
      expect(reconnects).toHaveLength(1);
      expect(card.querySelector('[data-token-line]')).toBeNull();
    } finally {
      dispose();
    }
  });

  // Field bug (v0.22.0): Reconnect opened the ADD-provider form — the wizard was
  // gated on the preset list, which only `openModal` loads. Reconnect is its own mode.
  const clickReconnect = (card: HTMLElement): void => {
    [...card.querySelectorAll<HTMLElement>('button')]
      .find((b) => labelText(b) === 'Reconnect')!
      .click();
  };

  it('Reconnect as the first modal of the session shows the sign-in steps — never the add-provider form', async () => {
    const fake = new FakeApiClient({ providers: [{ ...base, id: 'prov-first', name: 'OpenAI' }] });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Providers');
      await flush();
      clickReconnect(cardOf(host, 'OpenAI'));
      await flush();
      const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
      expect(dialog.querySelector('#modal-title')?.textContent).toBe('Reconnect OpenAI');
      expect(dialog.querySelector('[data-reconnect-view]')).not.toBeNull();
      expect(dialog.textContent).toContain('Open sign-in link');
      expect(dialog.querySelector('#f-ow-paste')).not.toBeNull();
      // None of the add-provider form: no name, no kind picker, no Add provider.
      expect(dialog.querySelector('#f-np-name')).toBeNull();
      expect(dialog.textContent).not.toContain('Kind');
      expect([...dialog.querySelectorAll('button')].map((b) => labelText(b))).not.toContain(
        'Add provider',
      );
    } finally {
      dispose();
    }
  });

  it('a leftover "Other subscription" toggle cannot hide the reconnect steps', async () => {
    const fake = new FakeApiClient({ providers: [{ ...base, id: 'prov-adv', name: 'OpenAI' }] });
    const store = createAppStore(fake);
    const { host, dispose } = mount(store);
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Providers');
      await flush();
      store.openModal('newProvider');
      store.setState('np', 'kind', 'sub');
      store.setState('ow', 'advanced', true);
      await flush();
      store.closeModal();
      await flush();
      clickReconnect(cardOf(host, 'OpenAI'));
      await flush();
      const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
      expect(dialog.querySelector('#f-ow-paste')).not.toBeNull();
      expect(dialog.querySelector('#f-np-name')).toBeNull();
    } finally {
      dispose();
    }
  });

  it('a reconnect that cannot start says why and offers Try again', async () => {
    const fake = new FakeApiClient({ providers: [{ ...base, id: 'prov-err', name: 'OpenAI' }] });
    fake.oauthReauthorizeRejects = new ApiError(
      503,
      'Unavailable',
      'connect is temporarily unavailable',
    );
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Providers');
      await flush();
      clickReconnect(cardOf(host, 'OpenAI'));
      await flush();
      const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
      expect(dialog.textContent).toContain('connect is temporarily unavailable');
      clickByText(dialog, 'button', 'Try again');
      await flush();
      expect(dialog.querySelector('#f-ow-paste')).not.toBeNull();
      expect(fake.callLog.filter((c) => c.method === 'oauthReauthorize')).toHaveLength(2);
    } finally {
      dispose();
    }
  });

  it('completing a reconnect renews the same row, closes the dialog, and runs one Test', async () => {
    const fake = new FakeApiClient({ providers: [{ ...base, id: 'prov-done', name: 'OpenAI' }] });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Providers');
      await flush();
      clickReconnect(cardOf(host, 'OpenAI'));
      await flush();
      const paste = host.querySelector<HTMLInputElement>('#f-ow-paste')!;
      paste.value = 'http://localhost:1455/auth/callback?code=c&state=st-re';
      paste.dispatchEvent(new Event('input', { bubbles: true }));
      clickByText(host, '[role="dialog"] button', 'Connect');
      await flush();
      expect(fake.lastArgs('oauthComplete')?.[0]).toBe('sess-re-prov-done');
      expect(host.querySelector('[role="dialog"]')).toBeNull();
      expect(fake.callLog.filter((c) => c.method === 'testProvider')).toHaveLength(1);
      expect(fake.providers.filter((p) => p.name === 'OpenAI')).toHaveLength(1); // same row
    } finally {
      dispose();
    }
  });

  it('a non-OAuth card has no Reconnect', async () => {
    const fake = new FakeApiClient({
      providers: [
        {
          ...base,
          id: 'prov-key',
          name: 'OpenRouter',
          kind: 'api_key',
          protocol: 'openai_compatible',
          baseUrl: 'https://openrouter.ai/api/v1',
          oauthPreset: null,
          credentialExpiresAt: null,
        },
      ],
    });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Providers');
      await flush();
      const card = cardOf(host, 'OpenRouter');
      expect([...card.querySelectorAll('button')].map((b) => labelText(b))).not.toContain(
        'Reconnect',
      );
      expect(card.querySelector('[data-token-line]')).toBeNull();
    } finally {
      dispose();
    }
  });
});
