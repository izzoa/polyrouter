import { createRoot, createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INFLIGHT_FAST_MS, INFLIGHT_IDLE_MS, inflightCadenceMs } from './inflight';
import { createPoller, type VisibilitySource } from './poller';

/** A controllable visibility source — the injectable seam that lets these tests
 * avoid fighting a read-only `document.visibilityState`. */
function fakeVisibility(initial = true): VisibilitySource & { set: (v: boolean) => void } {
  let visible = initial;
  const subs = new Set<() => void>();
  return {
    isVisible: () => visible,
    subscribe: (onChange) => {
      subs.add(onChange);
      return () => subs.delete(onChange);
    },
    set: (v: boolean) => {
      visible = v;
      for (const s of subs) s();
    },
  };
}

/** Let queued Solid effects and promise continuations settle. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

/** A deferred so a test can hold a run pending and resolve it on demand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('inflightCadenceMs (phase1-tune-dashboard-polling)', () => {
  it('relaxes only while provably empty and snaps back on the first row', () => {
    expect(inflightCadenceMs(0)).toBe(INFLIGHT_IDLE_MS);
    expect(INFLIGHT_IDLE_MS).toBe(5_000);
    expect(inflightCadenceMs(1)).toBe(INFLIGHT_FAST_MS);
    expect(inflightCadenceMs(7)).toBe(INFLIGHT_FAST_MS);
    expect(INFLIGHT_FAST_MS).toBe(2_500);
    // The relaxation is shallow by design — a deeper backoff is spec-forbidden.
    expect(INFLIGHT_IDLE_MS / INFLIGHT_FAST_MS).toBeLessThanOrEqual(2);
  });
});

describe('createPoller', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('issues no fetch while hidden, and exactly ONE immediate fetch on hidden→visible', async () => {
    const vis = fakeVisibility(false);
    let calls = 0;
    const dispose = createRoot((d) => {
      createPoller({ fn: () => void (calls += 1), intervalMs: () => 1_000, enabled: () => true, visibility: vis });
      return d;
    });
    try {
      await flush();
      expect(calls).toBe(0); // hidden at mount → nothing
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls).toBe(0); // still nothing while hidden

      vis.set(true);
      await flush();
      expect(calls).toBe(1); // exactly one immediate catch-up — no double-fire

      // Resumed cadence is measured FROM the catch-up fetch.
      await vi.advanceTimersByTimeAsync(999);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(2);
    } finally {
      dispose();
    }
  });

  it('honours runImmediately:false on the initial arm but still runs immediately on resume', async () => {
    const vis = fakeVisibility(true);
    let calls = 0;
    const dispose = createRoot((d) => {
      createPoller({
        fn: () => void (calls += 1),
        intervalMs: () => 1_000,
        enabled: () => true,
        runImmediately: false,
        visibility: vis,
      });
      return d;
    });
    try {
      await flush();
      expect(calls).toBe(0); // mount load belongs to the caller's range effect
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls).toBe(1);

      vis.set(false);
      await flush();
      vis.set(true);
      await flush();
      expect(calls).toBe(2); // resume ALWAYS runs immediately, even with runImmediately:false
    } finally {
      dispose();
    }
  });

  it('is SINGLE-FLIGHT: a resume during a pending run defers to exactly one trailing catch-up', async () => {
    const vis = fakeVisibility(true);
    const order: string[] = [];
    let inFlight = 0;
    let maxConcurrent = 0;
    const d1 = deferred();
    let n = 0;
    const dispose = createRoot((d) => {
      createPoller({
        fn: () => {
          n += 1;
          const label = `run${String(n)}`;
          order.push(`start:${label}`);
          inFlight += 1;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          const p = n === 1 ? d1.promise : Promise.resolve();
          return p.then(() => {
            inFlight -= 1;
            order.push(`end:${label}`);
          });
        },
        intervalMs: () => 1_000,
        enabled: () => true,
        visibility: vis,
      });
      return d;
    });
    try {
      await flush();
      expect(order).toEqual(['start:run1']); // run1 pending

      // Both an elapsed interval AND a hide→show while pending must NOT overlap it.
      await vi.advanceTimersByTimeAsync(3_000);
      vis.set(false);
      await flush();
      vis.set(true);
      await flush();
      expect(order).toEqual(['start:run1']); // still exactly one run started
      expect(maxConcurrent).toBe(1);

      d1.resolve();
      await flush();
      // Exactly ONE trailing catch-up, and it folds strictly AFTER the pending one.
      expect(order).toEqual(['start:run1', 'end:run1', 'start:run2', 'end:run2']);
      expect(maxConcurrent).toBe(1);
    } finally {
      dispose();
    }
  });

  it('is safe on disposal: a run resolving after unmount creates no work and no timers', async () => {
    const vis = fakeVisibility(true);
    let calls = 0;
    const d1 = deferred();
    const dispose = createRoot((d) => {
      createPoller({
        fn: () => {
          calls += 1;
          return calls === 1 ? d1.promise : Promise.resolve();
        },
        intervalMs: () => 1_000,
        enabled: () => true,
        visibility: vis,
      });
      return d;
    });
    await flush();
    expect(calls).toBe(1);

    // Queue trailing work, THEN unmount, THEN resolve.
    await vi.advanceTimersByTimeAsync(2_000);
    dispose();
    d1.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    vis.set(false);
    vis.set(true);
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(calls).toBe(1); // no trailing catch-up, no re-arm, no zombie poll
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closing the gate during a pending run cancels the trailing catch-up', async () => {
    const vis = fakeVisibility(true);
    let calls = 0;
    const d1 = deferred();
    const dispose = createRoot((d) => {
      createPoller({
        fn: () => {
          calls += 1;
          return calls === 1 ? d1.promise : Promise.resolve();
        },
        intervalMs: () => 1_000,
        enabled: () => true,
        visibility: vis,
      });
      return d;
    });
    try {
      await flush();
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(2_000); // request a trailing catch-up
      vis.set(false); // gate closes BEFORE the pending run settles
      await flush();
      d1.resolve();
      await flush();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls).toBe(1); // the catch-up must not fire into a closed gate
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      dispose();
    }
  });

  it('re-arms on a cadence change WITHOUT an extra fetch', async () => {
    const vis = fakeVisibility(true);
    const [ms, setMs] = createSignal(5_000);
    let calls = 0;
    const dispose = createRoot((d) => {
      createPoller({
        fn: () => void (calls += 1),
        intervalMs: ms,
        enabled: () => true,
        runImmediately: false,
        visibility: vis,
      });
      return d;
    });
    try {
      await flush();
      expect(calls).toBe(0);
      await vi.advanceTimersByTimeAsync(2_000);
      setMs(2_500); // cadence change mid-wait
      await flush();
      expect(calls).toBe(0); // re-arm must not fetch
      await vi.advanceTimersByTimeAsync(2_499);
      expect(calls).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(1); // fires on the NEW cadence, measured from the re-arm
    } finally {
      dispose();
    }
  });

  it('keeps a poller stopped while enabled() is false, and enabled() stays REACTIVE', async () => {
    const vis = fakeVisibility(true);
    const [live, setLive] = createSignal(false);
    let calls = 0;
    const dispose = createRoot((d) => {
      createPoller({ fn: () => void (calls += 1), intervalMs: () => 1_000, enabled: live, visibility: vis });
      return d;
    });
    try {
      await flush();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls).toBe(0); // visible, but disabled

      // Reactivate with NO visibility event — an implementation that read enabled()
      // only once would never start.
      setLive(true);
      await flush();
      expect(calls).toBe(1);

      setLive(false);
      await flush();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls).toBe(1); // stops immediately

      setLive(true);
      await flush();
      expect(calls).toBe(2); // restarts with exactly one fetch
      await vi.advanceTimersByTimeAsync(999);
      expect(calls).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(3); // on a freshly-measured interval
    } finally {
      dispose();
    }
  });

  it('unsubscribes its visibility listener on cleanup (no zombie poll)', async () => {
    const vis = fakeVisibility(true);
    let subs = 0;
    const counting: VisibilitySource = {
      isVisible: vis.isVisible,
      subscribe: (cb) => {
        subs += 1;
        const off = vis.subscribe(cb);
        return () => {
          subs -= 1;
          off();
        };
      },
    };
    let calls = 0;
    const dispose = createRoot((d) => {
      createPoller({ fn: () => void (calls += 1), intervalMs: () => 1_000, enabled: () => true, visibility: counting });
      return d;
    });
    await flush();
    expect(subs).toBe(1);
    expect(calls).toBe(1);

    dispose();
    expect(subs).toBe(0);
    vis.set(false);
    vis.set(true); // a post-unmount transition must not resume anything
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drives a 0→1 row cadence transition to the fast interval with no extra fetch', async () => {
    const vis = fakeVisibility(true);
    const [rows, setRows] = createSignal(0);
    let calls = 0;
    const dispose = createRoot((d) => {
      createPoller({
        fn: () => void (calls += 1),
        intervalMs: () => inflightCadenceMs(rows()),
        enabled: () => true,
        runImmediately: false,
        visibility: vis,
      });
      return d;
    });
    try {
      await flush();
      // Idle: 5 s cadence.
      await vi.advanceTimersByTimeAsync(4_999);
      expect(calls).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(1);

      // A row appears → next arm is the FAST cadence, with no extra fetch.
      setRows(1);
      await flush();
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(2_499);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(2);
    } finally {
      dispose();
    }
  });
});
