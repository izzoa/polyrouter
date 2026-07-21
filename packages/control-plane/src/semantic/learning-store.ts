import type { SemanticCentroids } from '@polyrouter/data-plane';
import type { Redis } from 'ioredis';
import { ROTATE_LUA, STAGE_LUA, PROMOTE_LUA } from './learning-lua';
import {
  activeKey,
  dayStamp,
  packVector,
  pendingBucketKey,
  stageKey,
  unpackVector,
  workKey,
  type LearningLabel,
} from './learning-format';

/**
 * The Redis learning store (add-semantic-learning D5/D6, task 4.1). The
 * control-plane sweep's Redis half: it rotates fixed-window pending buckets (the
 * evidence accumulator's hot-path writes) into an occurrence WORK key, STAGEs a
 * candidate generation unreadably, PROMOTEs it to the single ACTIVE state, and
 * serves that state to the classification decorator — all keyed under one
 * `{tenantHmac}` hash-tag so the multi-key Lua stays single-slot.
 *
 * Crash-atomicity (D5) lives ACROSS this store and Postgres: Postgres is
 * authoritative (CAS + audit in one txn), the stage is promoted only AFTER that
 * commit, and readers accept only state whose `(epoch, generation)` matches the
 * decision-time gate — so a promoted-but-uncommitted stage is inert and a
 * crashed-then-retried occurrence self-heals. This store provides the atomic
 * Redis primitives; the sweep (task 4.2) sequences them around the Postgres txn.
 *
 * Privacy (invariant 8): every value here is an AGGREGATE (a sum over ≥ MIN_COHORT
 * embeddings, or a learned centroid) — never a single raw embedding, never a
 * Postgres column, never logged. Losing Redis loses learning and nothing else.
 */

/** A per-label vector SUM plus the number of embeddings summed into it. The
 * sweep divides `sum` by `count` for the fresh evidence mean. */
export interface LabelAggregate {
  readonly sum: Float32Array;
  readonly count: number;
}

/** What `rotate` yields: the eligible (≥ minSamples) labels' rotated evidence.
 * A below-floor label is `null` — its buckets are left in place to keep
 * accumulating toward the floor (fixed-window freshness, not sliding-TTL). */
export interface RotatedEvidence {
  readonly high: LabelAggregate | null;
  readonly low: LabelAggregate | null;
}

/** A learned state stamped with the coordinates a reader gates on (D5). The
 * `revision` is the LEARNING-EVIDENCE revision (D7), not the classification one. */
export interface LearnedState {
  readonly epoch: number;
  readonly generation: number;
  readonly revision: string;
  readonly centroids: SemanticCentroids;
}

export interface RotateOptions {
  /** The revocation epoch whose pending buckets to rotate (clink impl High-3). */
  readonly epoch: number;
  /** The learning-evidence revision whose pending buckets to rotate. */
  readonly revision: string;
  /** Fixed-window freshness: fold buckets within the last N UTC days. */
  readonly windowDays: number;
  /** Per-label sample floor. A label below it is NOT rotated or consumed. */
  readonly minSamples: number;
  /** TTL on the occurrence work key (bounds an abandoned occurrence). */
  readonly workTtlSeconds: number;
}

export interface GenerationGate {
  readonly epoch: number;
  readonly generation: number;
  readonly revision: string;
}

/**
 * The Redis primitives the sweep and the classification decorator share. Two
 * implementations mirror each other: `RedisLearningStore` (Lua, authoritative)
 * and the in-memory reference used as the "simulated Redis" in unit tests.
 */
