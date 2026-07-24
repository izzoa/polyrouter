import { createSignal, type Accessor } from 'solid-js';
import type { InflightRow, InflightSnapshot } from './api';

/**
 * The dashboard event-stream client (phase2-add-dashboard-event-stream).
 *
 * Polling is the reliable core; this is an optimization layered over it. Anything
 * doubtful — no `EventSource` in the runtime, a refusal, a drop, or a stream that goes
 * quiet past its heartbeat window — reports `polling` so the caller resumes the poll.
 */

export type StreamHealth = 'connecting' | 'live' | 'polling';

/** Injectable transport so tests can drive frames deterministically. */
export type EventSourceFactory = (url: string) => EventSourceLike;

export interface EventSourceLike {
  addEventListener: (type: string, listener: (ev: MessageEvent<string>) => void) => void;
  close: () => void;
  onerror: ((this: unknown, ev: Event) => unknown) | null;
}

export interface StreamSnapshotPayload extends InflightSnapshot {
  heartbeatIntervalMs: number;
  reconciliationIntervalMs: number;
}

export interface EventStreamOptions {
  url?: string;
  /** The authoritative view: initial, after a `resync`, or a server re-snapshot. */
  onSnapshot: (snap: StreamSnapshotPayload) => void;
  onStarted: (row: InflightRow) => void;
  onSettled: (id: string) => void;
  onInvalidated: () => void;
  /** Drop delta state and re-establish from a fresh snapshot. */
  onResync: () => void;
  /**
   * Called on EVERY unexpected failure. A native `EventSource` exposes no status and
   * no reason on close, so an authorization-driven close is indistinguishable from any
   * other — probing unconditionally is what makes the mid-session re-gate reliable.
   */
  onUnexpectedFailure: () => void;
  /** Health transitions, reported imperatively so a non-reactive caller (the store)
   * needs no reactive root of its own. */
  onHealth?: (health: StreamHealth) => void;
  /** The server-advertised reconciliation cadence, once the snapshot announces it. */
  onReconcileMs?: (ms: number) => void;
  factory?: EventSourceFactory;
  now?: () => number;
  /** Test seam: skip the real backoff delays. */
  scheduleReconnect?: (fn: () => void, ms: number) => void;
}

const DEFAULT_HEARTBEAT_MS = 25_000;
/** Health tolerance: a stream is stale only after ~2× the advertised heartbeat plus a
 * jitter allowance. Timing out AT the interval would mark a perfectly healthy stream
 * stale on ordinary timer or network jitter. */
export const STALE_FACTOR = 2;
export const STALE_JITTER_MS = 5_000;

export function staleAfterMs(heartbeatMs: number): number {
  return heartbeatMs * STALE_FACTOR + STALE_JITTER_MS;
}

/** Native factory, or `null` when the runtime has no `EventSource` — in which case we
 * never attempt to construct one (a bare call would throw) and stay on polling. */
export function nativeEventSourceFactory(): EventSourceFactory | null {
  const ctor = (globalThis as { EventSource?: new (url: string) => EventSourceLike }).EventSource;
  if (ctor === undefined) return null;
  return (url: string) => new ctor(url);
}

export interface EventStreamHandle {
  health: Accessor<StreamHealth>;
  /** Reconciliation cadence the SERVER advertised (never assume the default). */
  reconcileMs: Accessor<number>;
  close: () => void;
}

