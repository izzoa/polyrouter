import { createEffect, createSignal, onCleanup } from 'solid-js';

/**
 * A visibility-gated, single-flight recurring poller (phase1-tune-dashboard-polling).
 *
 * The three call sites used to hand-roll `setInterval` inside `onMount`, gated only
 * on the `live` prop and page mount — so a backgrounded tab kept polling at full
 * rate for output nobody could see. This primitive owns the whole lifecycle so the
 * one piece of tricky logic (resume without double-firing, and without overlapping a
 * pending run) lives in exactly one tested place.
 *
 * Gates are independent and ALL must hold: `enabled()` AND document visibility.
 * Visibility only decides WHETHER a poll happens — never how its response is
 * interpreted; a poll that did not fire is not a snapshot.
 */

/** Where visibility comes from. Injectable so tests need not fight a read-only
 * `document.visibilityState`. */
export interface VisibilitySource {
  isVisible: () => boolean;
  /** Subscribe to changes; returns an unsubscribe. */
  subscribe: (onChange: () => void) => () => void;
}

export const documentVisibility: VisibilitySource = {
  isVisible: () => globalThis.document?.visibilityState !== 'hidden',
  subscribe: (onChange) => {
    const doc = globalThis.document;
    if (doc === undefined) return () => undefined;
    doc.addEventListener('visibilitychange', onChange);
    return () => doc.removeEventListener('visibilitychange', onChange);
  },
};

export interface PollerOptions {
  /** The loader. Errors are the loader's own concern (these are `void`-returning
   * store loaders that record their own error state). */
  fn: () => Promise<void> | void;
  /** Cadence, as a THUNK so a reactive cadence re-arms without rebuilding the poller. */
  intervalMs: () => number;
  /** Caller-owned gate (the `live` prop, page scope), as a thunk so it stays reactive. */
  enabled: () => boolean;
  /**
   * Whether the FIRST arm of an open gate runs `fn()` immediately (default `true`).
   *
   * A hidden→visible RESUME always runs immediately, for every poller. This option
   * is only about the initial arm at mount: `Overview` and `Costs` already load via
   * `createEffect(on(() => state.range, …))` with no `defer`, which fires at mount —
   * so those pollers pass `false` to avoid a duplicate fan-out (4 extra calls each).
   */
  runImmediately?: boolean;
  visibility?: VisibilitySource;
}

export function createPoller(opts: PollerOptions): void {
  const visibility = opts.visibility ?? documentVisibility;
  const runOnFirstArm = opts.runImmediately ?? true;

  const [visible, setVisible] = createSignal(visibility.isVisible());
  const unsubscribe = visibility.subscribe(() => setVisible(visibility.isVisible()));

  /** Disposal tombstone: `enabled()` may still read a captured `props.live === true`
   * and the document may still be visible after unmount, so removing the listener
   * alone would not stop a promise continuation from creating zombie work. Every
   * async completion re-checks this. */
  let disposed = false;
  let running = false;
  /** A run was requested while one was pending → exactly ONE catch-up after it settles. */
  let trailing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The interval the live timer was armed with, so an effect re-run caused by an
   * UNRELATED reactive write does not restart the countdown. `intervalMs()` reads
   * store state (the live-row count), and the loaders write that state on every
   * poll — re-arming on each write would drift the cadence indefinitely. */
  let armedMs: number | undefined;
  let wasOpen = false;
  /** `runImmediately` governs ONLY the first-ever arm (mount). Every later gate
   * opening is a RESUME, which must always refetch immediately so a tab returned to
   * is never staler than one round-trip. */
  let everOpened = false;

  const gateOpen = (): boolean => !disposed && opts.enabled() && visible();

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    armedMs = undefined;
  };

  /** Arm a fresh timer. The cadence is always measured from this call, so a resume
   * is timed from its catch-up fetch rather than from a stale pending interval. */
  const arm = (ms: number): void => {
    clearTimer();
    if (!gateOpen()) return;
    armedMs = ms;
    timer = setTimeout(() => {
      timer = undefined;
      armedMs = undefined;
      void run();
    }, ms);
  };

  const run = async (): Promise<void> => {
    if (disposed) return;
    // SINGLE-FLIGHT. `loadInflight` folds every response with no generation guard,
    // so two overlapping runs could apply snapshots out of completion order and
    // falsely settle a freshly-observed row. Defer instead of overlapping.
    if (running) {
      trailing = true;
      return;
    }
    if (!gateOpen()) return;
    running = true;
    try {
      await opts.fn();
    } finally {
      running = false;
      const wantTrailing = trailing;
      trailing = false;
      // Re-check disposal and the gate AFTER awaiting — both may have changed.
      if (disposed) {
        clearTimer();
      } else if (!gateOpen()) {
        clearTimer();
      } else if (wantTrailing) {
        void run(); // exactly one catch-up; it arms on its own completion
      } else {
        arm(opts.intervalMs());
      }
    }
  };

  createEffect(() => {
    const open = gateOpen();
    const ms = opts.intervalMs(); // tracked, so a cadence change re-arms
    if (disposed) return;
    if (!open) {
      wasOpen = false;
      clearTimer();
      return;
    }
    const justOpened = !wasOpen;
    wasOpen = true;
    if (justOpened) {
      const immediate = everOpened || runOnFirstArm; // resume always; mount per option
      everOpened = true;
      if (immediate) void run(); // arms itself when it settles
      else arm(ms);
    } else if (!running && ms !== armedMs) {
      // The cadence VALUE changed while open and idle: re-arm, WITHOUT an extra
      // fetch. An effect re-run at the same cadence leaves the countdown alone.
      arm(ms);
    }
    // If a run is pending, its `finally` arms with the fresh `intervalMs()`.
  });

  onCleanup(() => {
    disposed = true;
    trailing = false;
    clearTimer();
    unsubscribe();
  });
}
