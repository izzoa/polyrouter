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
  private readonly inflight = new Map<string, Promise<BudgetRow[]>>();

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
    const existing = this.inflight.get(owner);
    if (existing !== undefined) return existing;

    const load = this.db.budgets
      .list(principal)
      .then(
        (rows) => {
          this.store(owner, rows);
          return rows;
        },
        (err: unknown) => {
          if (hit !== undefined) return hit.rows; // serve stale on a refresh error
          throw err; // cold miss → propagate; checkBlocked applies the fail mode
        },
      )
      .finally(() => {
        this.inflight.delete(owner);
      });
    this.inflight.set(owner, load);
    return load;
  }

  invalidate(principal: Principal): void {
    this.cache.delete(ownerOf(principal));
  }

  private store(owner: string, rows: BudgetRow[]): void {
    this.cache.delete(owner);
    this.cache.set(owner, { at: Date.now(), rows });
    if (this.cache.size > this.max) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }
}