export function createEventStream(opts: EventStreamOptions): EventStreamHandle {
  const url = opts.url ?? '/api/events';
  const now = opts.now ?? ((): number => Date.now());
  const factory = opts.factory ?? nativeEventSourceFactory();
  const schedule =
    opts.scheduleReconnect ??
    ((fn: () => void, ms: number): void => {
      const t: ReturnType<typeof setTimeout> = setTimeout(fn, ms);
      t.unref?.();
    });

  const [health, setHealthSignal] = createSignal<StreamHealth>(
    factory === null ? 'polling' : 'connecting',
  );
  if (factory === null) opts.onHealth?.('polling');
  const setHealth = (h: StreamHealth): void => {
    setHealthSignal(h);
    opts.onHealth?.(h);
  };
  const [reconcileMs, setReconcileMsSignal] = createSignal(30_000);
  const setReconcileMs = (ms: number): void => {
    setReconcileMsSignal(ms);
    opts.onReconcileMs?.(ms);
  };

  let es: EventSourceLike | null = null;
  let closedByCaller = false;
  let attempts = 0;
  let heartbeatMs = DEFAULT_HEARTBEAT_MS;
  let lastFrameAt = now();
  let watchdog: ReturnType<typeof setInterval> | undefined;

  const stopWatchdog = (): void => {
    if (watchdog !== undefined) {
      clearInterval(watchdog);
      watchdog = undefined;
    }
  };

  const teardown = (): void => {
    stopWatchdog();
    if (es !== null) {
      try {
        es.close();
      } catch {
        // best-effort
      }
      es = null;
    }
  };

  /** Any failure path: report polling, probe `/api/me` (we cannot tell WHY it failed),
   * and retry with capped backoff + jitter so a permanent refusal can never become a
   * tight loop. */
  const degrade = (): void => {
    if (closedByCaller) return;
    teardown();
    setHealth('polling');
    opts.onUnexpectedFailure();
    attempts += 1;
    const backoff = Math.min(30_000, 1_000 * 2 ** Math.min(attempts, 5));
    schedule(connect, backoff + Math.floor(Math.random() * 1_000));
  };

  const markFrame = (): void => {
    lastFrameAt = now();
    if (health() !== 'live') setHealth('live');
  };

  const startWatchdog = (): void => {
    stopWatchdog();
    watchdog = setInterval(() => {
      if (closedByCaller) return;
      // "Healthy" is liveness AND freshness: a buffering intermediary that swallows
      // frames must show as polling rather than looking like an idle instance.
      if (now() - lastFrameAt > staleAfterMs(heartbeatMs)) degrade();
    }, 1_000);
    watchdog.unref?.();
  };

  function connect(): void {
    if (closedByCaller || factory === null) return;
    let source: EventSourceLike;
    try {
      source = factory(url);
    } catch {
      degrade();
      return;
    }
    es = source;
    lastFrameAt = now();
    setHealth('connecting');

    const on = (type: string, handle: (data: unknown) => void): void => {
      source.addEventListener(type, (ev: MessageEvent<string>) => {
        markFrame();
        if (ev.data === undefined || ev.data === '') {
          handle({});
          return;
        }
        try {
          handle(JSON.parse(ev.data) as unknown);
        } catch {
          // A malformed frame is a protocol fault: re-establish rather than guess.
          degrade();
        }
      });
    };

    on('snapshot', (data) => {
      const p = data as StreamSnapshotPayload;
      heartbeatMs = typeof p.heartbeatIntervalMs === 'number' ? p.heartbeatIntervalMs : DEFAULT_HEARTBEAT_MS;
      if (typeof p.reconciliationIntervalMs === 'number') setReconcileMs(p.reconciliationIntervalMs);
      attempts = 0; // a completed handshake resets the backoff
      opts.onSnapshot(p);
    });
    on('inflight.started', (data) => opts.onStarted((data as { row: InflightRow }).row));
    on('inflight.settled', (data) => opts.onSettled((data as { id: string }).id));
    on('analytics.invalidated', () => opts.onInvalidated());
    on('resync', () => opts.onResync());
    on('heartbeat', () => undefined); // liveness only — markFrame already ran

    source.onerror = (): void => degrade();
    startWatchdog();
  }

  connect();

  return {
    health,
    reconcileMs,
    close: (): void => {
      closedByCaller = true;
      teardown();
      setHealth('polling');
    },
  };
}
