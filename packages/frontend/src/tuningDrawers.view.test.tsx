/** The tuning drawers (split-auto-routing-readout-setup D8, task 3.2).
 *
 * Self-calibration and semantic learning moved out of the stage details into two drawers
 * opened from their Layers cells. The drawer is the dashboard's existing one, so the
 * overlay contract carries over — and the hazards this suite exists for are the ones the
 * move created: focus that falls to <body> when a control replaces itself, a nested
 * confirmation whose Escape must not also close the drawer, and a drawer whose card loses
 * its precondition while it is open.
 */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import type { AutoLayers, SemanticLearningStatus } from './data/api';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { DEFAULT_CALIBRATION, FakeApiClient } from './test/fakeClient';
import { openAutoTab, openTuning, tuningDrawerOrNull, tuningEntry } from './test/routingTabs';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

interface Harness {
  host: HTMLElement;
  store: AppStore;
  fake: FakeApiClient;
  dispose: () => void;
}

const LAYERS: AutoLayers = {
  structural: true,
  cascade: true,
  structuralAvailable: true,
  cascadeAvailable: true,
  semantic: true,
  semanticAvailable: true,
  semanticLearning: true,
  semanticLearningAvailable: true,
  calibration: {
    ...DEFAULT_CALIBRATION,
    enabled: true,
    calibratedHigh: 0.58,
    calibratedLow: 0.27,
    effectiveHigh: 0.58,
    effectiveLow: 0.27,
    agents: [
      {
        id: 'a-own',
        name: 'markus',
        calibratedHigh: 0.53,
        calibratedLow: 0.32,
        anchorHigh: 0.58,
        anchorLow: 0.27,
        epoch: 2,
        active: true,
        evidence: { highSamples: 30, lowSamples: 8 },
      },
    ],
  },
};

const LEARNED: SemanticLearningStatus = {
  enabled: true,
  available: true,
  epoch: 1,
  generation: 2,
  source: 'learned',
  freshHigh: 5,
  freshLow: 12,
  lastAppliedAt: '2026-07-03T00:00:00.000Z',
  history: [],
};

async function mount(over: Partial<AutoLayers> = {}): Promise<Harness> {
  const fake = new FakeApiClient({
    autoLayers: { ...LAYERS, ...over },
    semanticLearningStatus: LEARNED,
  });
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
  await openAutoTab(host);
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

const escape = (): void => {
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
};

const button = (root: ParentNode, text: string): HTMLButtonElement => {
  const b = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
    (x) => x.textContent?.trim() === text,
  );
  if (!b) throw new Error(`no "${text}" button`);
  return b;
};

/** Focus and activate, as a keyboard user does (Enter on a focused button). */
const press = (b: HTMLButtonElement): void => {
  b.focus();
  b.click();
};

const tabControl = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="routing-sections"] [aria-pressed="true"]');

