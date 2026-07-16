import { loadConfig, registerConfig, z } from '@polyrouter/shared';

/** Spend-limits config (#16, spec §10). The block-check Redis read is bounded by
 * `BUDGET_REDIS_TIMEOUT_MS`; the owner's budgets are cached in-process for
 * `BUDGET_CACHE_TTL_MS` (capped at `BUDGET_CACHE_MAX` owners) so the hot path is
 * DB-free. `BUDGET_FAIL_OPEN` is the named fail-mode contract (default open →
 * allow on a Redis/enforcement fault, favoring availability). The reconcile
 * scheduler is the sole counter writer: `BUDGET_SCHED_ENABLED` (default on — it
 * IS the enforcement engine) runs `BUDGET_SCHED_CRON`; a reconciliation heartbeat
 * older than `BUDGET_STALE_MS` means counters are untrustworthy and the block
 * check routes through the fail mode (a stopped scheduler must not read as 0 and
 * silently allow). */
registerConfig(
  'budgets',
  z.object({
    BUDGET_REDIS_TIMEOUT_MS: z.coerce.number().int().min(1).default(50),
    BUDGET_CACHE_TTL_MS: z.coerce.number().int().min(0).default(10_000),
    BUDGET_CACHE_MAX: z.coerce.number().int().min(1).default(5_000),
    BUDGET_FAIL_OPEN: z
      .string()
      .optional()
      .transform((v) => v !== 'false'), // default true
    BUDGET_SCHED_ENABLED: z
      .string()
      .optional()
      .transform((v) => v !== 'false'), // default true
    BUDGET_SCHED_CRON: z.string().default('* * * * *'),
    BUDGET_STALE_MS: z.coerce.number().int().min(1000).default(180_000),
  }),
);

export const BUDGETS_CONFIG = 'polyrouter:budgets-config';

export type BudgetsRawConfig = {
  BUDGET_REDIS_TIMEOUT_MS: number;
  BUDGET_CACHE_TTL_MS: number;
  BUDGET_CACHE_MAX: number;
  BUDGET_FAIL_OPEN: boolean;
  BUDGET_SCHED_ENABLED: boolean;
  BUDGET_SCHED_CRON: string;
  BUDGET_STALE_MS: number;
};

/** The resolved config the budget subsystem depends on. */
export interface BudgetsConfig {
  readonly redisTimeoutMs: number;
  readonly cacheTtlMs: number;
  readonly cacheMax: number;
  readonly failOpen: boolean;
  readonly schedEnabled: boolean;
  readonly schedCron: string;
  readonly staleMs: number;
}

export function resolveBudgetsConfig(): BudgetsConfig {
  const all = loadConfig<BudgetsRawConfig>();
  return {
    redisTimeoutMs: all.BUDGET_REDIS_TIMEOUT_MS,
    cacheTtlMs: all.BUDGET_CACHE_TTL_MS,
    cacheMax: all.BUDGET_CACHE_MAX,
    failOpen: all.BUDGET_FAIL_OPEN,
    schedEnabled: all.BUDGET_SCHED_ENABLED,
    schedCron: all.BUDGET_SCHED_CRON,
    staleMs: all.BUDGET_STALE_MS,
  };
}
