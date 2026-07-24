import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { InflightRow } from './data/api';
import type { EventSourceFactory, EventSourceLike } from './data/eventStream';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { DEFAULT_SESSION, FakeApiClient } from './test/fakeClient';

/**
 * phase2-add-dashboard-event-stream, end to end in the store + view: the stream
 * supersedes the poll, degradation resumes it, nudges cannot amplify, a dropped
 * publish self-corrects, and nothing crosses an identity boundary.
 */

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

function setVisible(v: boolean): void {
  Object.defineProperty(document, 'visibilityState', {
    value: v ? 'visible' : 'hidden',
    configurable: true,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

/** A controllable stand-in for the browser's EventSource. */
class FakeSource implements EventSourceLike {
  static last: FakeSource | null = null;
  static created = 0;
  onerror: ((this: unknown, ev: Event) => unknown) | null = null;
  closed = false;
  private listeners = new Map<string, ((ev: MessageEvent<string>) => void)[]>();
  constructor() {
    FakeSource.last = this;
    FakeSource.created += 1;
  }
  addEventListener(type: string, fn: (ev: MessageEvent<string>) => void): void {
    const l = this.listeners.get(type) ?? [];
    l.push(fn);
    this.listeners.set(type, l);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ data: JSON.stringify(data) } as MessageEvent<string>);
    }
  }
  fail(): void {
    this.onerror?.call(this, new Event('error'));
  }
}

const factory: EventSourceFactory = () => new FakeSource();

const row = (id: string): InflightRow => ({
  id,
  startedAt: Date.now() - 1_000,
  decisionLayer: 'cascade',
  tierAssigned: null,
  modelLabel: 'm',
  providerLabel: 'p',
  protocol: 'openai',
  status: 'running',
});

/** `heartbeatIntervalMs` is deliberately long in most tests: the client's health
 * watchdog degrades a stream that stops sending frames (that IS the content-verified
 * health working), so a long fake-timer advance without emitted heartbeats would
 * otherwise look like a legitimate stall. */
const SNAPSHOT = (
  items: InflightRow[] = [],
  over: { heartbeatIntervalMs?: number; reconciliationIntervalMs?: number } = {},
) => ({
  items,
  available: true,
  truncated: false,
  heartbeatIntervalMs: over.heartbeatIntervalMs ?? 600_000,
  reconciliationIntervalMs: over.reconciliationIntervalMs ?? 30_000,
});

function mount(store: AppStore): { host: HTMLElement; dispose: () => void } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const dispose = render(
    () => (
      <AppProvider store={store}>
        <App live={true} />
      </AppProvider>
    ),
    host,
  );
  return { host, dispose: () => (dispose(), host.remove()) };
}

