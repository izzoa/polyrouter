import type { SemanticCentroids } from '@polyrouter/data-plane';
import type { LearningLabel } from '../learning-format';
import {
  windowDayStamps,
  type GenerationGate,
  type LabelAggregate,
  type LearnedState,
  type LearningStore,
  type RotateOptions,
  type RotatedEvidence,
} from '../learning-store';

/**
 * The in-memory reference `LearningStore` — the "simulated Redis" the store's
 * unit tests drive (the breaker's `InMemoryBreakerStore` precedent). It holds the
 * same four namespaces the Redis keys model (pending / work / stage / active) as
 * typed maps and applies the SAME transitions the Lua does — resume-existing
 * rotate, below-floor buckets left in place, generation-gated promote and read,
 * whole-tenant delete — so a unit test can pin the semantics deterministically
 * without Redis, while the real-Redis parity spec pins the Lua to this reference.
 *
 * It is test-only (production learning state is Redis-only, D8); it therefore
 * lives under `testing/` and adds a `seedPending` helper standing in for the
 * hot-path accumulator's flush.
 */
export class InMemoryLearningStore implements LearningStore {
  /** `hmac|epoch|label|revision|day` → summed vector + count (fixed-window bucket). */
  private readonly pending = new Map<string, { sum: Float32Array; count: number }>();
  /** `hmac|occ` → rotated per-label sums. */
  private readonly work = new Map<string, { high?: LabelAggregate; low?: LabelAggregate }>();
  /** `hmac|occ` → unreadable staged candidate. */
  private readonly staged = new Map<string, LearnedState>();
  /** `hmac` → the one active state. */
  private readonly active = new Map<string, LearnedState>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Add a cohort sum + count into a pending bucket, element-wise — the in-memory
   * mirror of the accumulator's `ADD_PENDING_LUA` flush. */
  seedPending(
    hmac: string,
    epoch: number,
    label: LearningLabel,
    revision: string,
    day: string,
    sum: Float32Array,
    count: number,
  ): void {
    const k = `${hmac}|${String(epoch)}|${label}|${revision}|${day}`;
    const cur = this.pending.get(k);
    if (cur === undefined) {
      this.pending.set(k, { sum: Float32Array.from(sum), count });
      return;
    }
    if (cur.sum.length !== sum.length) return;
    for (let i = 0; i < sum.length; i += 1) cur.sum[i] = (cur.sum[i] ?? 0) + (sum[i] ?? 0);
    this.pending.set(k, { sum: cur.sum, count: cur.count + count });
  }

  rotate(hmac: string, occurrenceId: string, opts: RotateOptions): Promise<RotatedEvidence> {
    const wk = `${hmac}|${occurrenceId}`;
    const existing = this.work.get(wk);
    if (existing !== undefined) {
      // Clone on return: Redis unpacking yields fresh arrays, so a caller that
      // normalizes a returned sum in place must not corrupt the stored snapshot
      // (clink 4.1 Low-4).
      return Promise.resolve({ high: cloneAgg(existing.high), low: cloneAgg(existing.low) });
    }
    const days = windowDayStamps(this.now(), opts.windowDays);
    const fold = (label: LearningLabel): { agg: LabelAggregate | null; keys: string[] } => {
      // Accumulate across buckets in float64, round once to float32 — matching the
      // Lua's struct-based fold (per-bucket sums are already float32).
      let acc: number[] | null = null;
      let count = 0;
      const keys: string[] = [];
      for (const d of days) {
        const k = `${hmac}|${String(opts.epoch)}|${label}|${opts.revision}|${d}`;
        const b = this.pending.get(k);
        if (b === undefined) continue;
        if (acc === null) acc = new Array<number>(b.sum.length).fill(0);
        if (acc.length !== b.sum.length) continue;
        for (let i = 0; i < acc.length; i += 1) acc[i] = (acc[i] ?? 0) + (b.sum[i] ?? 0);
        count += b.count;
        keys.push(k);
      }
      if (acc === null || count < opts.minSamples) return { agg: null, keys: [] };
      return { agg: { sum: Float32Array.from(acc), count }, keys };
    };
    const high = fold('high');
    const low = fold('low');
    const record: { high?: LabelAggregate; low?: LabelAggregate } = {};
    if (high.agg !== null) {
      record.high = high.agg;
      for (const k of high.keys) this.pending.delete(k);
    }
    if (low.agg !== null) {
      record.low = low.agg;
      for (const k of low.keys) this.pending.delete(k);
    }
    if (high.agg !== null || low.agg !== null) this.work.set(wk, record);
    return Promise.resolve({ high: cloneAgg(high.agg), low: cloneAgg(low.agg) });
  }

