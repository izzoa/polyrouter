import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import type { InflightRow } from './data/api';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

function mount(store: AppStore): { host: HTMLElement; dispose: () => void } {
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
    dispose: () => {
      dispose();
      host.remove();
    },
  };
}

const liveRow = (over: Partial<InflightRow> = {}): InflightRow => ({
  id: 'live-1',
  startedAt: Date.now() - 3_000,
  decisionLayer: 'cascade',
  tierAssigned: 'utility',
  modelLabel: 'minimax/minimax-m3',
  providerLabel: 'Openrouter',
  protocol: 'openai',
  status: 'running',
  ...over,
});

/** add-inflight-requests: the Overview card's live rows. `live={false}` keeps the
 * page's own pollers off, so each test drives `loadInflight()` explicitly. */
describe('Overview in-flight rows', () => {
  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset['theme'];
  });

  it('renders a Running row with its route metadata and no token/cost figures', async () => {
    const client = new FakeApiClient({
      inflight: { items: [liveRow()], available: true, truncated: false },
    });
    const store = createAppStore(client);
    const { host, dispose } = mount(store);
    try {
      await flush();
      await store.loadInflight();
      await flush();
      const row = host.querySelector<HTMLElement>('.req-row');
      expect(row).not.toBeNull();
      expect(row!.textContent).toContain('Running');
      expect(row!.textContent).toContain('minimax/minimax-m3');
      expect(row!.textContent).toContain('Openrouter');
      expect(row!.textContent).toContain('utility');
      expect(row!.textContent).toContain('—'); // token/cost placeholders
    } finally {
      dispose();
    }
  });

  it('places live rows ABOVE the completed rows', async () => {
    const client = new FakeApiClient({
      inflight: { items: [liveRow()], available: true, truncated: false },
    });
    const store = createAppStore(client);
    const { host, dispose } = mount(store);
    try {
      await flush(); // completed rows load via the Overview's own fetch
      await store.loadInflight();
      await flush();
      const rows = [...host.querySelectorAll<HTMLElement>('.req-row')];
      expect(rows.length).toBeGreaterThan(1); // live + completed
      expect(rows[0]!.textContent).toContain('Running'); // live is first
    } finally {
      dispose();
    }
  });

  it('a running row is NOT selectable (no inspector), unlike a completed row', async () => {
    const client = new FakeApiClient({
      inflight: { items: [liveRow()], available: true, truncated: false },
    });
    const store = createAppStore(client);
    const { host, dispose } = mount(store);
    try {
      await flush();
      await store.loadInflight();
      await flush();
      const first = host.querySelector<HTMLElement>('.req-row')!;
      expect(first.textContent).toContain('Running');
      expect(first.tagName).not.toBe('BUTTON'); // completed rows are <button>
      first.click();
      await flush();
      expect(store.state.selId).toBeNull(); // no inspector opened
    } finally {
      dispose();
    }
  });

  it('an unavailable (degraded) snapshot renders the card exactly as today', async () => {
    const client = new FakeApiClient({
      inflight: { items: [], available: false, truncated: false },
    });
    const store = createAppStore(client);
    const { host, dispose } = mount(store);
    try {
      await flush();
      await store.loadInflight();
      await flush();
      expect(store.state.inflightRows).toHaveLength(0);
      expect(host.textContent).not.toContain('Running');
    } finally {
      dispose();
    }
  });
});