export interface LearningStore {
  /**
   * Rotate this occurrence's eligible pending buckets into its WORK key and
   * return their sums. RESUME-EXISTING: if the work key already exists (a retry
   * of a crashed occurrence), return the existing snapshot WITHOUT folding fresh
   * contributions in — the occurrence is fixed at its first rotate.
   */
  rotate(hmac: string, occurrenceId: string, opts: RotateOptions): Promise<RotatedEvidence>;
  /** Write an unreadable generation-`G+1` candidate under the occurrence. */
  stage(hmac: string, occurrenceId: string, state: LearnedState, ttlSeconds: number): Promise<void>;
  /**
   * Promote the occurrence's stage to the single active state, ONLY when the
   * stage's `(epoch, generation)` equals `expected` (the just-committed
   * coordinates). Idempotent: a retry after the active is already at `expected`
   * returns `true` and cleans up. Returns `false` when there is nothing matching
   * to promote.
   */
  promote(
    hmac: string,
    occurrenceId: string,
    expected: { epoch: number; generation: number },
    activeTtlSeconds: number,
  ): Promise<boolean>;
  /** Read the active centroids ONLY when every gate coordinate matches; else null. */
  readActive(hmac: string, gate: GenerationGate): Promise<SemanticCentroids | null>;
  /** Per-label count of fresh pending samples for an `(epoch, revision)` (the status
   * view's "how much evidence has accrued"). Best-effort; 0/0 on a Redis fault. */
  pendingCounts(
    hmac: string,
    epoch: number,
    revision: string,
  ): Promise<{ high: number; low: number }>;
  /**
   * Reconcile a config change: delete every pending bucket (under `epoch`) AND the
   * active state whose revision differs from `currentRevision` — evidence
   * accumulated or learned under an old config no longer means the same thing
   * (D5/D9; the sweep audits this as `discard_revision`). Returns what was
   * discarded, for the audit. Best-effort like {@link deleteTenant}; the
   * current-revision pending/active are untouched.
   */
  discardStaleRevisions(
    hmac: string,
    epoch: number,
    currentRevision: string,
  ): Promise<{ pendingDiscarded: number; activeDiscarded: boolean }>;
  /**
   * BEST-EFFORT cleanup of a tenant's learning keys. This alone does NOT
   * guarantee erasure under a concurrent writer (an accumulator flush or sweep
   * landing after the scan passes leaves a key behind — clink 4.1 High-2). The
   * RACE-PROOF guarantee is the revert protocol (task 5.2): a Postgres epoch bump
   * committed FIRST makes any in-flight sweep's CAS fail and every reader's
   * `readActive` gate out the stale epoch, THEN this cleanup runs (idempotently).
   * A key that slips past this scan is therefore already reader-inert; this just
   * reclaims the space.
   */
  deleteTenant(hmac: string): Promise<void>;
}

/** Descending `yyyymmdd` stamps for the fixed freshness window (today first). */
export function windowDayStamps(nowMs: number, windowDays: number): string[] {
  const n = Math.max(1, Math.min(Math.floor(windowDays), 366));
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) out.push(dayStamp(nowMs - i * 86_400_000));
  return out;
}

/** A TTL of 0/negative makes Redis `EXPIRE` DELETE the key — which, applied after
 * a script has already consumed pending buckets or written the stage/active, would
 * silently destroy the just-written state (clink 4.1 Med-3). Reject it before any
 * mutation. Production TTLs derive from config rails (≥ 1 day) — this guards a
 * miscomputed caller. */
function positiveTtl(seconds: number, label: string): number {
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error(
      `${label} must be a positive integer number of seconds, got ${String(seconds)}`,
    );
  }
  return seconds;
}

/** A returned integer reply is a JS number under ioredis; coerce defensively. */
function asInt(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  if (Buffer.isBuffer(v)) return Number(v.toString());
  return 0;
}

/** Reconstruct one label's aggregate from the work hash's count+sum fields. */
function aggregateFromWork(
  countBuf: Buffer | undefined,
  sumBuf: Buffer | undefined,
): LabelAggregate | null {
  if (countBuf === undefined || sumBuf === undefined) return null;
  const count = Number(countBuf.toString());
  if (!Number.isFinite(count) || count <= 0) return null;
  const sum = unpackVector(sumBuf);
  return sum === null ? null : { sum, count };
}

