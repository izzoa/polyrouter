import { loadConfig, registerConfig, z } from '@polyrouter/shared';
import { parseExpression } from 'cron-parser';

/** `BUDGET_STALE_MS` must clear at least this many reconcile periods — one full
 * period of margin so a single missed run doesn't expire the heartbeat and flip a
 * healthy scheduler into the fail mode. */
const STALE_SAFETY_FACTOR = 2;

/** How many consecutive fires to walk when checking gaps. We sample ACTUAL fire times
 * (not cron fields) so every expression form — ranges, `L`/`W`/`#`, 5- or 6-field — is
 * handled by its real schedule, with no field-semantics edge cases. Fail-fast means a
 * misconfiguration trips on its first over-threshold gap (a few fires); only a healthy
 * schedule walks the whole window. 1024 fires spans ~17h for a per-minute cron and
 * weeks for an hourly one — enough to surface realistic overnight/weekend/month-boundary
 * gaps for sensible reconcile schedules.
 *
 * KNOWN BEST-EFFORT LIMIT: a schedule that BOTH fires sub-hourly AND restricts hours or
 * days (e.g. `* * * * 1-5`) can hide its long gap past this window and false-PASS. Such a
 * schedule is not a sensible budget-reconcile cron (reconciliation should run continuously
 * every day); this check targets the common misconfiguration — a long UNIFORM period paired
 * with a too-short staleness bound — which it catches exactly. */
const GAP_SCAN_SAMPLES = 1_024;

/** Fail-fast at config time when the reconcile scheduler is enabled but the staleness
 * bound is shorter than a safety margin above its fire interval — otherwise a HEALTHY
 * scheduler's heartbeat is always stale and block enforcement silently runs in the fail
 * mode full-time (A-16). A disabled scheduler is exempt (stale-always is intended there,
 * resolved by the fail mode). An invalid cron throws here too (surfaced at boot). */
export function assertStalenessConsistent(cfg: BudgetsConfig, from: Date = new Date()): void {
  if (!cfg.schedEnabled) return;
  // A heartbeat older than staleMs routes enforcement through the fail mode, so any fire
  // gap larger than staleMs / SAFETY_FACTOR leaves too little margin — a single missed run
  // expires the heartbeat. Fail-fast on the first such gap across a bounded window of ACTUAL
  // fires (so all cron forms are handled by their real schedule, no field-semantics edge
  // cases). This catches a long uniform period paired with a too-short bound, plus realistic
  // overnight/weekend/month-boundary gaps (A-16).
  const it = parseExpression(cfg.schedCron, { utc: true, currentDate: from });
  const thresholdMs = cfg.staleMs / STALE_SAFETY_FACTOR;
  let prev = it.next().getTime();
  for (let i = 0; i < GAP_SCAN_SAMPLES; i += 1) {
    const next = it.next().getTime();
    const gap = next - prev;
    if (gap > thresholdMs) {
      throw new Error(
        `BUDGET_STALE_MS (${String(cfg.staleMs)}ms) is too short for BUDGET_SCHED_CRON '${cfg.schedCron}': ` +
          `the schedule has a ${String(gap)}ms gap between fires, which exceeds BUDGET_STALE_MS/` +
          `${String(STALE_SAFETY_FACTOR)} (${String(thresholdMs)}ms) — it leaves less than one reconcile period ` +
          `of margin, so a single missed run expires the heartbeat and block enforcement silently runs in the ` +
          `fail mode. Raise BUDGET_STALE_MS (to at least ${String(gap * STALE_SAFETY_FACTOR)}ms for this cron) ` +
          `or shorten the cron.`,
      );
    }
    prev = next;
  }
}

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
    // Generous bound for the scheduler's reconcile writes (E6.3) — separate from
    // the 50ms hot-path read bound, so a slow-but-healthy Redis still reconciles.
    BUDGET_RECONCILE_TIMEOUT_MS: z.coerce.number().int().min(1).default(2000),
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
  BUDGET_RECONCILE_TIMEOUT_MS: number;
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
  readonly reconcileTimeoutMs: number;
  readonly cacheTtlMs: number;
  readonly cacheMax: number;
  readonly failOpen: boolean;
  readonly schedEnabled: boolean;
  readonly schedCron: string;
  readonly staleMs: number;
}

export function resolveBudgetsConfig(): BudgetsConfig {
  const all = loadConfig<BudgetsRawConfig>();
  const cfg: BudgetsConfig = {
    redisTimeoutMs: all.BUDGET_REDIS_TIMEOUT_MS,
    reconcileTimeoutMs: all.BUDGET_RECONCILE_TIMEOUT_MS,
    cacheTtlMs: all.BUDGET_CACHE_TTL_MS,
    cacheMax: all.BUDGET_CACHE_MAX,
    failOpen: all.BUDGET_FAIL_OPEN,
    schedEnabled: all.BUDGET_SCHED_ENABLED,
    schedCron: all.BUDGET_SCHED_CRON,
    staleMs: all.BUDGET_STALE_MS,
  };
  assertStalenessConsistent(cfg); // boot-time fail-fast on an inconsistent stale/cron pair (A-16)
  return cfg;
}
