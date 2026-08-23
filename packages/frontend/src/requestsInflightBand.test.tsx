/** The Requests page's in-flight band (add-requests-inflight-band).
 *
 * Two things here are easy to get wrong in ways that look fine:
 *
 * The **dedupe** is not decorative. Running entries and durable rows are disjoint at source
 * — the log is written only at the terminal outcome — but the shared set also carries
 * SETTLING rows, and those do have durable counterparts. The Requests window freezes at
 * `to = now`, so arriving at the page mid-handoff re-freezes it to include the very row the
 * band is still showing. That is the collision, and it is reachable by the most ordinary
 * action there is: navigating to the page.
 *
 * The **projection** must not write back. A row hidden here has to stay available to the
 * Overview card, so filtering and deduping happen over `state.inflightRows` at render time
 * rather than inside the shared fold.
 */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { filterToRequestParams } from './data/analytics';
import { projectInflightRows, type InflightDisplayRow, type InflightPhase } from './data/inflight';
import type { InflightRow } from './data/api';
import type { EventSourceLike } from './data/eventStream';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Rows carry no id attribute in the DOM, so the model label is how a specific live row
 *  is identified on screen — make it unique per fixture row. */
const row = (
  id: string,
  layer = 'explicit',
  phase: InflightPhase = 'live',
): InflightDisplayRow => ({
  phase,
  id,
  startedAt: Date.now(),
  decisionLayer: layer,
  tierAssigned: 'default',
  modelLabel: `model-${id}`,
  providerLabel: 'ProvA',
  protocol: 'openai',
  status: 'running',
});

