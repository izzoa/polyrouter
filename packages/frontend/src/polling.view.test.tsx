import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { InflightRow, InflightSnapshot, RequestsPage, RequestsQuery } from './data/api';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { ApiError } from './data/api';
import { DEFAULT_SESSION, FakeApiClient } from './test/fakeClient';

/**
 * phase1-tune-dashboard-polling: visibility gating, mount non-duplication, the
 * state-dependent live cadence, and identity scoping of the live view.
 */

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

/** happy-dom's `visibilityState` is read-only, so redefine it and fire the event. */
function setVisible(v: boolean): void {
  Object.defineProperty(document, 'visibilityState', {
    value: v ? 'visible' : 'hidden',
    configurable: true,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

function mount(store: AppStore, live = true): { host: HTMLElement; dispose: () => void } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const dispose = render(
    () => (
      <AppProvider store={store}>
        <App live={live} />
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

const AUTHORITATIVE_EMPTY: InflightSnapshot = { items: [], available: true, truncated: false };

/** Lets a test hold `inflight` / `requests` pending across an identity change. The
 * call is still RECORDED when made (so call counts stay meaningful). */
class DeferrableClient extends FakeApiClient {
  holdInflight = false;
  holdRequests = false;
  private inflightReleases: (() => void)[] = [];
  private requestsReleases: (() => void)[] = [];

  override inflight(): Promise<InflightSnapshot> {
    const base = super.inflight();
    if (!this.holdInflight) return base;
    return new Promise<InflightSnapshot>((resolve) => {
      this.inflightReleases.push(() => void base.then(resolve));
    });
  }

  override requests(query: RequestsQuery): Promise<RequestsPage> {
    const base = super.requests(query);
    if (!this.holdRequests) return base;
    return new Promise<RequestsPage>((resolve) => {
      this.requestsReleases.push(() => void base.then(resolve));
    });
  }

  releaseInflight(): void {
    const q = this.inflightReleases;
    this.inflightReleases = [];
    for (const r of q) r();
  }

  releaseRequests(): void {
    const q = this.requestsReleases;
    this.requestsReleases = [];
    for (const r of q) r();
  }
}

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset['theme'];
  setVisible(true);
  document.body.innerHTML = '';
});

describe('dashboard pollers are visibility-gated', () => {
  beforeEach(() => {
    setVisible(true);
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('mounts the Overview with exactly one fan-out and one in-flight fetch (no duplication)', async () => {
    const client = new FakeApiClient();
    const { dispose } = mount(createAppStore(client));
    try {
      await vi.advanceTimersByTimeAsync(0);
      await flush();
      // The range effect owns the mount load; the analytics poller must NOT add a
      // second fan-out (runImmediately: false), and the in-flight poller REPLACES the
      // old mount-time loadInflight() call rather than adding to it.
      expect(client.countOf('summary')).toBe(1);
      expect(client.countOf('timeseries')).toBe(1);
      expect(client.countOf('breakdown')).toBe(1);
      expect(client.countOf('inflight')).toBe(1);
    } finally {
      dispose();
    }
  });

  it('issues NO polls while hidden and exactly one catch-up per poller on return', async () => {
    const client = new FakeApiClient();
    const { dispose } = mount(createAppStore(client));
    try {
      await vi.advanceTimersByTimeAsync(0);
      await flush();
      const base = {
        summary: client.countOf('summary'),
        inflight: client.countOf('inflight'),
      };

      setVisible(false);
      await flush();
      await vi.advanceTimersByTimeAsync(60_000); // a full minute hidden
      await flush();
      expect(client.countOf('summary')).toBe(base.summary);
      expect(client.countOf('inflight')).toBe(base.inflight); // zero polls while hidden

      setVisible(true);
      await flush();
      // Exactly ONE immediate catch-up each — not one plus a stale elapsed interval.
      expect(client.countOf('summary')).toBe(base.summary + 1);
      expect(client.countOf('inflight')).toBe(base.inflight + 1);
    } finally {
      dispose();
    }
  });

  it('gates the Costs page too (discriminating: a bare setInterval would fail this)', async () => {
    const client = new FakeApiClient();
    const store = createAppStore(client);
    store.go('costs');
    const { dispose } = mount(store);
    try {
      await vi.advanceTimersByTimeAsync(0);
      await flush();
      const base = { summary: client.countOf('summary'), breakdown: client.countOf('breakdown') };
      expect(base.summary).toBe(1); // one mount fan-out, not two
      expect(base.breakdown).toBe(3); // model + provider + agent

      setVisible(false);
      await flush();
      await vi.advanceTimersByTimeAsync(60_000);
      await flush();
      expect(client.countOf('summary')).toBe(base.summary); // ZERO while hidden
      expect(client.countOf('breakdown')).toBe(base.breakdown);

      setVisible(true);
      await flush();
      expect(client.countOf('summary')).toBe(base.summary + 1); // exactly one catch-up
      expect(client.countOf('breakdown')).toBe(base.breakdown + 3);
    } finally {
      dispose();
    }
  });

  it('MEASURED: an idle visible Overview costs 28 requests/min (was 40), and 0 while hidden', async () => {
    const client = new FakeApiClient({ inflight: AUTHORITATIVE_EMPTY });
    const { dispose } = mount(createAppStore(client));
    try {
      await vi.advanceTimersByTimeAsync(0);
      await flush();
      const at0 = {
        inflight: client.countOf('inflight'),
        summary: client.countOf('summary'),
        timeseries: client.countOf('timeseries'),
        breakdown: client.countOf('breakdown'),
        requests: client.countOf('requests'),
      };

      await vi.advanceTimersByTimeAsync(60_000);
      await flush();
      const perMin = {
        inflight: client.countOf('inflight') - at0.inflight,
        analytics:
          client.countOf('summary') -
          at0.summary +
          (client.countOf('timeseries') - at0.timeseries) +
          (client.countOf('breakdown') - at0.breakdown) +
          (client.countOf('requests') - at0.requests),
      };
      // 12 in-flight polls (5 s idle cadence, was 24 at 2.5 s) + 4 analytics fan-outs
      // × 4 endpoints = 16. Total 28 HTTP requests/min, down from 40.
      expect(perMin.inflight).toBe(12);
      expect(perMin.analytics).toBe(16);
      expect(perMin.inflight + perMin.analytics).toBe(28);

      // Hidden: exactly zero, for a full minute.
      setVisible(false);
      await flush();
      const beforeHidden = client.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      await flush();
      expect(client.calls.length - beforeHidden).toBe(0);
    } finally {
      dispose();
    }
  });

  it('stops both Overview pollers when navigating away (page scope is independent of visibility)', async () => {
    const client = new FakeApiClient();
    const store = createAppStore(client);
    const { dispose } = mount(store);
    try {
      await vi.advanceTimersByTimeAsync(0);
      await flush();
      const base = client.countOf('inflight');

      store.go('costs'); // unmounts the Overview
      await flush();
      await vi.advanceTimersByTimeAsync(60_000);
      await flush();
      // The in-flight poll is Overview-only: it must be gone even though the document
      // stayed visible the whole time.
      expect(client.countOf('inflight')).toBe(base);
    } finally {
      dispose();
    }
  });
});

describe('the live in-flight cadence', () => {
  beforeEach(() => {
    setVisible(true);
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('relaxes to 5s while empty, snaps to 2.5s on a row, and keeps the handoff fast', async () => {
    const client = new FakeApiClient({ inflight: AUTHORITATIVE_EMPTY });
    const store = createAppStore(client);
    const { dispose } = mount(store);
    try {
      await vi.advanceTimersByTimeAsync(0);
      await flush();
      const afterMount = client.countOf('inflight');

      // Idle → the 5 s cadence.
      await vi.advanceTimersByTimeAsync(4_900);
      await flush();
      expect(client.countOf('inflight')).toBe(afterMount);
      await vi.advanceTimersByTimeAsync(100);
      await flush();
      expect(client.countOf('inflight')).toBe(afterMount + 1);

      // A live row appears → the next arm is the FAST cadence.
      client.inflightResult = { items: [liveRow()], available: true, truncated: false };
      await vi.advanceTimersByTimeAsync(5_000);
      await flush();
      expect(store.state.inflightRows.length).toBe(1);
      const withRow = client.countOf('inflight');
      await vi.advanceTimersByTimeAsync(2_400);
      await flush();
      expect(client.countOf('inflight')).toBe(withRow);
      await vi.advanceTimersByTimeAsync(100);
      await flush();
      expect(client.countOf('inflight')).toBe(withRow + 1); // 2.5 s, not 5 s

      // Now settle it: an authoritative snapshot omitting the cached id must trigger
      // the durable refresh — and it must do so at the FAST cadence, not the idle one.
      const beforeSettle = client.countOf('requests');
      client.inflightResult = AUTHORITATIVE_EMPTY;
      await vi.advanceTimersByTimeAsync(2_500);
      await flush();
      expect(client.countOf('requests')).toBeGreaterThan(beforeSettle);
    } finally {
      dispose();
    }
  });

  it('keeps the RequestTable latency ticking while the document is hidden', async () => {
    // `live={false}` isolates the clock from the pollers.
    const client = new FakeApiClient({ inflight: { items: [liveRow()], available: true, truncated: false } });
    const store = createAppStore(client);
    const { host, dispose } = mount(store, false);
    try {
      await vi.advanceTimersByTimeAsync(0);
      await flush();
      await store.loadInflight();
      await flush();
      const latency = (): string | undefined =>
        [...host.querySelectorAll('.req-row span')]
          .map((n) => n.textContent ?? '')
          .find((t) => /^\d+\.\d+s$/.test(t));
      const before = latency();
      expect(before).toBeDefined();

      // Assert the change WHILE STILL HIDDEN. Asserting after a re-show would be
      // vacuous: elapsed derives from Date.now(), so a wrongly-gated clock would
      // catch up on return and pass anyway.
      setVisible(false);
      await flush();
      await vi.advanceTimersByTimeAsync(3_000);
      await flush();
      expect(latency()).not.toBe(before);
    } finally {
      dispose();
    }
  });
});

describe('live-row state is identity-scoped', () => {
  it('discards an in-flight response captured under the previous account', async () => {
    const client = new DeferrableClient({ inflight: { items: [liveRow()], available: true, truncated: false } });
    const store = createAppStore(client);
    await store.bootstrap(); // signed in as A
    await flush();

    client.holdInflight = true;
    const pending = store.loadInflight(); // captured under A
    await flush();

    client.session = { ...DEFAULT_SESSION, userId: 'user-B', email: 'b@example.test' };
    await store.bootstrap(); // A → B
    await flush();

    client.releaseInflight();
    await pending;
    await flush();
    expect(store.state.inflightRows).toEqual([]); // A's snapshot never folded
  });

  it('clears displayed live rows immediately on an account change', async () => {
    const client = new FakeApiClient({ inflight: { items: [liveRow()], available: true, truncated: false } });
    const store = createAppStore(client);
    await store.bootstrap();
    await store.loadInflight();
    await flush();
    expect(store.state.inflightRows.length).toBe(1);

    client.session = { ...DEFAULT_SESSION, userId: 'user-B', email: 'b@example.test' };
    await store.bootstrap();
    await flush();
    expect(store.state.inflightRows).toEqual([]); // not carried into B's view
  });

  it('clears at a mid-session 401 re-gate, so a later sign-in cannot inherit rows', async () => {
    const client = new DeferrableClient({ inflight: { items: [liveRow()], available: true, truncated: false } });
    const store = createAppStore(client);
    await store.bootstrap();
    await store.loadInflight();
    await flush();
    expect(store.state.inflightRows.length).toBe(1);

    // A pending A-identity request plus cached rows, then the session expires.
    client.holdInflight = true;
    const pending = store.loadInflight();
    await flush();

    client.meFailure = new ApiError(401, 'Unauthorized', 'Unauthorized');
    await store.bootstrap(); // re-gate to login
    await flush();
    expect(store.state.inflightRows).toEqual([]); // cleared EAGERLY at the re-gate

    // Now sign in as B. Because the re-gate already bumped the generation, A's
    // in-flight response cannot commit — even though the A→B change is undetectable
    // here (the re-gate nulled the session, so there is no A id left to compare).
    client.meFailure = null;
    client.session = { ...DEFAULT_SESSION, userId: 'user-B', email: 'b@example.test' };
    await store.bootstrap();
    client.releaseInflight();
    await pending;
    await flush();
    expect(store.state.inflightRows).toEqual([]);
  });

  it('discards a settle-triggered durable refresh started under the previous account', async () => {
    // STORE-LEVEL with no page mounted: a mounted B would remount the Overview, whose
    // range effect starts a NEWER loadRecentRequests that would discard A's response
    // on its own — letting this pass even with the identity guard missing.
    const client = new DeferrableClient({ inflight: { items: [liveRow()], available: true, truncated: false } });
    const store = createAppStore(client);
    await store.bootstrap();
    await flush();

    await store.loadInflight(); // observes the live row
    await flush();
    expect(store.state.inflightRows.length).toBe(1);

    // An authoritative snapshot omitting it = settle observed → durable refresh.
    client.holdRequests = true;
    client.inflightResult = AUTHORITATIVE_EMPTY;
    await store.loadInflight();
    await flush();
    expect(client.countOf('requests')).toBe(1); // exactly one, and it is A's

    client.session = { ...DEFAULT_SESSION, userId: 'user-B', email: 'b@example.test' };
    await store.bootstrap(); // A → B; must invalidate the `recent` slice
    await flush();
    expect(client.countOf('requests')).toBe(1); // still no newer load to mask the guard

    client.releaseRequests();
    await flush();
    expect(store.state.recentRequests).toEqual([]); // A's rows never committed under B
  });
});