export class RedisLearningStore implements LearningStore {
  constructor(
    private readonly redis: Redis,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async rotate(hmac: string, occurrenceId: string, opts: RotateOptions): Promise<RotatedEvidence> {
    const days = windowDayStamps(this.now(), opts.windowDays);
    const highKeys = days.map((d) => pendingBucketKey(hmac, opts.epoch, 'high', opts.revision, d));
    const lowKeys = days.map((d) => pendingBucketKey(hmac, opts.epoch, 'low', opts.revision, d));
    positiveTtl(opts.workTtlSeconds, 'rotate workTtlSeconds');
    const wk = workKey(hmac, occurrenceId);
    const keys = [wk, ...highKeys, ...lowKeys];
    // The script folds eligible buckets into the work hash (or no-ops on a resume);
    // we then read the hash back through the typed `hgetallBuffer`. A concurrent
    // revert deleting the work key between the two just yields empty evidence — the
    // occurrence's Postgres CAS would fail on the bumped epoch regardless.
    await this.redis.eval(
      ROTATE_LUA,
      keys.length,
      ...keys,
      String(highKeys.length),
      String(opts.minSamples),
      String(opts.workTtlSeconds),
    );
    const work = await this.redis.hgetallBuffer(wk);
    return {
      high: aggregateFromWork(work['hc'], work['hs']),
      low: aggregateFromWork(work['lc'], work['ls']),
    };
  }

  async stage(
    hmac: string,
    occurrenceId: string,
    state: LearnedState,
    ttlSeconds: number,
  ): Promise<void> {
    positiveTtl(ttlSeconds, 'stage ttlSeconds');
    await this.redis.eval(
      STAGE_LUA,
      1,
      stageKey(hmac, occurrenceId),
      String(state.epoch),
      String(state.generation),
      state.revision,
      packVector(state.centroids.high),
      packVector(state.centroids.low),
      String(ttlSeconds),
    );
  }

  async promote(
    hmac: string,
    occurrenceId: string,
    expected: { epoch: number; generation: number },
    activeTtlSeconds: number,
  ): Promise<boolean> {
    positiveTtl(activeTtlSeconds, 'promote activeTtlSeconds');
    const res = await this.redis.eval(
      PROMOTE_LUA,
      3,
      stageKey(hmac, occurrenceId),
      activeKey(hmac),
      workKey(hmac, occurrenceId),
      String(expected.epoch),
      String(expected.generation),
      String(activeTtlSeconds),
    );
    return asInt(res) === 1;
  }

  async readActive(hmac: string, gate: GenerationGate): Promise<SemanticCentroids | null> {
    const [e, g, r, h, l] = await this.redis.hmgetBuffer(activeKey(hmac), 'e', 'g', 'r', 'h', 'l');
    // A Buffer is always truthy (even empty), so `!x` rejects only a missing field.
    if (!e || !g || !r || !h || !l) return null;
    if (e.toString() !== String(gate.epoch)) return null;
    if (g.toString() !== String(gate.generation)) return null;
    if (r.toString() !== gate.revision) return null;
    const high = unpackVector(h);
    const low = unpackVector(l);
    if (high === null || low === null) return null;
    return { high, low };
  }

  async pendingCounts(
    hmac: string,
    epoch: number,
    revision: string,
  ): Promise<{ high: number; low: number }> {
    const countLabel = async (label: LearningLabel): Promise<number> => {
      const prefix = pendingBucketKey(hmac, epoch, label, revision, '');
      let total = 0;
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 256);
        cursor = next;
        for (const k of keys) {
          const buf = await this.redis.getBuffer(k);
          if (buf === null) continue;
          const nl = buf.indexOf(0x0a); // the count is ASCII digits before the 0x0A separator
          if (nl <= 0) continue;
          const c = Number(buf.subarray(0, nl).toString());
          if (Number.isFinite(c)) total += c;
        }
      } while (cursor !== '0');
      return total;
    };
    return { high: await countLabel('high'), low: await countLabel('low') };
  }

  async discardStaleRevisions(
    hmac: string,
    epoch: number,
    currentRevision: string,
  ): Promise<{ pendingDiscarded: number; activeDiscarded: boolean }> {
    // A pending bucket is `sem:{hmac}:pending:<epoch>:<label>:<revision>:<day>`.
    // Scope the scan to the CURRENT epoch, and keep only keys under the two
    // current-revision label prefixes; everything else (this epoch) is stale.
    const keep = [
      `${pendingBucketKey(hmac, epoch, 'high', currentRevision, '')}`,
      `${pendingBucketKey(hmac, epoch, 'low', currentRevision, '')}`,
    ];
    let pendingDiscarded = 0;
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        `sem:{${hmac}}:pending:${String(epoch)}:*`,
        'COUNT',
        256,
      );
      cursor = next;
      const stale = keys.filter((k) => !keep.some((p) => k.startsWith(p)));
      if (stale.length > 0) {
        await this.redis.del(...stale);
        pendingDiscarded += stale.length;
      }
    } while (cursor !== '0');

    const activeRevision = await this.redis.hget(activeKey(hmac), 'r');
    let activeDiscarded = false;
    if (activeRevision !== null && activeRevision !== currentRevision) {
      await this.redis.del(activeKey(hmac));
      activeDiscarded = true;
    }
    return { pendingDiscarded, activeDiscarded };
  }

  async deleteTenant(hmac: string): Promise<void> {
    const match = `sem:{${hmac}}:*`;
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', match, 'COUNT', 256);
      cursor = next;
      if (keys.length > 0) await this.redis.del(...keys);
    } while (cursor !== '0');
  }
}