async function mountRequests(fake = new FakeApiClient({})): Promise<{
  host: HTMLElement;
  store: AppStore;
  fake: FakeApiClient;
  dispose: () => void;
}> {
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

/** Every row rendered in the table — band and list together, in DOM order. */
const rowsOf = (host: HTMLElement): HTMLElement[] => [
  ...host.querySelectorAll<HTMLElement>('.rs-table-requests .req-row'),
];
/** Whether a live row with this id is on screen, found by its unique model label. */
const showsLive = (host: HTMLElement, id: string): boolean =>
  rowsOf(host).some((r) => r.textContent?.includes(`model-${id}`) ?? false);

afterEach(() => {
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// The projection, tested purely — no page, no store, no async.
// ---------------------------------------------------------------------------
describe('projectInflightRows', () => {
  const rows = [
    row('a', 'explicit'),
    row('b', 'structural'),
    row('c', 'semantic'),
    row('d', 'workload'), // add-workload-routing: a claimed request is an auto request
  ];
  const none = new Set<string>();

  it('passes everything through under the all filter', () => {
    expect(projectInflightRows(rows, none, filterToRequestParams('all')).map((r) => r.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('honours a filter the running rows CAN answer — decision layer is known at admission', () => {
    expect(
      projectInflightRows(rows, none, filterToRequestParams('explicit')).map((r) => r.id),
    ).toEqual(['a']);
    // `auto` covers structural/semantic/cascade — including semantic, which an earlier
    // bug in the paginated query dropped. Deriving from the shared mapping is what keeps
    // the band and the list agreeing about that.
    expect(projectInflightRows(rows, none, filterToRequestParams('auto')).map((r) => r.id)).toEqual(
      ['b', 'c', 'd'],
    );
  });

  it('empties the band for a filter needing a terminal outcome', () => {
    // A running request has no terminal status and carries no `escalated` flag, so these
    // cannot be evaluated — showing rows that might not match once they settle would be a
    // guess presented as a filter result.
    expect(projectInflightRows(rows, none, filterToRequestParams('fallback'))).toEqual([]);
    expect(projectInflightRows(rows, none, filterToRequestParams('escalated'))).toEqual([]);
  });

  it('drops a row whose durable counterpart is already visible', () => {
    expect(
      projectInflightRows(rows, new Set(['b']), filterToRequestParams('all')).map((r) => r.id),
    ).toEqual(['a', 'c', 'd']);
  });

  it('does not mutate its input — the shared set must survive one surface hiding a row', () => {
    const input = [...rows];
    projectInflightRows(input, new Set(['a', 'b', 'c', 'd']), filterToRequestParams('escalated'));
    expect(input.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

// ---------------------------------------------------------------------------
// The collision, rendered.
// ---------------------------------------------------------------------------
describe('the settling/durable collision', () => {
  it('renders a request ONCE when its durable row is in the frozen window', async () => {
    const h = await mountRequests();
    try {
      const durable = h.store.state.requestList[0];
      expect(durable, 'fixture has no completed rows to collide with').toBeDefined();
      const baseline = rowsOf(h.host).length;

      // The band holds a row whose durable counterpart is already in the list — exactly
      // the state produced by arriving here during the settling grace.
      h.store.setState('inflightRows', [row(durable!.id), row('still-running')]);
      await flush();

      // Only the genuinely-running row is added. Without the dedupe this is baseline + 2,
      // and the settled request is on screen twice.
      expect(rowsOf(h.host).length, 'the settled request was rendered twice').toBe(baseline + 1);
      expect(showsLive(h.host, 'still-running')).toBe(true);
      expect(showsLive(h.host, durable!.id), 'the deduped row still rendered').toBe(false);
    } finally {
      h.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// The band, on the page.
// ---------------------------------------------------------------------------
describe('the band on the Requests page', () => {
  it('renders running rows above the completed list', async () => {
    const h = await mountRequests();
    try {
      h.store.setState('inflightRows', [row('live-1')]);
      await flush();
      const rows = rowsOf(h.host);
      expect(showsLive(h.host, 'live-1')).toBe(true);
      expect(
        rows[0]?.textContent?.includes('model-live-1'),
        'the band must sit above the completed rows',
      ).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it('leaves the paginated list untouched while rows come and go', async () => {
    // The assertion that keeps this change from becoming the one it excludes.
    const h = await mountRequests();
    try {
      const window0 = { ...h.store.state.requestWindow };
      const cursor0 = h.store.state.requestCursor;
      const completed0 = h.store.state.requestList.map((r) => r.id);

      h.store.setState('inflightRows', [row('x'), row('y')]);
      await flush();
      h.store.setState('inflightRows', []);
      await flush();

      expect({ ...h.store.state.requestWindow }).toEqual(window0);
      expect(h.store.state.requestCursor).toBe(cursor0);
      expect(h.store.state.requestList.map((r) => r.id)).toEqual(completed0);
    } finally {
      h.dispose();
    }
  });

  it('"Load more" issues the same query it would have with no live traffic', async () => {
    const h = await mountRequests();
    try {
      h.store.setState('inflightRows', [row('noise')]);
      await flush();
      const before = h.fake.callLog.filter((c) => c.method === 'requests').length;

      h.host
        .querySelectorAll<HTMLButtonElement>('.rs-table-requests button.link-accent')
        .forEach((b) => {
          if (b.textContent?.includes('Load more')) b.click();
        });
      await flush();

      const calls = h.fake.callLog.filter((c) => c.method === 'requests');
      expect(calls.length, 'Load more did not fire').toBeGreaterThan(before);
      const q = calls.at(-1)?.args[0] as Record<string, unknown>;
      // Note there is NO `filter` property on the wire — it expands into
      // status/escalated/decisionLayers via the shared mapping.
      expect(q).toMatchObject({
        from: h.store.state.requestWindow?.from,
        to: h.store.state.requestWindow?.to,
        limit: 25,
        ...filterToRequestParams('all'),
      });
      expect(q['filter']).toBeUndefined();
    } finally {
      h.dispose();
    }
  });

  it('empties the band under a filter it cannot answer, without touching the list', async () => {
    const h = await mountRequests();
    try {
      h.store.setState('inflightRows', [row('live-1')]);
      await flush();
      expect(showsLive(h.host, 'live-1')).toBe(true);

      h.store.setState('reqFilter', 'escalated');
      await flush();
      expect(showsLive(h.host, 'live-1'), 'a running row survived a terminal filter').toBe(false);
      // And the shared set is untouched — the Overview card must still see it.
      expect(h.store.state.inflightRows.map((r) => r.id)).toEqual(['live-1']);
    } finally {
      h.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Fold-application ordering.
//
// `FakeApiClient.openGate()` releases every held resolver at once, so it cannot land
// snapshot B before snapshot A — these need per-call control. Test infrastructure only;
// no production seam is missing.
// ---------------------------------------------------------------------------
describe('a stale in-flight snapshot cannot overwrite newer state', () => {
  /** Minimal controllable EventSource stand-in, installed via `setStreamFactory`. */
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

  /** A fake whose `inflight()` calls are resolved individually, in any order. */
  class OrderedInflightClient extends FakeApiClient {
    readonly pending: ((v: {
      items: InflightRow[];
      available: boolean;
      truncated: boolean;
    }) => void)[] = [];
    override inflight(): Promise<{ items: InflightRow[]; available: boolean; truncated: boolean }> {
      return new Promise((resolve) => this.pending.push(resolve));
    }
  }

  it('loses to a newer load that already committed', async () => {
    const fake = new OrderedInflightClient({});
    const store = createAppStore(fake);

    const first = store.loadInflight(); // A
    const second = store.loadInflight(); // B — newer
    expect(fake.pending).toHaveLength(2);

    // B lands first and commits; A lands afterwards carrying an older view.
    fake.pending[1]?.({ items: [row('b-live')], available: true, truncated: false });
    await second;
    const refreshesBefore = fake.callLog.filter((c) => c.method === 'requests').length;
    fake.pending[0]?.({ items: [], available: true, truncated: false });
    await first;

    // `inflightRows` alone CANNOT distinguish the two outcomes: a falsely-settled row
    // moves into the 8s settling bridge and keeps rendering, and `InflightRow[]` erases
    // live-vs-settling. The observable difference is the side effect — observing a settle
    // triggers a durable refresh, so a stale snapshot that "settles" a running row fires
    // one that should never have happened.
    expect(store.state.inflightRows.map((r) => r.id)).toEqual(['b-live']);
    expect(
      fake.callLog.filter((c) => c.method === 'requests').length,
      'the stale snapshot falsely observed a settle and triggered a durable refresh',
    ).toBe(refreshesBefore);
  });

  it('loses to a STREAM event that landed while it was in flight', async () => {
    // The likelier collision on a healthy stream: the stream is the continuous driver and
    // the poll is only reconciliation, so a poll-vs-poll guard alone leaves this open.
    // Driven through the real stream seam rather than by poking the store, so the guard is
    // exercised on the path it actually protects.
    const fake = new OrderedInflightClient({});
    const store = createAppStore(fake);
    const sources: FakeStreamSource[] = [];
    store.setStreamFactory((url) => {
      const src = new FakeStreamSource(url);
      sources.push(src);
      return src;
    });
    store.connectStream();
    await flush();

    const pending = store.loadInflight();
    expect(fake.pending).toHaveLength(1);

    // A started event writes the fold while the snapshot is still out.
    // The wire payload is `{ row }`, not the row itself.
    sources.at(-1)?.emit('inflight.started', { row: row('from-stream') });
    await flush();
    expect(store.state.inflightRows.map((r) => r.id)).toEqual(['from-stream']);
    const refreshesBefore = fake.callLog.filter((c) => c.method === 'requests').length;

    // The stale snapshot now lands, showing nothing. Applying it would settle a request
    // that had only just started.
    fake.pending[0]?.({ items: [], available: true, truncated: false });
    await pending;
    await flush();

    // Same reasoning as above: assert the side effect, not the rendered set.
    expect(store.state.inflightRows.map((r) => r.id)).toEqual(['from-stream']);
    expect(
      fake.callLog.filter((c) => c.method === 'requests').length,
      'a stale snapshot settled a request the stream had just started',
    ).toBe(refreshesBefore);
    store.disconnectStream();
  });
});
