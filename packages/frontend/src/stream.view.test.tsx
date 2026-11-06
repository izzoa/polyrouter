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

  const boot = async (
    client = new FakeApiClient(),
  ): Promise<{ store: AppStore; dispose: () => void }> => {
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

  it('an escalation relabel updates the running row in place (add-stream-keepalive)', async () => {
    const { store, dispose } = await boot();
    try {
      FakeSource.last?.emit('snapshot', SNAPSHOT());
      await flush();
      FakeSource.last?.emit('inflight.started', {
        row: { ...row('esc-1'), tierAssigned: 'utility', modelLabel: 'minimax/minimax-m3' },
      });
      await flush();
      expect(store.state.inflightRows.map((r) => r.modelLabel)).toEqual(['minimax/minimax-m3']);
      FakeSource.last?.emit('inflight.updated', {
        row: {
          ...row('esc-1'),
          tierAssigned: 'heavy',
          modelLabel: 'mimo-v2.6-pro',
          providerLabel: 'XiaomiMiMo',
        },
      });
      await flush();
      // Same row, now naming the strong model — no second row, no blink.
      expect(store.state.inflightRows).toHaveLength(1);
      expect(store.state.inflightRows[0]).toMatchObject({
        id: 'esc-1',
        tierAssigned: 'heavy',
        modelLabel: 'mimo-v2.6-pro',
        providerLabel: 'XiaomiMiMo',
      });
      // A relabel for a request that already settled never brings it back.
      FakeSource.last?.emit('inflight.settled', { id: 'esc-1' });
      await flush();
      FakeSource.last?.emit('inflight.updated', { row: row('esc-1') });
      FakeSource.last?.emit('inflight.updated', { row: row('never-started') });
      await flush();
      expect(store.state.inflightRows.map((r) => r.id)).toEqual(['esc-1']); // the bridge only
      expect(store.state.inflightRows[0]!.modelLabel).toBe('mimo-v2.6-pro');
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
    const client = new FakeApiClient({
      inflight: { items: [row('after-resync')], available: true, truncated: false },
    });
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

/* ── The Live lamp (dashboard-event-stream "The Live lamp blinks only when stream data
 * arrives"; adopt-design-tokens-v2 tasks 13.2 / 13.3, design.md D12) ───────────────────────────
 * Driven end to end: frames go into the REAL store through `FakeSource`, and the lamp is read
 * off the mounted `Topbar`. A blink is the `lamp-blink` class being APPLIED; it is counted from
 * the dot's class mutations (with their old values), so a blink that comes and goes between
 * two reads is still counted, and a class that merely stays on is not counted twice. */
describe('the Live lamp blinks only when stream data arrives', () => {
  beforeEach(() => {
    FakeSource.last = null;
    FakeSource.created = 0;
    setVisible(true);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    localStorage.clear();
    document.body.innerHTML = '';
  });

  const boot = async (
    client = new FakeApiClient(),
  ): Promise<{ store: AppStore; client: FakeApiClient; dispose: () => void }> => {
    const store = createAppStore(client);
    store.setStreamFactory(factory);
    const { dispose } = mount(store);
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    return { store, client, dispose };
  };

  const dot = (): HTMLElement => {
    const el = document.querySelector<HTMLElement>('[data-testid="live-dot"]');
    if (!el) throw new Error('no live dot');
    return el;
  };
  const blinkingNow = (): boolean => dot().classList.contains('lamp-blink');

  /** Counts blink STARTS on the current dot: every mutation that turns the class on. Each
   * record's `oldValue` is the class BEFORE it, so the class after record i is record i+1's
   * `oldValue` — or, for the last, the live value. Records are collected both from the
   * observer's callback (which consumes them) and from `takeRecords()` (which has the rest). */
  function blinkCounter(): { count: () => number; stop: () => void } {
    const el = dot();
    const has = (cls: string | null): boolean => (cls ?? '').split(/\s+/).includes('lamp-blink');
    const pending: MutationRecord[] = [];
    const mo = new MutationObserver((records) => {
      pending.push(...records);
    });
    mo.observe(el, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    let on = has(el.getAttribute('class'));
    let starts = 0;
    return {
      count: () => {
        pending.push(...mo.takeRecords());
        const records = pending.splice(0);
        const after = [...records.slice(1).map((r) => r.oldValue), el.getAttribute('class')];
        for (let i = 0; i < records.length; i += 1) {
          const now = has(after[i] ?? null);
          if (now && !on) starts += 1;
          on = now;
        }
        return starts;
      },
      stop: () => mo.disconnect(),
    };
  }

  /** Advance the fake clock, letting the store and Solid settle. */
  const advance = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
    await flush();
  };

  it('one inflight.started frame stamps the store and blinks the lamp exactly once (13.2)', async () => {
    const { store, dispose } = await boot();
    try {
      expect(store.state.lastDataEventAt).toBeNull();
      const blinks = blinkCounter();
      const before = Date.now();
      FakeSource.last?.emit('inflight.started', { row: row('a') });
      await flush();
      expect(store.state.streamHealth).toBe('live');
      expect(store.state.lastDataEventAt).toBe(before);
      expect(blinkingNow(), 'the class is on for the blink').toBe(true);
      expect(blinks.count()).toBe(1);
      await advance(600);
      expect(blinkingNow(), 'and off once the 600ms blink is over').toBe(false);
      expect(blinks.count(), 'one frame, one blink').toBe(1);
      blinks.stop();
    } finally {
      dispose();
    }
  });

  it('a heartbeat moves neither the stamp nor the lamp (13.2)', async () => {
    const { store, dispose } = await boot();
    try {
      const blinks = blinkCounter();
      FakeSource.last?.emit('heartbeat', {});
      await flush();
      expect(store.state.streamHealth, 'the heartbeat proved liveness').toBe('live');
      expect(store.state.lastDataEventAt).toBeNull();
      expect(blinks.count()).toBe(0);

      FakeSource.last?.emit('inflight.started', { row: row('a') });
      await flush();
      const stamp = store.state.lastDataEventAt;
      await advance(2_000);
      FakeSource.last?.emit('heartbeat', {});
      await flush();
      expect(store.state.lastDataEventAt, 'a later heartbeat leaves the stamp').toBe(stamp);
      expect(blinks.count(), 'and blinks nothing').toBe(1);
      blinks.stop();
    } finally {
      dispose();
    }
  });

  it('hiding the tab clears the stamp (13.2)', async () => {
    const { store, dispose } = await boot();
    try {
      FakeSource.last?.emit('inflight.started', { row: row('a') });
      await flush();
      expect(store.state.lastDataEventAt).not.toBeNull();
      setVisible(false);
      await flush();
      expect(store.state.streamHealth).toBe('polling');
      expect(store.state.lastDataEventAt, 'no stale stamp for the next stream').toBeNull();
    } finally {
      dispose();
    }
  });

  it("an account switch clears the stamp, and the previous identity's frame cannot set it (13.2)", async () => {
    const client = new FakeApiClient();
    const { store, dispose } = await boot(client);
    try {
      FakeSource.last?.emit('inflight.started', { row: row('a-row') });
      await flush();
      expect(store.state.lastDataEventAt).not.toBeNull();
      const previous = FakeSource.last;

      // As the "previous account" test above does: the next bootstrap is another principal.
      client.session = { ...DEFAULT_SESSION, userId: 'user-B', email: 'b@x.test' };
      await store.bootstrap();
      await flush();
      expect(store.state.lastDataEventAt, 'cleared at the identity boundary').toBeNull();

      previous?.emit('inflight.started', { row: row('late-a-row') });
      previous?.emit('analytics.invalidated', {});
      await flush();
      expect(store.state.lastDataEventAt, "a previous identity's frame is discarded").toBeNull();
    } finally {
      dispose();
    }
  });

  it('the identity reset itself clears the stamp, with no shell remount to do it (13.2)', async () => {
    // Store-only, as the "previous account" test above is built: no App, so no unmount
    // disconnects the stream. The stream stays open across the switch, and only
    // `resetIdentityScoped` can clear the stamp; only the identity guard can keep the
    // previous identity's frames from setting it again.
    const client = new FakeApiClient();
    const store = createAppStore(client);
    store.setStreamFactory(factory);
    await store.bootstrap();
    store.connectStream();
    await flush();
    FakeSource.last?.emit('inflight.started', { row: row('a-row') });
    await flush();
    expect(store.state.lastDataEventAt).not.toBeNull();
    const previous = FakeSource.last;

    client.session = { ...DEFAULT_SESSION, userId: 'user-B', email: 'b@x.test' };
    await store.bootstrap();
    await flush();
    expect(previous?.closed, 'precondition: the stream was not closed').toBe(false);
    expect(store.state.lastDataEventAt, 'cleared by the identity reset').toBeNull();
    previous?.emit('inflight.started', { row: row('late-a-row') });
    await flush();
    expect(store.state.lastDataEventAt).toBeNull();
    store.disconnectStream(); // no mounted root here — release the timers explicitly
  });

  it('blinks once per data event, and at most once a second through a 20-event burst (13.3)', async () => {
    const { dispose } = await boot();
    try {
      const blinks = blinkCounter();
      FakeSource.last?.emit('snapshot', SNAPSHOT());
      await flush();
      expect(blinks.count(), 'the snapshot is data: one blink').toBe(1);

      await advance(1_000);
      // Twenty events inside one second: one blink, not twenty, and not a queue of them.
      for (let i = 0; i < 20; i += 1) {
        FakeSource.last?.emit('inflight.started', { row: row(`burst-${String(i)}`) });
        await advance(45);
      }
      expect(blinks.count(), 'a 20-event burst blinks once').toBe(2);
      await advance(2_000);
      expect(blinks.count(), 'and no trailing blink is owed for the dropped events').toBe(2);

      FakeSource.last?.emit('analytics.invalidated', {});
      await flush();
      expect(blinks.count(), 'the next event after a quiet second blinks again').toBe(3);
      blinks.stop();
    } finally {
      dispose();
    }
  });

  it('events 700ms apart blink every other one: the throttle is a second, not one blink long (13.3)', async () => {
    const { dispose } = await boot();
    try {
      const blinks = blinkCounter();
      for (let i = 0; i < 5; i += 1) {
        FakeSource.last?.emit('inflight.started', { row: row(`slow-${String(i)}`) });
        await advance(700);
      }
      // At 0, 1400 and 2800ms; the events at 700 and 2100ms fall inside a second.
      expect(blinks.count()).toBe(3);
      blinks.stop();
    } finally {
      dispose();
    }
  });

  it('never blinks for heartbeats, however long they run (13.3)', async () => {
    const { store, dispose } = await boot();
    try {
      FakeSource.last?.emit('snapshot', SNAPSHOT());
      await advance(1_500);
      const blinks = blinkCounter();
      for (let i = 0; i < 20; i += 1) {
        FakeSource.last?.emit('heartbeat', {});
        await advance(1_000);
      }
      expect(store.state.streamHealth).toBe('live');
      expect(blinks.count()).toBe(0);
      expect(blinkingNow()).toBe(false);
      blinks.stop();
    } finally {
      dispose();
    }
  });

  it('is a steady Faint dot while polling, which never blinks as polls land (13.3)', async () => {
    const client = new FakeApiClient();
    const { store, dispose } = await boot(client);
    try {
      FakeSource.last?.fail(); // the stream drops: the fast poll carries the live view
      await flush();
      expect(store.state.streamHealth).toBe('polling');
      const blinks = blinkCounter();
      const polled = client.countOf('inflight');
      client.inflightResult = { items: [row('polled')], available: true, truncated: false };
      await advance(10_000);
      expect(client.countOf('inflight'), 'polls ran').toBeGreaterThan(polled);
      expect(store.state.inflightRows.map((r) => r.id)).toContain('polled');
      expect(blinks.count(), 'a poll is not a stream event').toBe(0);
      expect(dot().style.background).toBe('var(--faint)');
      expect(document.querySelector('[data-testid="live-pill"]')?.textContent).toContain('Polling');
      blinks.stop();
    } finally {
      dispose();
    }
  });

  it('is green while live, decorative, and not a live region (13.3)', async () => {
    const { dispose } = await boot();
    try {
      FakeSource.last?.emit('snapshot', SNAPSHOT());
      await flush();
      expect(dot().style.background).toBe('var(--green)');
      expect(dot().getAttribute('aria-hidden')).toBe('true');
      const pill = document.querySelector<HTMLElement>('[data-testid="live-pill"]');
      expect(pill?.textContent).toContain('Live');
      expect(
        pill?.closest('[aria-live], [role="status"], [role="alert"], [role="log"]'),
        'a blink must announce nothing',
      ).toBeNull();
      expect(pill?.querySelector('[aria-live]')).toBeNull();
    } finally {
      dispose();
    }
  });
});
