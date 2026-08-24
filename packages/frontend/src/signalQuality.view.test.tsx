import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import type { AutoLayers, AutoPerformance } from './data/api';
import { DEFAULT_AUTO_PERF, FakeApiClient } from './test/fakeClient';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';

/** add-auto-signal-honesty §render: the Signal quality section's three states
 * on the real Routing page (VM/guidance logic is unit-tested in
 * data/autoPerf.test.ts — this file asserts the section actually renders). */

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

const sq = (
  over: Partial<AutoPerformance['signalQuality'][number]> = {},
): AutoPerformance['signalQuality'][number] => ({
  agentId: 'a1',
  label: 'markus',
  bandedRows: 272,
  ambiguousRows: 272,
  distinctScores: 24,
  modalScore: 0.45,
  modalShare: 0.85,
  collapsed: true,
  ...over,
});

interface Harness {
  host: HTMLElement;
  store: AppStore;
  dispose: () => void;
}

const BASE_LAYERS: Omit<AutoLayers, 'calibration'> = {
  structural: true,
  cascade: true,
  structuralAvailable: true,
  cascadeAvailable: true,
  semantic: false,
  semanticAvailable: false,
  semanticLearning: false,
  semanticLearningAvailable: false,
};

async function mountRouting(
  signalQuality: AutoPerformance['signalQuality'],
  layersOver: Partial<AutoLayers> = {},
): Promise<Harness> {
  const fake = new FakeApiClient({
    autoPerf: { ...DEFAULT_AUTO_PERF, signalQuality },
    // The copy matrix keys on autoLayers, which loadRouting fetches — so the
    // override must live in the FAKE, not be patched onto the store pre-load.
    ...(Object.keys(layersOver).length > 0
      ? {
          autoLayers: {
            ...BASE_LAYERS,
            calibration: new FakeApiClient({}).autoLayers.calibration,
            ...layersOver,
          },
        }
      : {}),
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
  const nav = [...host.querySelectorAll<HTMLElement>('.nav-item span')].find(
    (e) => e.textContent?.trim() === 'Routing',
  );
  nav?.click();
  await flush();
  // Signal quality lives inside Auto performance, in the rail's Tuning section
  // (section-routing-rail). Switch here rather than in every case.
  const seg = [
    ...host.querySelectorAll<HTMLButtonElement>('[data-testid="routing-sections"] .rs-seg'),
  ].find((b) => b.textContent?.trim() === 'Tuning');
  if (!seg) throw new Error('Routing section "Tuning" is not offered');
  seg.click();
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

const section = (h: Harness): HTMLElement | null =>
  h.host.querySelector('[data-testid="signal-quality"]');
const coverage = (h: Harness): HTMLElement | null =>
  h.host.querySelector('[data-testid="signal-quality-coverage"]');

describe('Signal quality section (add-auto-signal-honesty)', () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.dispose();
    h = null;
  });

  it('renders a flagged agent with modal bucket, share, and denominator', async () => {
    h = await mountRouting([sq()]);
    const el = section(h);
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain('markus');
    expect(el!.textContent).toContain('score 0.45 · 85% of 272 ambiguous requests');
    expect(el!.textContent).toContain('24 distinct scores');
    expect(coverage(h)).toBeNull(); // every agent assessed → no coverage line
  });

  it('MIXED state: flagged list AND coverage line render together', async () => {
    h = await mountRouting([sq(), sq({ agentId: 'a2', label: 'small', collapsed: null })]);
    expect(section(h)!.textContent).toContain('markus');
    expect(coverage(h)!.textContent).toBe(
      '1 of 2 agents have enough evaluated traffic to assess',
    );
  });

  it('coverage-only state renders neutrally, and all-healthy renders nothing', async () => {
    h = await mountRouting([sq({ collapsed: false }), sq({ agentId: 'a2', collapsed: null })]);
    expect(section(h)!.textContent).not.toContain('markus —');
    expect(coverage(h)).not.toBeNull();
    h.dispose();
    h = await mountRouting([sq({ collapsed: false })]);
    expect(section(h)).toBeNull(); // no empty scaffolding
  });

  it('guidance follows the live availability state', async () => {
    // Fake default: semanticAvailable false → configuration-surface variant.
    h = await mountRouting([sq()]);
    expect(section(h)!.textContent).toContain('SEMANTIC_MODEL_PATH');
    h.dispose();
    h = await mountRouting([sq()], { semanticAvailable: true, semantic: false });
    expect(section(h)!.textContent).toContain('enable L2 · Semantic');
    h.dispose();
    h = await mountRouting([sq()], { semanticAvailable: true, semantic: true });
    expect(section(h)!.textContent).toContain('L2 · Semantic evaluates it');
  });
});
