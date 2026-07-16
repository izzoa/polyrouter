import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { ApiError } from './data/api';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

function mount(store: AppStore): { host: HTMLElement; store: AppStore; dispose: () => void } {
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

function clickNav(host: HTMLElement, label: string): void {
  const el = [...host.querySelectorAll<HTMLElement>('.nav-item span')].find(
    (e) => e.textContent?.trim() === label,
  );
  if (!el) throw new Error(`no nav item "${label}"`);
  el.click();
}

function clickText(host: HTMLElement, selector: string, text: string): void {
  const el = [...host.querySelectorAll<HTMLElement>(selector)].find(
    (e) => e.textContent?.trim() === text,
  );
  if (!el) throw new Error(`no ${selector} with text "${text}"`);
  el.click();
}

describe('Observe pages render real analytics', () => {
  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset['theme'];
  });

  it('Overview shows real summary numbers (not seeds)', async () => {
    const { host, dispose } = mount(createAppStore(new FakeApiClient()));
    try {
      await flush();
      expect(host.textContent).toContain('$12.50'); // DEFAULT_SUMMARY.spend
      expect(host.querySelector('.req-row')).not.toBeNull(); // real recent rows
      expect(host.querySelector('.uplot')).not.toBeNull(); // the chart mounted
    } finally {
      dispose();
    }
  });

  it('Costs shows real spend and the free/paid/unpriced split', async () => {
    const { host, dispose } = mount(createAppStore(new FakeApiClient()));
    try {
      await flush();
      clickNav(host, 'Costs');
      await flush();
      expect(host.textContent).toContain('$12.50');
      expect(host.textContent).toContain('% free');
      expect(host.textContent).toContain('% unpriced');
    } finally {
      dispose();
    }
  });

  it('shows a visible error + retry on a failing load, then recovers', async () => {
    const fake = new FakeApiClient({ analyticsFailure: new ApiError(500, 'Internal', 'boom') });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      expect(host.textContent).toContain('load analytics');
      expect(host.textContent).toContain('boom');
      fake.analyticsFailure = null;
      clickText(host, 'span', 'Retry');
      await flush();
      expect(host.textContent).toContain('$12.50');
    } finally {
      dispose();
    }
  });

  it('Requests "Load more" appends the next page over a frozen window', async () => {
    const { host, store, dispose } = mount(createAppStore(new FakeApiClient()));
    try {
      await flush();
      clickNav(host, 'Requests');
      await flush();
      expect(host.querySelectorAll('.req-row').length).toBe(25);
      clickText(host, 'span', 'Load more');
      await flush();
      expect(host.querySelectorAll('.req-row').length).toBe(30);
      expect(new Set(store.state.requestList.map((r) => r.id)).size).toBe(30);
    } finally {
      dispose();
    }
  });

  it('a filter chip narrows the list via the fake server-side filter', async () => {
    const { host, store, dispose } = mount(createAppStore(new FakeApiClient()));
    try {
      await flush();
      clickNav(host, 'Requests');
      await flush();
      clickText(host, 'div', 'Fallbacks');
      await flush();
      expect(store.state.requestList.length).toBeGreaterThan(0);
      expect(store.state.requestList.every((r) => r.status === 'fallback')).toBe(true);
      expect(host.querySelectorAll('.req-row').length).toBe(store.state.requestList.length);
    } finally {
      dispose();
    }
  });
});
