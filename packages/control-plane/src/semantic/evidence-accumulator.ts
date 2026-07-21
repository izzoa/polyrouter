import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import {
  ADD_PENDING_LUA,
  dayStamp,
  deriveTenantHmacKey,
  packVector,
  pendingBucketKey,
  tenantHmac,
  type LearningLabel,
} from './learning-format';

/**
 * The evidence accumulator (add-semantic-learning D2, clink r1 High-1). A
 * count-1 pending sum IS a raw embedding, so it may never be persisted to
 * Redis; but a bounded, expiring in-process accumulator is not "persistence"
 * (no more than the request buffer is). Partial per-`(tenantHmac, label,
 * revision)` cohorts live here under HARD global caps; only a cohort of ≥
 * `minCohort` embeddings is ever flushed — so the first value that lands in
 * Redis is a sum of ≥ 2 embeddings, never one.
 *
 * Mirrors `StructuralBaselineStore`'s posture: a dedicated
 * `enableOfflineQueue:false` connection (a down Redis rejects at once), bounded
 * transient state (drop-BEFORE-allocation admission), best-effort background
 * flush, zeroed buffers on flush/evict, bounded in-flight, and no flush below
 * cohort size — a crash discards unflushed cohorts (loss OK, disclosure never).
 *
 * The Redis-side format (key layout, tenant digest, packed-sum encoding, the
 * add-sum Lua) is the SHARED contract in `./learning-format` — the learning
 * store's rotate reads exactly what this writes, so both import that one module.
 */

const COHORT_MAX_AGE_MS = 10 * 60_000; // a partial cohort older than this is dropped
const MAX_IN_FLIGHT = 32;

interface Cohort {
  sum: Float32Array;
  count: number;
  firstSeen: number;
}

@Injectable()
export class EvidenceAccumulator implements OnApplicationShutdown {
  private readonly tenantKey: Buffer;
  private readonly redis: Redis;
  private readonly cohorts = new Map<string, Cohort>(); // ck -> partial cohort
  private inFlight = 0;
  private shuttingDown = false;
  /** Injected clock for deterministic tests; defaults to Date.now. */
  private readonly now: () => number;

  constructor(shared: Redis, apiKeyHmacSecret: string, now: () => number = () => Date.now()) {
    this.tenantKey = deriveTenantHmacKey(apiKeyHmacSecret);
    this.redis = shared.duplicate({ enableOfflineQueue: false, maxRetriesPerRequest: 1 });
    this.redis.on('error', () => {});
    if (this.redis.status === 'wait') void this.redis.connect().catch(() => {});
    this.now = now;
  }

  /** Domain-separated tenant digest — NOT the raw tenant id (clink r1 Low-1). */
  tenantHmac(tenantId: string): string {
    return tenantHmac(this.tenantKey, tenantId);
  }

  /**
   * Contribute one request's embedding to a cohort. When the cohort reaches
   * `minCohort`, it flushes (detached + zeroed) to the current fixed-window
   * daily Redis bucket. Bounded: a new cohort at the global cap is REFUSED
   * before allocation (a flood never grows memory). Never throws, never awaits.
   */
  contribute(
    tenantHmac: string,
    epoch: number,
    label: LearningLabel,
    revision: string,
    vector: Float32Array,
    opts: { minCohort: number; maxCohorts: number; ttlSeconds: number },
  ): void {
    if (this.shuttingDown) return;
    this.evictAged();
    // Cohorts + pending buckets are epoch-namespaced (clink impl High-3): a
    // pre-revert request's evidence lands under its decision-time epoch, inert to
    // the post-revert sweep.
    const ck = `${tenantHmac}|${String(epoch)}|${label}|${revision}`;
    let cohort = this.cohorts.get(ck);
    if (cohort === undefined) {
      if (this.cohorts.size >= opts.maxCohorts) return; // admit before allocating
      cohort = { sum: new Float32Array(vector.length), count: 0, firstSeen: this.now() };
      this.cohorts.set(ck, cohort);
    }
    if (cohort.sum.length !== vector.length) return; // dim change mid-cohort — ignore
    for (let i = 0; i < vector.length; i += 1)
      cohort.sum[i] = (cohort.sum[i] ?? 0) + (vector[i] ?? 0);
    cohort.count += 1;
    if (cohort.count >= opts.minCohort) {
      this.cohorts.delete(ck);
      this.flush(tenantHmac, epoch, label, revision, cohort, opts.ttlSeconds);
    }
  }

  /** Force-flush nothing below cohort size; used only in tests to observe state. */
  get cohortCount(): number {
    return this.cohorts.size;
  }

  onApplicationShutdown(): void {
    this.shuttingDown = true;
    // Discard unflushed cohorts (never flush below cohort size); zero them.
    for (const c of this.cohorts.values()) c.sum.fill(0);
    this.cohorts.clear();
    try {
      this.redis.disconnect();
    } catch {
      /* already closed */
    }
  }

  // --- internals ---

  private evictAged(): void {
    const cutoff = this.now() - COHORT_MAX_AGE_MS;
    for (const [ck, c] of this.cohorts) {
      if (c.firstSeen < cutoff) {
        c.sum.fill(0); // zero the raw material before dropping
        this.cohorts.delete(ck);
      }
    }
  }

  /** One fire-and-forget, bounded-in-flight Redis add; zero the buffer after. */
  private flush(
    tenantHmac: string,
    epoch: number,
    label: LearningLabel,
    revision: string,
    cohort: Cohort,
    ttlSeconds: number,
  ): void {
    if (this.inFlight >= MAX_IN_FLIGHT) {
      cohort.sum.fill(0);
      return;
    }
    const dims = cohort.sum.length;
    const packed = packVector(cohort.sum);
    const key = pendingBucketKey(tenantHmac, epoch, label, revision, dayStamp(this.now()));
    this.inFlight += 1;
    void this.redis
      .eval(ADD_PENDING_LUA, 1, key, String(cohort.count), packed, String(dims), String(ttlSeconds))
      .catch(() => {})
      .finally(() => {
        this.inFlight -= 1;
        cohort.sum.fill(0); // zero the raw material once the flush is done
      });
  }
}