describe('the event stream drives the live view', () => {
  beforeEach(() => {
    FakeSource.last = null;
    FakeSource.created = 0;
    setVisible(true);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers(); // release stream watchdog/reconcile timers before switching clocks
    vi.useRealTimers();
    localStorage.clear();
    document.body.innerHTML = '';
  });

  const boot = async (client = new FakeApiClient()): Promise<{ store: AppStore; dispose: () => void }> => {
    const store = createAppStore(client);
    store.setStreamFactory(factory);
    const { dispose } = mount(store);
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    return { store, dispose };
  };

  it('suspends the fast in-flight poll while the stream is healthy, and resumes it on degradation', async () => {
    const client = new FakeApiClient();
    const { store, dispose } = await boot(client);
    try {
      FakeSource.last?.emit('snapshot', SNAPSHOT());
      await flush();
      expect(store.state.streamHealth).toBe('live');

      const polled = client.countOf('inflight');
      await vi.advanceTimersByTimeAsync(20_000);
      await flush();
      // The stream is the single continuous DRIVER; the fast poll must be suspended.
      // (Only the bounded ~30s reconciliation verifier may read, and not yet here.)
      expect(client.countOf('inflight')).toBe(polled);

      FakeSource.last?.fail(); // stream drops
      await flush();
      // It must stop being the driver (it may already be attempting a reconnect).
      expect(store.state.streamHealth).not.toBe('live');
      await vi.advanceTimersByTimeAsync(5_000);
      await flush();
      expect(client.countOf('inflight')).toBeGreaterThan(polled); // poll resumed
      // A failure probes /api/me — but with the LIGHT probe, not a shell remount.
      expect(client.countOf('me')).toBeGreaterThanOrEqual(2);
    } finally {
      dispose();
    }
  });

  it('renders a started row immediately and hands off on an explicit settled event', async () => {
    const client = new FakeApiClient();
    const { store, dispose } = await boot(client);
    try {
      FakeSource.last?.emit('snapshot', SNAPSHOT());
      await flush();
      FakeSource.last?.emit('inflight.started', { row: row('live-1') });
      await flush();
      expect(store.state.inflightRows.map((r) => r.id)).toEqual(['live-1']);

      const before = client.countOf('requests');
      FakeSource.last?.emit('inflight.settled', { id: 'live-1' });
      await flush();
      // Positive evidence: the durable refresh fires at once, with no poll interval.
      expect(client.countOf('requests')).toBe(before + 1);
      // And the row is bridged, not blinked away.
      expect(store.state.inflightRows.map((r) => r.id)).toEqual(['live-1']);
    } finally {
      dispose();
    }
  });

  it('SELF-CORRECTS a dropped publish via the bounded reconciliation read', async () => {
    // The stream stays connected and heart-beating, but a `started` never arrives —
    // liveness alone would leave the view silently wrong forever.
    const client = new FakeApiClient(); // nothing in flight yet
    const { store, dispose } = await boot(client);
    try {
      FakeSource.last?.emit('snapshot', SNAPSHOT([], { reconciliationIntervalMs: 5_000 }));
      await flush();
      expect(store.state.inflightRows).toEqual([]);

      // A request starts, but its `inflight.started` publish is LOST. The stream stays
      // connected and healthy, so liveness alone would leave the view wrong forever.
      client.inflightResult = { items: [row('ghost')], available: true, truncated: false };
      await flush();
      expect(store.state.inflightRows).toEqual([]); // still nothing — the event never came

      // Within one reconciliation interval the authoritative read repairs it.
      await vi.advanceTimersByTimeAsync(6_000);
      await flush();
      expect(store.state.inflightRows.map((r) => r.id)).toEqual(['ghost']);
    } finally {
      dispose();
    }
  });

  it('re-snapshots on a resync directive', async () => {
    const client = new FakeApiClient({ inflight: { items: [row('after-resync')], available: true, truncated: false } });
    const { store, dispose } = await boot(client);
    try {
      FakeSource.last?.emit('snapshot', SNAPSHOT());
      await flush();
      FakeSource.last?.emit('resync', {});
      await flush();
      expect(store.state.inflightRows.map((r) => r.id)).toEqual(['after-resync']);
    } finally {
      dispose();
    }
  });

  it('a BURST of nudges cannot amplify: at most one aggregate refetch per floor window', async () => {
    const client = new FakeApiClient();
    const { dispose } = await boot(client);
    try {
      FakeSource.last?.emit('snapshot', SNAPSHOT());
      await flush();
      // Let the mount fan-out settle, then measure only what the nudges cause.
      await vi.advanceTimersByTimeAsync(16_000);
      await flush();
      const before = client.countOf('summary');

      for (let i = 0; i < 500; i += 1) FakeSource.last?.emit('analytics.invalidated', {});
      await flush();
      // 500 nudges → at most ONE refetch (the floor is shared with the poll, so this
      // also consumes the poll's slot rather than adding to it).
      expect(client.countOf('summary') - before).toBeLessThanOrEqual(1);

      // Still bounded across a longer window with continuous nudging.
      for (let w = 0; w < 3; w += 1) {
        await vi.advanceTimersByTimeAsync(15_000);
        for (let i = 0; i < 100; i += 1) FakeSource.last?.emit('analytics.invalidated', {});
        await flush();
      }
      // 3 windows of 15s → no more than ~1 refetch each (poll + nudge COMBINED).
      expect(client.countOf('summary') - before).toBeLessThanOrEqual(4);
    } finally {
      dispose();
    }
  });

  it('never fetches on a nudge that races a hide, and the return catch-up still fires', async () => {
    const client = new FakeApiClient();
    const { dispose } = await boot(client);
    try {
      FakeSource.last?.emit('snapshot', SNAPSHOT());
      await flush();
      await vi.advanceTimersByTimeAsync(16_000);
      await flush();

      setVisible(false);
      await flush();
      const hidden = client.countOf('summary');
      FakeSource.last?.emit('analytics.invalidated', {}); // races the hide
      await flush();
      expect(client.countOf('summary')).toBe(hidden); // no fetch while hidden

      setVisible(true);
      await flush();
      // Phase 1's single mandatory catch-up still happens (the nudge did not suppress it).
      expect(client.countOf('summary')).toBe(hidden + 1);
    } finally {
      dispose();
    }
  });

  it('closes the stream when hidden (releasing a SHARED connection slot) and reconnects on return', async () => {
    const client = new FakeApiClient();
    const { store, dispose } = await boot(client);
    try {
      FakeSource.last?.emit('snapshot', SNAPSHOT());
      await flush();
      const first = FakeSource.last;
      expect(store.state.streamHealth).toBe('live');

      setVisible(false);
      await flush();
      expect(first?.closed).toBe(true); // released, not merely paused
      expect(store.state.streamHealth).toBe('polling');

      const created = FakeSource.created;
      setVisible(true);
      await flush();
      expect(FakeSource.created).toBe(created + 1); // a fresh connection + re-snapshot
    } finally {
      dispose();
    }
  });

  it('a hidden/disconnected interval never settles a cached live row', async () => {
    const client = new FakeApiClient();
    const { store, dispose } = await boot(client);
    try {
      FakeSource.last?.emit('snapshot', SNAPSHOT());
      FakeSource.last?.emit('inflight.started', { row: row('keep-me') });
      await flush();
      expect(store.state.inflightRows.map((r) => r.id)).toEqual(['keep-me']);

      setVisible(false);
      await flush();
      await vi.advanceTimersByTimeAsync(30_000);
      await flush();
      // Absence of events while disconnected is NOT evidence the request ended.
      expect(store.state.inflightRows.map((r) => r.id)).toEqual(['keep-me']);
    } finally {
      dispose();
    }
  });

  it('keeps working with no stream at all (degradation is the reliable core)', async () => {
    const client = new FakeApiClient();
    const store = createAppStore(client);
    // Transport unavailable — e.g. EVENTS_ENABLED=false, a refusal, or no EventSource.
    store.setStreamFactory(() => {
      throw new Error('unavailable');
    });
    const { dispose } = mount(store);
    try {
      await vi.advanceTimersByTimeAsync(0);
      await flush();
      expect(store.state.streamHealth).toBe('polling');
      const polled = client.countOf('inflight');
      await vi.advanceTimersByTimeAsync(6_000);
      await flush();
      // The fast poll carries the live view exactly as before the stream existed.
      expect(client.countOf('inflight')).toBeGreaterThan(polled);
    } finally {
      dispose();
    }
  });

  it('discards stream-TRIGGERED work started under a previous account', async () => {
    const client = new FakeApiClient();
    const store = createAppStore(client);
    store.setStreamFactory(factory);
    await store.bootstrap();
    store.connectStream();
    await flush();
    FakeSource.last?.emit('snapshot', SNAPSHOT());
    FakeSource.last?.emit('inflight.started', { row: row('a-row') });
    await flush();
    expect(store.state.inflightRows.map((r) => r.id)).toEqual(['a-row']);

    // Switch accounts: the old stream's frames must no longer be folded.
    client.session = { ...DEFAULT_SESSION, userId: 'user-B', email: 'b@x.test' };
    await store.bootstrap();
    await flush();
    expect(store.state.inflightRows).toEqual([]); // cleared at the boundary

    FakeSource.last?.emit('inflight.started', { row: row('late-a-row') });
    FakeSource.last?.emit('analytics.invalidated', {});
    await flush();
    expect(store.state.inflightRows).toEqual([]); // a previous identity's frames: discarded
    store.disconnectStream(); // no mounted root here — release the timers explicitly
  });
});
