import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { validateCentroids, type SemanticCentroids } from '@polyrouter/data-plane';
import type { Principal } from '@polyrouter/shared/server';
import {
  type ClassificationSourceProvider,
  type ClassificationState,
  type LearningGate,
} from './classification-source';
import { tenantHmac } from './learning-format';
import type { LearningStore } from './learning-store';
import { SemanticClassifierService } from './semantic-classifier.service';

/**
 * Learned-supersedes-bundled classification source (add-semantic-learning D4,
 * clink r1 High-2). Bound INSIDE the semantic module rebinding
 * `CLASSIFICATION_SOURCE` (a sibling module can't override the intra-module
 * token). It layers per-tenant LEARNED centroids over the classifier's bundled
 * ones — but ONLY when every read-time gate holds (learning on ∧ the stored
 * state's `(epoch, generation, revision)` matches the decision-time gate ∧ both
 * labels validate) — and falls back to BUNDLED on ANY gate failure, Redis fault,
 * staleness, or missing/invalid state. It NEVER returns the router's skip path:
 * a Redis outage disables only LEARNING, never classification (invariant 1).
 *
 * Reads go through a capped LRU keyed `(tenantHmac, epoch, generation, revision)`;
 * a cold miss reads Redis under a bounded deadline. Every cached/loaded vector is
 * validated before publication. The `store` is injected on a dedicated fail-fast
 * connection (the module factory), so a down Redis never stalls the hot path.
 */

interface CachedLearned {
  readonly centroids: SemanticCentroids;
  /** Wall-clock ms after which the entry is re-read from Redis (clink impl
   * High-2): the LRU must not serve a learned state past the active key's real
   * TTL, so a dormant tenant re-validates at least this often. */
  readonly expiresAt: number;
}

const MAX_LRU_ENTRIES = 4_096;
/** Re-validation interval — a learned entry older than this is re-read from Redis
 * (which reflects the active key's true expiry / any revert). Small enough that a
 * dormant tenant stops serving learned within it of the active key expiring. */
const CACHE_TTL_MS = 60_000;

@Injectable()
export class LearnedClassificationSource
  implements ClassificationSourceProvider, OnApplicationShutdown
{
  private readonly cache = new Map<string, CachedLearned>(); // key -> learned (Map order = LRU)

  constructor(
    private readonly store: LearningStore,
    private readonly tenantKey: Buffer,
    private readonly classifier: SemanticClassifierService,
    private readonly deadlineMs: number,
    private readonly disposeStore: () => void = () => {},
    private readonly now: () => number = () => Date.now(),
  ) {}

  async resolve(principal: Principal, gate: LearningGate): Promise<ClassificationState> {
    const bundled = this.classifier.bundledState();
    if (bundled === null) throw new Error('semantic classifier not ready');
    if (!gate.enabled) return bundled;

    try {
      const learned = await this.readLearned(principal, gate, bundled.centroids.high.length);
      if (learned !== null) {
        const revision =
          this.classifier.learnedRevision(gate.epoch, gate.generation) ?? bundled.revision;
        return { centroids: learned.centroids, source: 'learned', revision };
      }
    } catch {
      // Redis fault, deadline, or a validation throw — fall to bundled.
    }
    return bundled;
  }

  onApplicationShutdown(): void {
    this.cache.clear();
    this.disposeStore();
  }

  // --- internals ---

  private async readLearned(
    principal: Principal,
    gate: LearningGate,
    dims: number,
  ): Promise<CachedLearned | null> {
    const tenantId = principal.kind === 'user' ? principal.userId : principal.orgId;
    const hmac = tenantHmac(this.tenantKey, tenantId);
    const key = `${hmac}|${String(gate.epoch)}|${String(gate.generation)}|${gate.evidenceRevision}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      if (this.now() <= hit.expiresAt) {
        this.cache.delete(key);
        this.cache.set(key, hit); // LRU touch
        return hit;
      }
      this.cache.delete(key); // expired — fall through to a fresh Redis read
    }
    const centroids = await this.withDeadline(
      this.store.readActive(hmac, {
        epoch: gate.epoch,
        generation: gate.generation,
        revision: gate.evidenceRevision,
      }),
    );
    if (centroids === null) return null;
    validateCentroids(centroids, dims); // throws on a broken loaded state → caller falls to bundled
    const entry: CachedLearned = { centroids, expiresAt: this.now() + CACHE_TTL_MS };
    this.setCache(key, entry);
    return entry;
  }

  private setCache(key: string, entry: CachedLearned): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    if (this.cache.size > MAX_LRU_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  private withDeadline<T>(p: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('learned-read deadline')), this.deadlineMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    // Clear the timer on EITHER outcome so a fast Redis read never leaves a live
    // timer per cold miss (clink impl Low-7).
    return Promise.race([p, deadline]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }
}