describe('tuning drawers: entries and the drawer contract', () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.dispose();
    h = null;
  });

  it('each entry states what it opens, and opens a labelled dialog', async () => {
    h = await mount();
    const cal = tuningEntry(h.host, 'calibration');
    expect(cal.textContent?.trim()).toBe('Self-calibration · on');
    expect(cal.getAttribute('aria-haspopup')).toBe('dialog');
    expect(cal.getAttribute('aria-expanded')).toBe('false');
    expect(cal.closest('[data-layer="structural"]')).not.toBeNull();
    const learn = tuningEntry(h.host, 'learning');
    expect(learn.textContent?.trim()).toBe('Semantic learning · on');
    expect(learn.closest('[data-layer="semantic"]')).not.toBeNull();

    const drawer = await openTuning(h.host, 'calibration');
    expect(drawer.getAttribute('role')).toBe('dialog');
    expect(drawer.getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(drawer.getAttribute('aria-labelledby') ?? '');
    expect(title?.textContent).toBe('Classify · self-calibration');
    expect(drawer.querySelector('.drawer-close')?.getAttribute('aria-label')).toBe(
      'Close self-calibration',
    );
    expect(cal.getAttribute('aria-expanded')).toBe('true');
    // The card moved whole: its switch, thresholds and per-agent pairs are here.
    expect(drawer.querySelector('[aria-label="Self-calibration"]')).not.toBeNull();
    expect(drawer.querySelector('[data-testid="agent-calibration"]')).not.toBeNull();
    // It names where its evidence is — a stage, not a position.
    const pointer = drawer.querySelector('[data-testid="calibration-evidence-pointer"]');
    expect(pointer?.textContent).toContain('Classify stage’s details in the Pipeline');
    expect(pointer?.textContent).not.toMatch(/\b(above|below)\b/);
    // The evidence itself stays a measured figure in the Classify detail.
    expect(drawer.querySelector('[data-testid="calibration-evidence"]')).toBeNull();
  });

  it('the learning drawer holds the learning card', async () => {
    h = await mount();
    const drawer = await openTuning(h.host, 'learning');
    const title = document.getElementById(drawer.getAttribute('aria-labelledby') ?? '');
    expect(title?.textContent).toBe('Semantic · learning');
    expect(drawer.querySelector('.drawer-close')?.getAttribute('aria-label')).toBe(
      'Close semantic learning',
    );
    expect(drawer.querySelector('[data-testid="semantic-learning"]')).not.toBeNull();
    expect(drawer.textContent).toContain('active: learned centroids');
  });

  it('no stage detail holds a switch or a target picker any more', async () => {
    h = await mount();
    for (const name of ['Classify', 'Workload claim', 'Semantic', 'Cascade', 'Default']) {
      h.host.querySelector<HTMLButtonElement>(`button[aria-label="${name} details"]`)?.click();
    }
    await flush();
    const details = [...h.host.querySelectorAll<HTMLElement>('[data-testid="stage-detail"]')];
    expect(details).toHaveLength(5);
    for (const d of details) {
      expect(d.querySelector('.toggle')).toBeNull();
      expect(d.querySelector('select')).toBeNull();
    }
  });

  it('Escape closes the drawer and returns focus to its entry', async () => {
    h = await mount();
    const entry = tuningEntry(h.host, 'calibration');
    await openTuning(h.host, 'calibration');
    escape();
    await flush();
    expect(tuningDrawerOrNull(h.host, 'calibration')).toBeNull();
    expect(document.activeElement).toBe(entry);
    expect(entry.getAttribute('aria-expanded')).toBe('false');
  });

  it('the close button and the backdrop both close it', async () => {
    h = await mount();
    const drawer = await openTuning(h.host, 'learning');
    press(drawer.querySelector<HTMLButtonElement>('.drawer-close')!);
    await flush();
    expect(tuningDrawerOrNull(h.host, 'learning')).toBeNull();
    await openTuning(h.host, 'learning');
    h.host.querySelector<HTMLElement>('.overlay')!.click();
    await flush();
    expect(tuningDrawerOrNull(h.host, 'learning')).toBeNull();
  });

  it('a lost precondition closes the drawer, focus goes to the tab control, and it stays closed', async () => {
    h = await mount();
    const drawer = await openTuning(h.host, 'learning');
    const sw = drawer.querySelector<HTMLButtonElement>('[aria-label="Semantic learning"]')!;
    sw.focus();
    // The semantic layer stops being effective: the drawer AND its entry go.
    h.store.setState('autoLayers', 'semantic', false);
    await flush();
    expect(tuningDrawerOrNull(h.host, 'learning')).toBeNull();
    expect(h.host.querySelector('[data-tuning="learning"]')).toBeNull();
    expect(document.activeElement).toBe(tabControl());
    // The precondition returning does not reopen it by itself.
    h.store.setState('autoLayers', 'semantic', true);
    await flush();
    expect(tuningDrawerOrNull(h.host, 'learning')).toBeNull();
    expect(tuningEntry(h.host, 'learning').getAttribute('aria-expanded')).toBe('false');
  });
});

