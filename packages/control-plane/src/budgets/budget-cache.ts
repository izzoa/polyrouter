import { Inject, Injectable } from '@nestjs/common';
import {
  PERSISTENCE_PORT,
  type BudgetRow,
  type PersistencePort,
  type Principal,
} from '@polyrouter/shared/server';
import { BUDGETS_CONFIG, type BudgetsConfig } from './budgets.config';

function ownerOf(principal: Principal): string {
  return principal.kind === 'user' ? principal.userId : principal.orgId;
}

interface Entry {
  at: number;
  rows: BudgetRow[];
}

/**
 * A short-TTL, capped, single-flight per-owner cache of the owner's budgets so
 * the proxy block check is DB-free on the hot path. Fresh within
 * `BUDGET_CACHE_TTL_MS`; capped at `BUDGET_CACHE_MAX` owners (LRU eviction);
 * concurrent misses for one owner share a single in-flight load. On a refresh
 * error a still-present (stale) entry is served; a cold-miss error propagates so
 * the caller applies the named fail mode. CRUD `invalidate`s on every write.
 */
@Injectable()
export class BudgetCache {
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly cache = new Map<string, Entry>(); // owner -> entry (Map order = LRU)
  private readonly inflight = new Map<string, { gen: number; rows: Promise<BudgetRow[]> }>();
  /** Per-owner load generation. `invalidate()` bumps it; a `store()` from an older
   * generation is dropped (split-subscription-spend). Without this, a load already in
   * flight when a write lands would `store()` the PRE-write rows afterwards and serve
   * them for a full TTL — which for a metering-basis change means the budget keeps
   * building its old basis key, and keeps blocking, until the entry expires. */
  private readonly generation = new Map<string, number>();

  constructor(
    @Inject(PERSISTENCE_PORT) private readonly db: PersistencePort,
    @Inject(BUDGETS_CONFIG) cfg: BudgetsConfig,
  ) {
    this.ttlMs = cfg.cacheTtlMs;
    this.max = cfg.cacheMax;
  }

  async get(principal: Principal): Promise<BudgetRow[]> {
    const owner = ownerOf(principal);
    const hit = this.cache.get(owner);
    if (hit !== undefined && Date.now() - hit.at < this.ttlMs) {
      this.cache.delete(owner);
      this.cache.set(owner, hit); // LRU touch
      return hit.rows;
    }
    const gen = this.generation.get(owner) ?? 0;
    const existing = this.inflight.get(owner);
    // Join only a load from the CURRENT generation. Refusing to cache a superseded
    // load is not enough on its own — a caller arriving after `invalidate()` would
    // still be handed the pre-write rows directly by joining the old promise.
    if (existing !== undefined && existing.gen === gen) return existing.rows;
    const load = this.db.budgets
      .list(principal)
      .then(
        (rows) => {
          this.store(owner, rows, gen);
          return rows;
        },
        (err: unknown) => {
          if (hit !== undefined) return hit.rows; // serve stale on a refresh error
          throw err; // cold miss → propagate; checkBlocked applies the fail mode
        },
      )
      .finally(() => {
        // Only clear our OWN entry — a newer generation's load must survive.
        if (this.inflight.get(owner)?.gen === gen) this.inflight.delete(owner);
      });
    this.inflight.set(owner, { gen, rows: load });
    return load;
  }

  invalidate(principal: Principal): void {
    const owner = ownerOf(principal);
    this.cache.delete(owner);
    // Also invalidate loads already in flight: they read state older than this write.
    this.generation.set(owner, (this.generation.get(owner) ?? 0) + 1);
  }

  private store(owner: string, rows: BudgetRow[], gen: number): void {
    // Superseded by a write that landed while this load was in flight — the rows are
    // already stale, so caching them would undo the invalidation.
    if ((this.generation.get(owner) ?? 0) !== gen) return;
    this.cache.delete(owner);
    this.cache.set(owner, { at: Date.now(), rows });
    if (this.cache.size > this.max) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }
}
