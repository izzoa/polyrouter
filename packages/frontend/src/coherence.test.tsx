import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { AgentDto, BudgetDto, ChannelDto } from './data/api';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

const BUDGET: BudgetDto = {
  id: 'b1',
  name: 'monthly cap',
  scope: 'global',
  agentId: null,
  window: 'month',
  action: 'block',
  amount: 10,
  notifyChannelIds: [],
  enabled: true,
  createdAt: new Date(2026, 0, 1).toISOString(),
};

const AGENT: AgentDto = {
  id: 'a1',
  name: 'openclaw',
  harness: 'other',
  prefix: 'poly_abc',
  lastUsedAt: null,
  createdAt: new Date(2026, 0, 1).toISOString(),
};

const CHANNEL: ChannelDto = {
  id: 'c1',
  name: 'homelab email',
  kind: 'smtp',
  enabled: true,
  eventsSubscribed: ['budget_alert'],
  hasConfig: true,
  lastTestAt: null,
  lastTestStatus: null,
};

function mount(client: FakeApiClient): {
  host: HTMLElement;
  store: AppStore;
  dispose: () => void;
} {
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
  return {
    host,
    store,
    dispose: () => {
      dispose();
      host.remove();
    },
  };
}

function clickDelete(host: HTMLElement): void {
  const btn = [...host.querySelectorAll<HTMLButtonElement>('button.btn-ghost--amber')].find(
    (b) => b.textContent?.trim() === 'Delete',
  );
  expect(btn).not.toBeUndefined();
  btn?.click();
}

describe('destructive actions are confirmed (dashboard-core coherence)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    delete document.documentElement.dataset['theme'];
  });

  it('declining the budget confirm sends no delete; accepting sends one', async () => {
    const client = new FakeApiClient({ budgets: [BUDGET] });
    const { host, store, dispose } = mount(client);
    try {
      await flush();
      store.go('limits');
      await flush();

      const declined = vi.fn().mockReturnValue(false);
      vi.stubGlobal('confirm', declined);
      clickDelete(host);
      await flush();
      expect(client.countOf('deleteBudget')).toBe(0);
      expect(declined).toHaveBeenCalledWith(
        'Delete budget "monthly cap"? New requests will no longer be enforced by it.',
      );

      vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
      clickDelete(host);
      await flush();
      expect(client.countOf('deleteBudget')).toBe(1);
    } finally {
      dispose();
    }
  });

  it('declining the channel confirm sends no delete; accepting sends one', async () => {
    const client = new FakeApiClient({ channels: [CHANNEL] });
    const { host, store, dispose } = mount(client);
    try {
      await flush();
      store.go('settings');
      await flush();

      const declined = vi.fn().mockReturnValue(false);
      vi.stubGlobal('confirm', declined);
      clickDelete(host);
      await flush();
      expect(client.countOf('deleteChannel')).toBe(0);
      expect(declined).toHaveBeenCalledWith(
        'Delete channel "homelab email"? Future alerts will no longer be delivered to it.',
      );

      vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
      clickDelete(host);
      await flush();
      expect(client.countOf('deleteChannel')).toBe(1);
    } finally {
      dispose();
    }
  });

  it('Delete (not Rotate key) carries the destructive treatment on Agents', async () => {
    const client = new FakeApiClient({ agents: [AGENT] });
    const { host, store, dispose } = mount(client);
    try {
      await flush();
      store.go('agents');
      await flush();
      const amber = [...host.querySelectorAll<HTMLButtonElement>('button.btn-ghost--amber')];
      expect(amber.some((b) => b.textContent?.trim() === 'Rotate key')).toBe(false);
      expect(amber.some((b) => b.textContent?.trim() === 'Delete')).toBe(true);
      const rotate = [...host.querySelectorAll<HTMLButtonElement>('button.btn-ghost')].find(
        (b) => b.textContent?.trim() === 'Rotate key',
      );
      expect(rotate).not.toBeUndefined();
    } finally {
      dispose();
    }
  });
});