  stage(
    hmac: string,
    occurrenceId: string,
    state: LearnedState,
    _ttlSeconds: number,
  ): Promise<void> {
    this.staged.set(`${hmac}|${occurrenceId}`, cloneState(state));
    return Promise.resolve();
  }

  promote(
    hmac: string,
    occurrenceId: string,
    expected: { epoch: number; generation: number },
    _activeTtlSeconds: number,
  ): Promise<boolean> {
    const sk = `${hmac}|${occurrenceId}`;
    const active = this.active.get(hmac);
    // Idempotent: already exactly at the expected coordinates (crash-after-promote).
    if (
      active !== undefined &&
      active.epoch === expected.epoch &&
      active.generation === expected.generation
    ) {
      this.staged.delete(sk);
      this.work.delete(sk);
      return Promise.resolve(true);
    }
    const st = this.staged.get(sk);
    if (st !== undefined && st.epoch === expected.epoch && st.generation === expected.generation) {
      // MONOTONIC: promote only over an older-or-absent active — never downgrade a
      // newer generation a later occurrence already promoted (clink 4.1 High-1).
      const olderOrAbsent =
        active === undefined ||
        active.epoch < expected.epoch ||
        (active.epoch === expected.epoch && active.generation < expected.generation);
      this.staged.delete(sk);
      this.work.delete(sk);
      if (olderOrAbsent) {
        this.active.set(hmac, cloneState(st));
        return Promise.resolve(true);
      }
      return Promise.resolve(false); // superseded stage discarded, newer active kept
    }
    return Promise.resolve(false);
  }

  readActive(hmac: string, gate: GenerationGate): Promise<SemanticCentroids | null> {
    const a = this.active.get(hmac);
    if (a === undefined) return Promise.resolve(null);
    if (
      a.epoch !== gate.epoch ||
      a.generation !== gate.generation ||
      a.revision !== gate.revision
    ) {
      return Promise.resolve(null);
    }
    // Clone on return (clink 4.1 Low-4) — mirror Redis returning fresh arrays.
    return Promise.resolve({
      high: Float32Array.from(a.centroids.high),
      low: Float32Array.from(a.centroids.low),
    });
  }

  pendingCounts(
    hmac: string,
    epoch: number,
    revision: string,
  ): Promise<{ high: number; low: number }> {
    let high = 0;
    let low = 0;
    const hp = `${hmac}|${String(epoch)}|high|${revision}|`;
    const lp = `${hmac}|${String(epoch)}|low|${revision}|`;
    for (const [key, b] of this.pending) {
      if (key.startsWith(hp)) high += b.count;
      else if (key.startsWith(lp)) low += b.count;
    }
    return Promise.resolve({ high, low });
  }

  discardStaleRevisions(
    hmac: string,
    epoch: number,
    currentRevision: string,
  ): Promise<{ pendingDiscarded: number; activeDiscarded: boolean }> {
    const prefix = `${hmac}|${String(epoch)}|`;
    let pendingDiscarded = 0;
    for (const key of [...this.pending.keys()]) {
      if (!key.startsWith(prefix)) continue;
      const revision = key.split('|')[3]; // `${hmac}|${epoch}|${label}|${revision}|${day}`
      if (revision !== currentRevision) {
        this.pending.delete(key);
        pendingDiscarded += 1;
      }
    }
    const active = this.active.get(hmac);
    let activeDiscarded = false;
    if (active !== undefined && active.revision !== currentRevision) {
      this.active.delete(hmac);
      activeDiscarded = true;
    }
    return Promise.resolve({ pendingDiscarded, activeDiscarded });
  }

  deleteTenant(hmac: string): Promise<void> {
    const prefix = `${hmac}|`;
    for (const m of [this.pending, this.work, this.staged] as Map<string, unknown>[]) {
      for (const key of [...m.keys()]) if (key.startsWith(prefix)) m.delete(key);
    }
    this.active.delete(hmac);
    return Promise.resolve();
  }
}

function cloneState(s: LearnedState): LearnedState {
  return {
    epoch: s.epoch,
    generation: s.generation,
    revision: s.revision,
    centroids: {
      high: Float32Array.from(s.centroids.high),
      low: Float32Array.from(s.centroids.low),
    },
  };
}

function cloneAgg(a: LabelAggregate | null | undefined): LabelAggregate | null {
  return a === null || a === undefined ? null : { sum: Float32Array.from(a.sum), count: a.count };
}
