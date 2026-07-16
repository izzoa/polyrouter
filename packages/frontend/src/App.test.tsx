import { APP_NAME } from '@polyrouter/shared';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
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

  it('opens the inspector on a structural request and shows the L1 evidence', async () => {
    const store = createAppStore(new FakeApiClient());
    for (let guard = 0; guard < 100; guard++) {
      if (store.state.requests.some((r) => r.layer === 'structural')) break;
      store.pushLiveRequest();
    }
    const { host, dispose } = mount(store);
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Requests');
      const index = store.state.requests.findIndex((r) => r.layer === 'structural');
      expect(index).toBeGreaterThanOrEqual(0);
      const row = host.querySelectorAll<HTMLElement>('.req-row')[index];
      expect(row).toBeDefined();
      row?.click();
      expect(store.state.selId).toBe(store.state.requests[index]?.id);
      const drawer = host.querySelector('.drawer');
      expect(drawer).not.toBeNull();
      expect(drawer?.textContent).toContain('Decision trace');
      expect(drawer?.textContent).toContain('Structural features (L1)');
      expect(drawer?.textContent).toContain('price snapshot');
      expect(drawer?.textContent).toContain('routing decision');
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
    const { host, dispose } = mount();
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
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
      addViaSelect();
      addViaSelect();
      expect(rows()).toBe(Math.min(5, start + 2));
      addViaSelect();
      expect(rows()).toBe(5);
      expect(host.querySelector('.toast')?.textContent).toBe('Max 5 models per tier');
    } finally {
      dispose();
    }
  });
});
