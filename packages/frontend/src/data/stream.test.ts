import { createRoot } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InflightRow, InflightSnapshot } from './api';
import {
  applySettled,
  applyStarted,
  applyUpdated,
  applyStreamSnapshot,
  emptyStream,
  inflightDisplay,
} from './inflight';
import {
  createEventStream,
  staleAfterMs,
  type EventSourceLike,
  type StreamHealth,
} from './eventStream';

/** phase2-add-dashboard-event-stream: the pure delta appliers and the client. */

const row = (id: string, over: Partial<InflightRow> = {}): InflightRow => ({
  id,
  startedAt: 1_000,
  decisionLayer: 'cascade',
  tierAssigned: null,
  modelLabel: 'm',
  providerLabel: 'p',
  protocol: 'openai',
  status: 'running',
  ...over,
});
const NONE: ReadonlySet<string> = new Set();
const snap = (items: InflightRow[], over: Partial<InflightSnapshot> = {}): InflightSnapshot => ({
  items,
  available: true,
  truncated: false,
  ...over,
});

describe('stream delta appliers', () => {
  it('adds a started row, and ignores duplicates', () => {
    let s = applyStarted(emptyStream(), row('a'), NONE, 1);
    expect(inflightDisplay(s, NONE).map((r) => r.id)).toEqual(['a']);
    s = applyStarted(s, row('a'), NONE, 2); // duplicate
    expect(s.live).toHaveLength(1);
  });

  it('ignores a started row whose durable row already exists', () => {
    const s = applyStarted(emptyStream(), row('a'), new Set(['a']), 1);
    expect(s.live).toEqual([]);
  });

  it('treats an explicit settle as positive evidence and bridges the row', () => {
    const started = applyStarted(emptyStream(), row('a'), NONE, 1);
    const { next, refresh } = applySettled(started, 'a', 2);
    expect(refresh).toBe(true); // triggers the durable refresh immediately
    expect(next.live).toEqual([]);
    expect(next.settling.map((x) => x.row.id)).toEqual(['a']);
    // Still displayed while bridging — never blinked to empty.
    expect(inflightDisplay(next, NONE).map((r) => r.id)).toEqual(['a']);
  });

  it('is idempotent for a duplicate or late settle', () => {
    const started = applyStarted(emptyStream(), row('a'), NONE, 1);
    const first = applySettled(started, 'a', 2);
    const second = applySettled(first.next, 'a', 3);
    expect(second.refresh).toBe(false); // nothing left to bridge
    expect(second.next.settling).toHaveLength(1); // not re-added
  });

  it('makes a LATE started for an already-settled id a no-op (no ghost row)', () => {
    const started = applyStarted(emptyStream(), row('a'), NONE, 1);
    const settled = applySettled(started, 'a', 2).next;
    const late = applyStarted(settled, row('a'), NONE, 3); // reordered delivery
    expect(late.live).toEqual([]); // the terminal marker blocks resurrection
  });

  it('preserves the settling bridge across a resync re-snapshot', () => {
    const started = applyStarted(emptyStream(), row('a'), NONE, 1);
    const settled = applySettled(started, 'a', 2).next;
    // A resync arrives mid-handoff: an authoritative snapshot without `a`.
    const { next } = applyStreamSnapshot(settled, snap([]), NONE, 3);
    expect(next.settling.map((x) => x.row.id)).toEqual(['a']); // bridge retained
    expect(inflightDisplay(next, NONE).map((r) => r.id)).toEqual(['a']); // not blinked
  });

  it('never settles from a degraded or truncated snapshot', () => {
    const started = applyStarted(emptyStream(), row('a'), NONE, 1);
    const degraded = applyStreamSnapshot(started, snap([], { available: false }), NONE, 2);
    expect(degraded.refresh).toBe(false);
    expect(inflightDisplay(degraded.next, NONE).map((r) => r.id)).toEqual(['a']);
    // A TRUNCATED snapshot shows the newest capped set (so an absent row may drop out
    // of view) but must NOT infer settlement: no bridge entry, no durable refresh —
    // and therefore no false "it finished" for a request that is merely below the cap.
    const truncated = applyStreamSnapshot(started, snap([], { truncated: true }), NONE, 3);
    expect(truncated.refresh).toBe(false);
    expect(truncated.next.settling).toEqual([]);
  });
});

