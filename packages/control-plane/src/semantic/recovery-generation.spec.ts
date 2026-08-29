import {
  RebuildLease,
  RecoveryGeneration,
  SLOT_OFFSETS_MS,
  type GenerationEnd,
  type RecoveryDeps,
  type SlotOutcome,
} from './recovery-generation';

/** A controllable clock: timers fire only when the test advances past them. */
function fakeClock() {
  let now = 0;
  const pending: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      pending.push({ at: now + ms, fn, id });
      return id as unknown as NodeJS.Timeout;
    },
    clearTimer: (t: NodeJS.Timeout) => {
      const i = pending.findIndex((p) => (p.id as unknown as NodeJS.Timeout) === t);
      if (i >= 0) pending.splice(i, 1);
    },
    /** Advance to `ms`, firing every timer now due — in one step, so deadlines
     * COALESCE exactly as they do after a clock jump or a suspended host. */
    async advanceTo(ms: number): Promise<void> {
      now = ms;
      const due = pending.filter((p) => p.at <= now).sort((a, b) => a.at - b.at);
      for (const d of due) pending.splice(pending.indexOf(d), 1);
      for (const d of due) d.fn();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    get pendingCount() {
      return pending.length;
    },
  };
}

function harness(over: Partial<RecoveryDeps> = {}) {
  const slots: { index: number; outcome: SlotOutcome }[] = [];
  const ends: GenerationEnd[] = [];
  const lease = new RebuildLease();
  const clock = fakeClock();
  const deps: RecoveryDeps = {
    isQuiet: () => true,
    acquireLease: () => lease.acquire(),
    execute: () => Promise.resolve(),
    classify: () => 'retryable',
    onSlot: (index, outcome) => slots.push({ index, outcome }),
    onEnd: (end) => ends.push(end),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...over,
  };
  return { gen: new RecoveryGeneration('bundled', deps), slots, ends, clock, lease };
}

const LAST = SLOT_OFFSETS_MS.length - 1;

describe('recovery generation', () => {
  it('recovers on a later slot without a restart', async () => {
    let runs = 0;
    const h = harness({
      execute: () => {
        runs += 1;
        return runs === 1 ? Promise.reject(new Error('still slow')) : Promise.resolve();
      },
    });
    h.gen.arm();
    await h.clock.advanceTo(SLOT_OFFSETS_MS[0]!);
    await h.clock.advanceTo(SLOT_OFFSETS_MS[1]!);
    expect(h.slots.map((s) => s.outcome)).toEqual(['ran-failed', 'succeeded']);
    expect(h.ends).toEqual(['succeeded']);
    expect(h.clock.pendingCount).toBe(0); // success cancels the rest
  });

  it('a terminal fault ends the generation immediately', async () => {
    const h = harness({
      execute: () => Promise.reject(new Error('degenerate')),
      classify: () => 'terminal',
    });
    h.gen.arm();
    await h.clock.advanceTo(SLOT_OFFSETS_MS[0]!);
    expect(h.ends).toEqual(['terminal']);
    expect(h.clock.pendingCount).toBe(0);
  });

  it('slots that never find quiet still advance, so the final one runs', async () => {
    // THE property that makes the gate safe to rely on. Under continuous
    // traffic the first two close unrun; the last runs anyway.
    let executed = 0;
    const h = harness({
      isQuiet: () => false,
      execute: () => {
        executed += 1;
        return Promise.resolve();
      },
    });
    h.gen.arm();
    for (const off of SLOT_OFFSETS_MS) await h.clock.advanceTo(off);
    expect(h.slots.map((s) => s.outcome)).toEqual(['closed-unrun', 'closed-unrun', 'succeeded']);
    expect(executed).toBe(1);
    expect(h.ends).toEqual(['succeeded']);
  });

  it('distinguishes closed-unrun from ran-abandoned from ran-failed', async () => {
    let n = 0;
    const h = harness({
      isQuiet: () => n > 0, // slot 1 never starts
      execute: () => {
        n += 1;
        return Promise.reject(new Error(n === 1 ? 'traffic' : 'slow'));
      },
      classify: (err) => ((err as Error).message === 'traffic' ? 'abandoned' : 'retryable'),
    });
    h.gen.arm();
    await h.clock.advanceTo(SLOT_OFFSETS_MS[0]!);
    n = 1; // quiet from here
    await h.clock.advanceTo(SLOT_OFFSETS_MS[1]!);
    await h.clock.advanceTo(SLOT_OFFSETS_MS[2]!);
    expect(h.slots.map((s) => s.outcome)).toEqual(['closed-unrun', 'ran-failed', 'ran-failed']);
    expect(h.ends).toEqual(['exhausted']);
  });

  it('exhausts once, and a retryable failure of the FINAL slot arms nothing further', async () => {
    const h = harness({ execute: () => Promise.reject(new Error('slow')) });
    h.gen.arm();
    for (const off of SLOT_OFFSETS_MS) await h.clock.advanceTo(off);
    expect(h.ends).toEqual(['exhausted']);
    expect(h.clock.pendingCount).toBe(0);
    await h.clock.advanceTo(SLOT_OFFSETS_MS[2]! * 10);
    expect(h.ends).toEqual(['exhausted']); // still exactly one
  });

  it('keeps a COALESCED final slot pending behind an execution instead of losing it', async () => {
    // A clock jump makes all three deadlines due at once while slot 1 is still
    // running. A sibling-only retention rule would close the final slot unrun
    // and strand the source — the exact liveness hole the forced slot exists
    // to close.
    let settleFirst: (() => void) | undefined;
    let executed = 0;
    const h = harness({
      execute: () => {
        executed += 1;
        return executed === 1
          ? new Promise<void>((resolve) => {
              settleFirst = () => resolve();
            }).then(() => Promise.reject(new Error('slow')))
          : Promise.resolve();
      },
    });
    h.gen.arm();
    await h.clock.advanceTo(SLOT_OFFSETS_MS[2]!); // ALL deadlines at once
    expect(executed).toBe(1); // one running; the others could not start
    settleFirst?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(executed).toBe(2); // the retained final slot took its turn
    expect(h.ends).toEqual(['succeeded']);
  });

  it('serializes across sources and never runs two rebuilds at once', () => {
    const lease = new RebuildLease();
    const a = lease.acquire();
    expect(a).not.toBeNull();
    expect(lease.acquire()).toBeNull();
    a?.();
    a?.(); // idempotent
    expect(lease.acquire()).not.toBeNull();
  });

  it('shutdown closes the generation and stops every pending slot', async () => {
    const h = harness();
    h.gen.arm();
    h.gen.close('shutdown');
    expect(h.ends).toEqual(['shutdown']);
    expect(h.clock.pendingCount).toBe(0);
    await h.clock.advanceTo(SLOT_OFFSETS_MS[LAST]!);
    expect(h.slots).toEqual([]); // nothing ran after the fence
  });

  it('arms once and schedules absolute offsets, not chained delays', () => {
    const h = harness();
    h.gen.arm();
    h.gen.arm(); // idempotent
    expect(h.clock.pendingCount).toBe(SLOT_OFFSETS_MS.length);
    expect(SLOT_OFFSETS_MS).toEqual([60_000, 300_000, 900_000]);
  });
});
