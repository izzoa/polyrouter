import { APP_NAME } from '@polyrouter/shared';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChannelDto, ModelDto, RuleDto, TierDto, TierEntryDto } from './data/api';
import { App } from './App';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { DEFAULT_CALIBRATION, FakeApiClient } from './test/fakeClient';

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
    contextWindow: null,
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
    lastSyncedAt: null,
  };
}
function mkEntry(modelId: string, position: number): TierEntryDto {
  return { id: `e-${modelId}`, tierId: 't1', modelId, position, model: null };
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
  const el = [...host.querySelectorAll<HTMLElement>(selector)].find(
    (e) => e.textContent?.trim() === text,
  );
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
      expect(host.textContent).toContain('Automatic routing');
      expect(host.textContent).toContain('x-polyrouter-tier');
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
        calibration: DEFAULT_CALIBRATION,
      },
    });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      expect(host.textContent).toContain('off instance-wide (ROUTING_AUTO_LAYERS)');
      // add-auto-performance-view: no structural layer -> no performance section
      expect(host.textContent).not.toContain('Auto performance');
    } finally {
      dispose();
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
        calibration: {
          enabled: true,
          calibratedHigh: 0.58,
          calibratedLow: 0.27,
          instanceHigh: 0.6,
          instanceLow: 0.25,
          effectiveHigh: 0.58,
          effectiveLow: 0.27,
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
      const text = host.textContent ?? '';
      expect(text).toContain('Self-calibration');
      expect(text).toContain('high 0.58 · low 0.27');
      expect(text).toContain('calibrated');
      expect(text).toContain('Revert to defaults');
      expect(text).toContain('0.6 → 0.58 (high)');
      expect(text).toContain('57 samples · 75% failed');
      // Revert: one click clears the pair; the section returns to defaults.
      const btn = [...host.querySelectorAll<HTMLElement>('button')].find(
        (b) => b.textContent?.trim() === 'Revert to defaults',
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

  it('renders the Auto performance section with rates, savings + coverage, and a local range', async () => {
    const fake = new FakeApiClient({ tiers: [DEFAULT_TIER] });
    const { host, store, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      const text = host.textContent ?? '';
      expect(text).toContain('Auto performance');
      // DEFAULT_AUTO_PERF: evaluated 40; cascade 10 with 7 passed / 1 escalated.
      expect(text).toContain('evaluated');
      expect(text).toContain('40');
      expect(text).toContain('70%');
      // Savings honesty contract: net + basis label + '· est.' + visible coverage.
      expect(text).toContain('$1.6200');
      expect(text).toContain('premium');
      expect(text).toContain('est.');
      expect(text).toContain('based on 6 of 7 quality-passed requests');
      // Unroutable diagnostic (1 in the fixture) names the rule kinds to add.
      expect(text).toContain('auto_high');
      // The section's range control is LOCAL: clicking 30d must not move the
      // global Observe range (24h default), only autoPerf.range.
      expect(store.state.autoPerf.range).toBe('7d');
      const globalBefore = store.state.range;
      const section = [...host.querySelectorAll<HTMLElement>('.panel')].find((p) =>
        p.textContent?.includes('Auto performance'),
      );
      if (!section) throw new Error('Auto performance panel missing');
      const btn = [...section.querySelectorAll<HTMLElement>('button')].find(
        (b) => b.textContent?.trim() === '30d',
      );
      if (!btn) throw new Error('30d range button missing');
      btn.click();
      await flush();
      expect(store.state.autoPerf.range).toBe('30d');
      expect(store.state.range).toBe(globalBefore);
      expect(fake.calls.filter((c) => c === 'autoPerformance').length).toBeGreaterThanOrEqual(2);
    } finally {
      dispose();
    }
  });

  it('shows only header rules in the Header rules panel (auto rules stay read-only)', async () => {
    const rules: RuleDto[] = [
      {
        id: 'r-hdr',
        matchType: 'header',
        headerName: 'x-polyrouter-tier',
        headerValue: 'heavy',
        target: 'tier:heavy',
        priority: 0,
        createdAt: NOW,
      },
      {
        id: 'r-auto',
        matchType: 'auto_high',
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
      expect(host.textContent).toContain('tier:heavy'); // the header rule is shown + deletable
      expect(host.textContent).not.toContain('auto-band-xyz'); // the auto rule is not (no delete)
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
