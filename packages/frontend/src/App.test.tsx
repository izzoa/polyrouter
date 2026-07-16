import { APP_NAME } from '@polyrouter/shared';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChannelDto, ModelDto, RuleDto, TierDto, TierEntryDto } from './data/api';
import { App } from './App';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';

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
      expect(host.textContent).toContain('Log prompt & response bodies');
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

  it('toggles the theme, persists it, and re-applies it on a fresh mount', async () => {
    const first = mount();
    try {
      await flush();
      clickByText(first.host, '.theme-toggle span', 'Switch to dark');
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
      const addViaSelect = (): void => {
        const select = firstTierCard.querySelector<HTMLSelectElement>('select');
        if (!select) throw new Error('add-model select missing');
        const option = [...select.options].find((o) => o.value !== '');
        if (!option) throw new Error('no addable models left');
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const rows = () => firstTierCard.querySelectorAll('.chain-row').length;
      const start = rows();
      expect(start).toBe(3);
      addViaSelect();
      addViaSelect();
      expect(rows()).toBe(5);
      addViaSelect();
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
      },
    });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      expect(host.textContent).toContain('off instance-wide (ROUTING_AUTO_LAYERS)');
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
