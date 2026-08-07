/** The request view is identity-scoped (fix-request-view-identity-scope).
 *
 * Two things survived an account change before this: the paginated request list, and — the
 * severe half — the inspector's cached payloads, which hold `content: string`, the actual
 * prompt and response text. That is the one category of data the system otherwise refuses
 * to persist at all.
 *
 * The races here are driven DELIBERATELY with a per-call deferred fake. A test that merely
 * signs out and asserts an empty list would pass without the fix and prove nothing: the
 * defect is a response committing AFTER the boundary, which only a held response reproduces.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { RequestBodyContent, RequestsPage, RequestsQuery } from './data/api';
import { createAppStore, type AppStore } from './state/appState';
import { DEFAULT_SESSION, FakeApiClient } from './test/fakeClient';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Holds each `requests` / `requestBodies` call open individually, so a response can be
 *  landed AFTER an identity change rather than merely before one. */
class HeldClient extends FakeApiClient {
  readonly pages: ((p: RequestsPage) => void)[] = [];
  readonly bodies: ((b: RequestBodyContent[]) => void)[] = [];
  hold = true;

  override requests(query: RequestsQuery): Promise<RequestsPage> {
    if (!this.hold) return super.requests(query);
    return new Promise((resolve) => this.pages.push(resolve));
  }
  override requestBodies(id: string): Promise<RequestBodyContent[]> {
    if (!this.hold) return super.requestBodies(id);
    return new Promise((resolve) => this.bodies.push(resolve));
  }
}

const PAGE = (ids: string[]): RequestsPage => ({
  rows: ids.map((id) => ({
    ...({} as Record<string, never>),
    id,
    createdAt: '2026-08-07T00:00:00.000Z',
    agentLabel: 'a',
    modelLabel: 'm',
    providerLabel: 'p',
    tierAssigned: 'default',
    decisionLayer: 'explicit',
    routingReason: 'r',
    status: 'success',
    inputTokens: 1,
    outputTokens: 1,
    cost: 0,
    durationMs: 1,
    escalated: false,
    hasBodies: true,
  })) as RequestsPage['rows'],
  nextCursor: 'cursor-1',
});

const SECRET: RequestBodyContent[] = [
  { direction: 'request', content: 'ACCOUNT-A PROMPT TEXT', bytes: 21, truncated: false, partial: false },
];

/** Switch the signed-in principal, which is what triggers the identity reset. */
async function switchAccount(store: AppStore, client: FakeApiClient): Promise<void> {
  client.session = { ...DEFAULT_SESSION, userId: 'user-B', email: 'b@x.test' };
  await store.bootstrap();
  await flush();
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('a request-list load begun under a previous account cannot commit', () => {
  it('discards a RESET response that lands after the account changed', async () => {
    const client = new HeldClient({});
    const store = createAppStore(client);
    await store.bootstrap();

    void store.loadRequests(true); // begun as A
    await flush();
    expect(client.pages, 'the load did not reach the client').toHaveLength(1);

    client.hold = false;
    await switchAccount(store, client);

    // A's response lands only now.
    client.pages[0]?.(PAGE(['A-ROW-1', 'A-ROW-2']));
    await flush();

    const ids = store.state.requestList.map((r) => r.id);
    expect(ids, "a previous account's rows were committed").not.toContain('A-ROW-1');
  });

  it('discards an APPEND response that lands after the account changed', async () => {
    // "Load more" is a second loader with the same gap.
    const client = new HeldClient({});
    const store = createAppStore(client);
    await store.bootstrap();

    void store.loadRequests(true);
    await flush();
    client.pages[0]?.(PAGE(['A-ROW-1']));
    await flush();
    expect(store.state.requestCursor).not.toBeNull();

    void store.loadRequests(false); // append, begun as A
    await flush();
    expect(client.pages).toHaveLength(2);

    client.hold = false;
    await switchAccount(store, client);

    client.pages[1]?.(PAGE(['A-ROW-APPENDED']));
    await flush();
    expect(store.state.requestList.map((r) => r.id)).not.toContain('A-ROW-APPENDED');
  });
});

describe('committed request state is cleared at the boundary', () => {
  it('clears the list, its cursor and its frozen window', async () => {
    const client = new HeldClient({});
    const store = createAppStore(client);
    await store.bootstrap();

    void store.loadRequests(true);
    await flush();
    client.pages[0]?.(PAGE(['A-ROW-1']));
    await flush();
    expect(store.state.requestList).toHaveLength(1);
    expect(store.state.requestWindow).not.toBeNull();

    client.hold = false;
    await switchAccount(store, client);

    // Guarding the in-flight response alone would leave these on screen.
    expect(store.state.requestList, "A's committed rows survived").toEqual([]);
    expect(store.state.requestCursor).toBeNull();
    expect(
      store.state.requestWindow,
      "a window frozen under A would scope B's first load-more to a range B never chose",
    ).toBeNull();
  });

  it('does not latch the loading indicator', async () => {
    // Bumping the generation makes the superseded loader's `finally` inert BY DESIGN, so
    // without an explicit reset the page spins forever after a mid-load account change.
    const client = new HeldClient({});
    const store = createAppStore(client);
    await store.bootstrap();

    void store.loadRequests(true);
    await flush();
    expect(store.state.requestListLoading).toBe(true);

    client.hold = false;
    await switchAccount(store, client);
    client.pages[0]?.(PAGE(['A-ROW-1']));
    await flush();

    expect(store.state.requestListLoading, 'the page is stuck loading forever').toBe(false);
    expect(store.state.requestListError).toBeNull();
  });

  it('keeps the filter — a display preference is not another account’s data', async () => {
    const client = new HeldClient({});
    const store = createAppStore(client);
    await store.bootstrap();
    store.setState('reqFilter', 'escalated');

    client.hold = false;
    await switchAccount(store, client);

    expect(store.state.reqFilter, 'the filter was cleared unnecessarily').toBe('escalated');
  });
});

describe("the inspector's cached payloads — the severe half", () => {
  it('clears selected payload TEXT at the boundary', async () => {
    const client = new HeldClient({});
    const store = createAppStore(client);
    await store.bootstrap();

    store.select('A-ROW-1');
    void store.loadSelectedBodies('A-ROW-1');
    await flush();
    client.bodies[0]?.(SECRET);
    await flush();
    expect(store.state.selBodies.rows, 'fixture did not load the payload').not.toBeNull();

    client.hold = false;
    await switchAccount(store, client);

    expect(store.state.selId, "the previous account's selection survived").toBeNull();
    expect(
      JSON.stringify(store.state.selBodies.rows ?? []),
      "a previous account's PROMPT TEXT is still in the store",
    ).not.toContain('ACCOUNT-A PROMPT TEXT');
  });

  it('discards a payload response that lands after the account changed', async () => {
    const client = new HeldClient({});
    const store = createAppStore(client);
    await store.bootstrap();

    store.select('A-ROW-1');
    void store.loadSelectedBodies('A-ROW-1');
    await flush();
    expect(client.bodies).toHaveLength(1);

    client.hold = false;
    await switchAccount(store, client);

    client.bodies[0]?.(SECRET);
    await flush();
    expect(JSON.stringify(store.state.selBodies.rows ?? [])).not.toContain(
      'ACCOUNT-A PROMPT TEXT',
    );
  });
});
