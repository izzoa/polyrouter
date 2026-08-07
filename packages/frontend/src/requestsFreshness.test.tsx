/** Requests-page freshness (add-requests-freshness).
 *
 * The page froze `{from, to}` at load and nothing ever triggered another reset, so it
 * silently stopped being true the moment you opened it. Overview never had that problem —
 * not because its window is unfrozen, but because `loadRecentRequests` re-derives its range
 * on every call and its poller runs continuously. The difference was refresh, not freezing.
 *
 * Two behaviours, because one cannot serve both states: refresh when the user has not paged,
 * disclose when they have. Discarding pages they explicitly asked for in order to show
 * fresher rows is the worse trade.
 */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import type { RequestsPage, RequestsQuery } from './data/api';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';
import type { EventSourceLike } from './data/eventStream';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

interface H {
  host: HTMLElement;
  store: AppStore;
  fake: FakeApiClient;
  dispose: () => void;
}

async function mountRequests(fake = new FakeApiClient({})): Promise<H> {
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
    .find((e) => e.textContent?.trim() === 'Requests')
    ?.click();
  await flush();
  return { host, store, fake, dispose: () => { dispose(); host.remove(); } };
}

const listIds = (store: AppStore): string[] => store.state.requestList.map((r) => r.id);
const reqCalls = (f: FakeApiClient): { method: string; args: unknown[] }[] =>
  f.callLog.filter((c) => c.method === 'requests');

afterEach(() => {
  document.body.innerHTML = '';
});

describe('an unpaged list does not go stale', () => {
  it('picks up a request that completed after the page loaded', async () => {
    // THE red test. Before this change nothing on the page ever triggered another reset,
    // so a request settling now could never appear — the window excluded it by construction.
    const h = await mountRequests();
    try {
      const before = listIds(h.store);
      expect(before).not.toContain('SETTLED-AFTER-LOAD');

      h.fake.requestRows = [
        { ...h.fake.requestRows[0]!, id: 'SETTLED-AFTER-LOAD' },
        ...h.fake.requestRows,
      ];
      await h.store.refreshRequestsPage();
      await flush();

      expect(listIds(h.store), 'the page is still frozen at load').toContain(
        'SETTLED-AFTER-LOAD',
      );
    } finally {
      h.dispose();
    }
  });

  it('refreshes through the SHARED budget, which floors a burst', async () => {
    const h = await mountRequests();
    try {
      const before = reqCalls(h.fake).length;
      // Ten settlements in quick succession must not become ten queries.
      for (let i = 0; i < 10; i++) {
        await h.store.requestAggregateRefresh(() => h.store.refreshRequestsPage());
      }
      await flush();
      const added = reqCalls(h.fake).length - before;
      expect(added, 'a burst became a query per settlement').toBeLessThan(10);
    } finally {
      h.dispose();
    }
  });
});

/** Moves the frozen window's upper bound into the past.
 *
 * `probeNewRequests` returns early when `now <= window.to` — correctly, since nothing can have
 * settled inside a range that has not opened yet. But `loadRequests(true)` freezes `to` at the
 * instant it runs, and these tests probe microseconds later, so the two timestamps land in the
 * same MILLISECOND often enough to flake: the probe issues no query and the assertions read as
 * a regression. Backdating the boundary makes the range non-empty by construction, and makes
 * the probe's `from` a known value rather than whatever the clock happened to say. */
function backdateWindow(store: AppStore, ms = 1000): void {
  const w = store.state.requestWindow;
  if (w === null) throw new Error('no frozen window to backdate — the fixture did not load');
  store.setState('requestWindow', { ...w, to: new Date(Date.now() - ms).toISOString() });
}

