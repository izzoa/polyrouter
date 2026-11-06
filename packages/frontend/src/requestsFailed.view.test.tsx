/** The Requests list's failed state (adopt-figure-states task 3.5; dashboard-core "Failed,
 * unavailable and absent figures are distinct states").
 *
 * A failed page-1 load used to keep the rows it would have replaced on screen, as if current,
 * under a notice quoting the raw error. Now it removes them under a neutral notice; a failed
 * load-more keeps the pages already loaded, which were not part of the failed read; and the
 * notice's Retry reloads page 1 and leaves focus on the table, not on <body>.
 */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { ApiError, type RequestsPage, type RequestsQuery } from './data/api';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';
import { labelText } from './test/labelText';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A fake whose request listings can be held in flight and released. */
class HeldRequests extends FakeApiClient {
  hold = false;
  private parked: (() => void)[] = [];
  override requests(query: RequestsQuery): Promise<RequestsPage> {
    if (!this.hold) return super.requests(query);
    return new Promise<RequestsPage>((resolve, reject) => {
      this.parked.push(() => {
        super.requests(query).then(resolve, reject);
      });
    });
  }
  release(): void {
    this.hold = false;
    for (const go of this.parked.splice(0)) go();
  }
}

interface H {
  host: HTMLElement;
  store: AppStore;
  fake: HeldRequests;
  dispose: () => void;
}

async function openRequests(): Promise<H> {
  const fake = new HeldRequests({});
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
    (e) => labelText(e) === 'Requests',
  );
  if (!nav) throw new Error('no Requests nav item');
  nav.click();
  await flush();
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

const rows = (h: H): HTMLElement[] => [
  ...h.host.querySelectorAll<HTMLElement>('.rs-table-requests .req-row'),
];
const tablePanel = (h: H): HTMLElement => h.host.querySelector<HTMLElement>('.rs-table-requests')!;
const notice = (h: H): HTMLElement | null =>
  [...h.host.querySelectorAll<HTMLElement>('.notice')].find(
    (n) => n.querySelector('.notice-title')?.textContent === 'Couldn’t load',
  ) ?? null;
const lastRequestsQuery = (h: H): RequestsQuery | undefined =>
  h.fake.callLog.filter((c) => c.method === 'requests').at(-1)?.args[0] as
    RequestsQuery | undefined;

describe('the Requests list names its failed state', () => {
  let h: H | null = null;
  afterEach(() => {
    h?.dispose();
    h = null;
  });

  it('a failed page-1 load removes the rows under a neutral notice; Retry reloads page 1 and leaves focus on the table', async () => {
    h = await openRequests();
    expect(rows(h)).toHaveLength(25);

    h.fake.analyticsFailure = new ApiError(500, 'Internal', 'requests down');
    await h.store.loadRequests(true);
    await flush();
    const n = notice(h);
    expect(n, 'the failure notice').not.toBeNull();
    expect(n!.getAttribute('role')).toBe('status');
    expect(n!.querySelector('.notice-body')?.textContent).toBe(
      'Requests couldn’t be loaded. Routing is unaffected.',
    );
    expect(n!.textContent).not.toContain('requests down');
    // The rows it would have replaced are gone, and the list claims nothing in their place.
    expect(rows(h)).toHaveLength(0);
    expect(h.store.state.requestCursor).toBeNull();
    expect(tablePanel(h).textContent).not.toMatch(/No requests match|No completed|Loading…/);
    expect(h.host.textContent).not.toContain('Load more');

    // Retry, focused before the click: page 1 reloads, the notice goes, and focus lands on
    // the requests table panel, never <body>.
    h.fake.analyticsFailure = null;
    h.fake.hold = true;
    const retry = [...n!.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => labelText(b) === 'Retry',
    )!;
    retry.focus();
    retry.click();
    await Promise.resolve();
    expect(notice(h)).toBeNull();
    expect(tablePanel(h).getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(tablePanel(h));
    const query = lastRequestsQuery(h);
    expect(query, 'Retry issued a listing').toBeDefined();
    expect(query!.cursor, 'Retry reloads page 1').toBeUndefined();
    h.fake.release();
    await flush();
    expect(rows(h)).toHaveLength(25);
    expect(document.activeElement).toBe(tablePanel(h));
  });

  // A background refresh (the freshness poll, the `analytics.invalidated` nudge) is a page-1
  // reload, so a rejected one removes the list's rows. It must not close the inspector the
  // user is reading, and the next good read must not reopen it by itself and take focus.
  it('an open inspector survives a failed background refresh, and a later good one does not move focus', async () => {
    h = await openRequests();
    const target = rows(h)[19]!;
    target.click();
    await flush();
    const selId = h.store.state.selId;
    expect(selId, 'a row beyond Overview’s recent six').not.toBeNull();
    expect(h.store.state.recentRequests.some((r) => r.id === selId)).toBe(false);
    const drawer = h.host.querySelector<HTMLElement>('#inspector-drawer');
    expect(drawer, 'the inspector opened').not.toBeNull();
    const inside = drawer!.querySelector<HTMLButtonElement>('button')!;
    inside.focus();
    expect(document.activeElement).toBe(inside);

    h.fake.analyticsFailure = new ApiError(500, 'Internal', 'requests down');
    await h.store.refreshRequestsPage();
    await flush();
    expect(h.store.state.requestList).toHaveLength(0);
    // Still open, the same drawer, with focus where the user left it.
    expect(h.host.querySelector('#inspector-drawer')).toBe(drawer);
    expect(document.activeElement).toBe(inside);

    h.fake.analyticsFailure = null;
    await h.store.refreshRequestsPage();
    await flush();
    expect(rows(h)).toHaveLength(25);
    // Not remounted (which would focus its root), and focus never moved.
    expect(h.host.querySelector('#inspector-drawer')).toBe(drawer);
    expect(document.activeElement).toBe(inside);

    // The kept row belongs to its own selection only: another id never shows it.
    h.store.select('no-such-request');
    await flush();
    expect(h.host.querySelector('#inspector-drawer')).toBeNull();

    // Closing still closes it, and nothing reopens it.
    h.store.select(null);
    await flush();
    expect(h.host.querySelector('#inspector-drawer')).toBeNull();
    await h.store.refreshRequestsPage();
    await flush();
    expect(h.host.querySelector('#inspector-drawer')).toBeNull();
  });

  it('a failed load-more keeps the pages already loaded', async () => {
    h = await openRequests();
    expect(rows(h)).toHaveLength(25);
    const before = h.store.state.requestList.map((r) => r.id);
    h.fake.analyticsFailure = new ApiError(500, 'Internal', 'requests down');
    const more = [...h.host.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => labelText(b) === 'Load more',
    )!;
    more.click();
    await flush();
    expect(notice(h)?.querySelector('.notice-body')?.textContent).toBe(
      'Requests couldn’t be loaded. Routing is unaffected.',
    );
    expect(h.store.state.requestList.map((r) => r.id)).toEqual(before);
    expect(rows(h)).toHaveLength(25);
  });
});