/** A controllable EventSource stand-in. */
class FakeSource implements EventSourceLike {
  onerror: ((this: unknown, ev: Event) => unknown) | null = null;
  closed = false;
  private listeners = new Map<string, ((ev: MessageEvent<string>) => void)[]>();
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

// add-stream-keepalive (task 5.2): a cascade escalation's relabel is applied IN PLACE —
// the running row now names the strong model — and never adds or resurrects a row.
describe('applyUpdated (inflight.updated)', () => {
  const strong = {
    tierAssigned: 'heavy',
    modelLabel: 'mimo-v2.6-pro',
    providerLabel: 'XiaomiMiMo',
  };

  it("changes a running row's model and provider in place, keeping its position", () => {
    let s = applyStarted(emptyStream(), row('a', { modelLabel: 'minimax-m3' }), NONE, 1);
    s = applyStarted(s, row('b'), NONE, 1);
    s = applyUpdated(s, row('a', strong), NONE, 2);
    expect(s.live.map((r) => r.id)).toEqual(['a', 'b']); // no duplicate, no reorder
    expect(s.live[0]).toMatchObject(strong);
    expect(inflightDisplay(s, NONE).find((r) => r.id === 'a')).toMatchObject(strong);
  });

  it('ignores a stale update for a settled id or one whose durable row is shown', () => {
    const started = applyStarted(emptyStream(), row('a'), NONE, 1);
    const settled = applySettled(started, 'a', 2).next;
    const late = applyUpdated(settled, row('a', strong), NONE, 3);
    expect(late.live).toEqual([]); // not resurrected
    expect(late.settling.map((x) => x.row.modelLabel)).toEqual(['m']); // bridge untouched
    const durable = applyUpdated(started, row('a', strong), new Set(['a']), 3);
    expect(durable.live[0]!.modelLabel).toBe('m'); // the durable row wins
  });

  it('adds nothing for an id it is not displaying', () => {
    const s = applyUpdated(emptyStream(), row('x', strong), NONE, 1);
    expect(s.live).toEqual([]);
  });

  it('prunes expired terminal markers like applyStarted does', () => {
    const started = applyStarted(emptyStream(), row('a'), NONE, 1);
    const settled = applySettled(started, 'a', 2).next;
    expect(settled.terminal['a']).toBe(2);
    const later = applyUpdated(settled, row('zz'), NONE, 2 + 10 * 60_000);
    expect(later.terminal['a']).toBeUndefined();
  });
});

describe('createEventStream', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const opts = (over: Record<string, unknown> = {}) => ({
    onSnapshot: () => undefined,
    onStarted: () => undefined,
    onSettled: () => undefined,
    onInvalidated: () => undefined,
    onResync: () => undefined,
    onUnexpectedFailure: () => undefined,
    scheduleReconnect: () => undefined, // no auto-reconnect in tests
    ...over,
  });

  it('stays on polling when the runtime has no EventSource (never constructs one)', () => {
    const seen: StreamHealth[] = [];
    createRoot((d) => {
      // No factory available → feature detection must prevent any construction.
      const h = createEventStream({
        ...(opts({ onHealth: (x: StreamHealth) => seen.push(x) }) as Parameters<
          typeof createEventStream
        >[0]),
        // A factory that reports "unavailable" is how feature detection surfaces: the
        // client must never attempt construction (a bare `new EventSource` would throw).
        factory: () => {
          throw new Error('EventSource is not available in this runtime');
        },
      });
      expect(h.health()).toBe('polling');
      d();
    });
    // In happy-dom EventSource may be absent; either way health is never 'live'.
    expect(seen.every((h) => h !== 'live')).toBe(true);
  });

  it('delivers inflight.updated to onUpdated (add-stream-keepalive)', () => {
    const src = new FakeSource();
    const updated: InflightRow[] = [];
    createRoot((d) => {
      createEventStream(
        opts({ factory: () => src, onUpdated: (r: InflightRow) => updated.push(r) }),
      );
      src.emit('inflight.updated', { row: row('a', { modelLabel: 'mimo-v2.6-pro' }) });
      d();
    });
    expect(updated.map((r) => r.modelLabel)).toEqual(['mimo-v2.6-pro']);
  });

  it('reports live on a frame, and adopts the server-advertised intervals', () => {
    const src = new FakeSource();
    createRoot((d) => {
      const h = createEventStream(opts({ factory: () => src }));
      expect(h.health()).toBe('connecting');
      src.emit('snapshot', {
        items: [],
        available: true,
        truncated: false,
        heartbeatIntervalMs: 1_000,
        reconciliationIntervalMs: 7_000,
      });
      expect(h.health()).toBe('live');
      expect(h.reconcileMs()).toBe(7_000); // never assume the default
      d();
    });
  });

  it('degrades to polling and probes /api/me on ANY failure (status is unknowable)', () => {
    const src = new FakeSource();
    let probes = 0;
    createRoot((d) => {
      const h = createEventStream(
        opts({
          factory: () => src,
          onUnexpectedFailure: () => void (probes += 1),
        }),
      );
      src.emit('heartbeat', {});
      expect(h.health()).toBe('live');
      src.fail();
      expect(h.health()).toBe('polling');
      expect(probes).toBe(1); // unconditional probe is what makes the re-gate reliable
      d();
    });
  });

  it('treats a stream gone quiet past its tolerance as unhealthy', () => {
    const src = new FakeSource();
    createRoot((d) => {
      const h = createEventStream(opts({ factory: () => src }));
      src.emit('snapshot', {
        items: [],
        available: true,
        truncated: false,
        heartbeatIntervalMs: 1_000,
        reconciliationIntervalMs: 30_000,
      });
      expect(h.health()).toBe('live');
      // Tolerance is ~2x the advertised interval + jitter, NOT the interval itself.
      vi.advanceTimersByTime(1_500);
      expect(h.health()).toBe('live');
      vi.advanceTimersByTime(staleAfterMs(1_000) + 1_100);
      expect(h.health()).toBe('polling'); // buffered/blocked shows as polling
      d();
    });
  });

  it('routes deltas to their handlers', () => {
    const src = new FakeSource();
    const got: string[] = [];
    createRoot((d) => {
      createEventStream(
        opts({
          factory: () => src,
          onStarted: (r: InflightRow) => got.push(`started:${r.id}`),
          onSettled: (id: string) => got.push(`settled:${id}`),
          onInvalidated: () => got.push('nudge'),
          onResync: () => got.push('resync'),
        }),
      );
      src.emit('inflight.started', { row: row('a') });
      src.emit('inflight.settled', { id: 'a' });
      src.emit('analytics.invalidated', {});
      src.emit('resync', {});
      d();
    });
    expect(got).toEqual(['started:a', 'settled:a', 'nudge', 'resync']);
  });
});