describe('a paged list is disclosed to, never discarded', () => {
  /** Page 1, then "Load more", so a paging session is genuinely in progress. */
  async function paged(): Promise<H> {
    const h = await mountRequests();
    await h.store.loadRequests(false);
    await flush();
    expect(h.store.state.requestsPaged, 'fixture did not enter a paging session').toBe(true);
    return h;
  }

  it('does not reset a paged list, and offers a count instead', async () => {
    const h = await paged();
    try {
      backdateWindow(h.store);
      const rows = listIds(h.store);
      const cursor = h.store.state.requestCursor;
      const window = { ...h.store.state.requestWindow };

      await h.store.refreshRequestsPage();
      await flush();

      expect(listIds(h.store), 'the user’s pages were discarded').toEqual(rows);
      expect(h.store.state.requestCursor).toBe(cursor);
      expect({ ...h.store.state.requestWindow }).toEqual(window);
      expect(h.store.state.requestsNew, 'nothing was disclosed').not.toBeNull();
    } finally {
      h.dispose();
    }
  });

  it('probes the complementary range, carrying the frozen filter', async () => {
    // Filter FIRST, then page: a filter change resets, which would end the paging session
    // and turn the refresh back into a reset.
    const h = await mountRequests();
    try {
      h.store.setFilter('escalated');
      await flush();
      await h.store.loadRequests(true); // settle the reset so the window carries the filter
      expect(h.store.state.requestWindow?.filter).toBe('escalated');
      // Enter the paging session directly. How it began is the append-race test's subject;
      // this one is about the probe's QUERY, and the `escalated` filter yields fewer than a
      // page in the fixture, so a real "load more" would have no cursor to follow.
      h.store.setState('requestsPaged', true);
      backdateWindow(h.store);

      const before = reqCalls(h.fake).length;
      await h.store.refreshRequestsPage();
      await flush();

      // Exactly the calls this refresh made — not `.at(-1)` on the whole log, which can
      // pick up an append the filter-change effect issued.
      const made = reqCalls(h.fake).slice(before);
      expect(made, 'the refresh issued no query').toHaveLength(1);
      const q = made[0]?.args[0] as Record<string, unknown>;
      // `[window.to, now)` — exactly complementary to the list's `[window.from, window.to)`,
      // because the API's range is half-open. And the window's FROZEN filter, or it would
      // count rows the filtered list would never show.
      expect(q['from']).toBe(h.store.state.requestWindow?.to);
      expect(q['escalated']).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it('taking the offer resets to a fresh page 1 and ends the session', async () => {
    const h = await paged();
    try {
      await h.store.loadRequests(true);
      await flush();
      expect(h.store.state.requestsPaged).toBe(false);
      expect(h.store.state.requestsNew, 'a stale disclosure survived the reset').toBeNull();
    } finally {
      h.dispose();
    }
  });

  it('a FAILED probe still discloses, rather than reading as up to date', async () => {
    // Silence here would present a stale list as current — the thing this prevents.
    const h = await paged();
    try {
      class Failing extends FakeApiClient {
        override requests(_q: RequestsQuery): Promise<RequestsPage> {
          return Promise.reject(new Error('probe failed'));
        }
      }
      h.store.setState('requestsNew', null);
      const failing = new Failing({});
      // Drive the probe against a failing client via a fresh store sharing the window.
      const h2 = await mountRequests(failing);
      try {
        h2.store.setState('requestWindow', { ...h.store.state.requestWindow! });
        h2.store.setState('requestsPaged', true);
        backdateWindow(h2.store);
        await h2.store.refreshRequestsPage();
        await flush();
        expect(h2.store.state.requestsNew?.unknown, 'a failed probe read as “nothing new”').toBe(
          true,
        );
      } finally {
        h2.dispose();
      }
    } finally {
      h.dispose();
    }
  });
});

describe('the wiring the feature hangs on', () => {
  /** Minimal controllable EventSource, installed via `setStreamFactory`. */
  class FakeStreamSource implements EventSourceLike {
    readonly listeners = new Map<string, ((ev: MessageEvent<string>) => void)[]>();
    onerror: ((ev: unknown) => void) | null = null;
    constructor(readonly url: string) {}
    addEventListener(type: string, fn: (ev: MessageEvent<string>) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    }
    close(): void {
      this.listeners.clear();
    }
    emit(type: string, data: unknown): void {
      for (const fn of this.listeners.get(type) ?? [])
        fn(new MessageEvent<string>(type, { data: JSON.stringify(data) }));
    }
  }

  it('an analytics.invalidated nudge reaches the Requests page', async () => {
    // `currentAggregateLoader()` returned null for `requests`, which is why the nudge was
    // silently dropped there. Calling `refreshRequestsPage()` directly would pass even with
    // that seam unwired — so drive the REAL path.
    const fake = new FakeApiClient({});
    const store = createAppStore(fake);
    const sources: FakeStreamSource[] = [];
    store.setStreamFactory((url) => {
      const src = new FakeStreamSource(url);
      sources.push(src);
      return src;
    });
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
      .find((e) => e.textContent?.trim() === 'Requests')
      ?.click();
    await flush();
    store.connectStream();
    await flush();

    fake.requestRows = [{ ...fake.requestRows[0]!, id: 'VIA-NUDGE' }, ...fake.requestRows];
    sources.at(-1)?.emit('analytics.invalidated', {});
    await flush();

    expect(listIds(store), 'the nudge never reached this page').toContain('VIA-NUDGE');
    store.disconnectStream();
    dispose();
    host.remove();
  });
});

describe('the append race', () => {
  it('a refresh landing mid-append does not discard the append', async () => {
    // `requestsPaged` is set when the append STARTS. Recording it on commit would leave a
    // window where a poll resets the list and silently undoes the click.
    const h = await mountRequests();
    try {
      const appending = h.store.loadRequests(false); // in flight
      // The poll fires before it lands.
      await h.store.refreshRequestsPage();
      await appending;
      await flush();

      expect(
        h.store.state.requestList.length,
        'the refresh reset the list and threw away the page being loaded',
      ).toBeGreaterThan(25);
    } finally {
      h.dispose();
    }
  });
});

describe('a settled request stops claiming to be running', () => {
  it('renders a settling row as finishing, on both surfaces', async () => {
    for (const page of ['Requests', 'Overview'] as const) {
      const fake = new FakeApiClient({});
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
        .find((e) => e.textContent?.trim() === page)
        ?.click();
      await flush();

      store.setState('inflightRows', [
        {
          id: 'settling-1',
          startedAt: Date.now() - 1000,
          decisionLayer: 'explicit',
          tierAssigned: 'default',
          modelLabel: 'model-settling',
          providerLabel: 'p',
          protocol: 'openai',
          status: 'running',
          phase: 'settling',
        },
      ]);
      await flush();

      const row = [...host.querySelectorAll<HTMLElement>('.req-row')].find((r) =>
        r.textContent?.includes('model-settling'),
      );
      expect(row, `${page}: the settling row did not render`).toBeDefined();
      expect(row?.textContent, `${page}: a finished request still says Running`).not.toContain(
        'Running',
      );
      expect(row?.textContent).toContain('Finishing');

      dispose();
      host.remove();
    }
  });
});