describe('tuning drawers: focus inside the drawer', () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.dispose();
    h = null;
  });

  it('Escape inside the Revert-to-bundled confirmation cancels it and keeps the drawer open', async () => {
    h = await mount();
    const entry = tuningEntry(h.host, 'learning');
    const drawer = await openTuning(h.host, 'learning');
    press(button(drawer, 'Revert to bundled'));
    await flush();
    expect(drawer.textContent).toContain('Revert all learned centroids?');
    expect(document.activeElement).toBe(button(drawer, 'Cancel'));
    escape();
    await flush();
    expect(tuningDrawerOrNull(h.host, 'learning')).not.toBeNull();
    expect(drawer.textContent).not.toContain('Revert all learned centroids?');
    expect(document.activeElement).toBe(button(drawer, 'Revert to bundled'));
    expect(h.fake.calls).not.toContain('semanticLearningRevert');
    // A second Escape closes the drawer.
    escape();
    await flush();
    expect(tuningDrawerOrNull(h.host, 'learning')).toBeNull();
    expect(document.activeElement).toBe(entry);
  });

  it('Cancel returns focus to Revert to bundled', async () => {
    h = await mount();
    const drawer = await openTuning(h.host, 'learning');
    press(button(drawer, 'Revert to bundled'));
    await flush();
    press(button(drawer, 'Cancel'));
    await flush();
    expect(document.activeElement).toBe(button(drawer, 'Revert to bundled'));
  });

  it('actions that remove their own control keep focus inside the drawer', async () => {
    h = await mount();
    const learning = await openTuning(h.host, 'learning');
    press(button(learning, 'Revert to bundled'));
    await flush();
    press(button(learning, 'Confirm revert'));
    await flush();
    expect(h.fake.calls).toContain('semanticLearningRevert');
    expect(document.activeElement).not.toBe(document.body);
    expect(learning.contains(document.activeElement)).toBe(true);
    escape();
    await flush();

    const cal = await openTuning(h.host, 'calibration');
    press(cal.querySelector<HTMLButtonElement>('[data-testid="agent-revert"]')!);
    await flush();
    expect(h.fake.calls).toContain('agentCalibrationRevert');
    expect(cal.querySelector('[data-testid="agent-revert"]')).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(cal.contains(document.activeElement)).toBe(true);

    press(button(cal, 'Revert to defaults'));
    await flush();
    expect(h.fake.calls).toContain('calibrationRevert');
    expect(cal.textContent).not.toContain('Revert to defaults');
    expect(document.activeElement).not.toBe(document.body);
    expect(cal.contains(document.activeElement)).toBe(true);
    // The drawer is still the layer Escape dismisses.
    escape();
    await flush();
    expect(tuningDrawerOrNull(h.host, 'calibration')).toBeNull();
  });

  for (const [name, label] of [
    ['calibration', 'Self-calibration'],
    ['learning', 'Semantic learning'],
  ] as const) {
    for (const outcome of ['resolve', 'reject', 'late'] as const) {
      it(`the ${label} switch keeps focus when its write ${outcome === 'late' ? 'responds late' : outcome === 'resolve' ? 'succeeds' : 'fails'}`, async () => {
        h = await mount();
        h.fake.deferAutoLayers = true;
        const drawer = await openTuning(h.host, name);
        const sw = drawer.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
        press(sw);
        await flush();
        if (outcome === 'late') {
          // Other work lands first; the write is still in flight.
          await flush();
          expect(document.activeElement).toBe(sw);
        }
        const call = h.fake.autoLayersQueue.shift();
        expect(call, 'the switch wrote').toBeDefined();
        call?.settle(outcome === 'reject' ? 'reject' : 'resolve');
        await flush();
        // The SAME node — not a re-rendered twin — still holds focus.
        expect(sw.isConnected).toBe(true);
        expect(document.activeElement).toBe(sw);
        for (const rest of h.fake.autoLayersQueue.splice(0)) rest.settle('resolve');
        await flush();
        expect(document.activeElement).toBe(sw);
      });
    }

    // adopt-design-tokens-v2 task 4.4 / design.md D14: no button in a tuning drawer takes the
    // natively disabled busy state, because native `disabled` drops focus. While the switch's
    // save is in flight the drawer's buttons stay enabled and the switch keeps focus.
    it(`while the ${label} switch saves, no drawer button is natively disabled and focus stays`, async () => {
      h = await mount();
      h.fake.deferAutoLayers = true;
      const drawer = await openTuning(h.host, name);
      const sw = drawer.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
      press(sw);
      await flush();
      expect(h.fake.autoLayersQueue.length, 'the save is in flight').toBeGreaterThan(0);
      const live = document.querySelector('[data-testid="tuning-drawer"]');
      expect(live, 'the drawer is still open').not.toBeNull();
      const disabled = [...live!.querySelectorAll<HTMLButtonElement>('button')]
        .filter((b) => b.disabled)
        .map((b) => b.getAttribute('aria-label') ?? (b.textContent ?? '').trim());
      expect(disabled, 'drawer buttons natively disabled while a save is in flight').toEqual([]);
      expect(sw.disabled, 'the switch itself is never natively disabled').toBe(false);
      expect(document.activeElement).toBe(sw);
      for (const call of h.fake.autoLayersQueue.splice(0)) call.settle('resolve');
      await flush();
      expect(document.activeElement).toBe(sw);
    });
  }
});
