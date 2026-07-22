import { and, gte, lt, sql } from 'drizzle-orm';
import { requestAttempts, requestLogs } from '@polyrouter/shared/server';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { microsSum, microsSumIf } from './cost-sql';

/** DI token for the weekly-spend reader (a narrow, scheduler-only capability). */
export const WEEKLY_SPEND_READER = 'polyrouter:weekly-spend-reader';

export interface WeeklySpendReader {
  /**
   * System-level per-owner spend over the half-open interval `[start, endExclusive)`.
   * Sums BOTH cost ledgers — `request_log.cost` + cascade `request_attempt.cost`
   * (#14), null → 0 (known spend). Cross-owner by construction; the caller (the
   * scheduler) emits each owner only their own row. **Not** a request-handler
   * accessor — never call it from a per-request path.
   */
  weeklySpendByOwner(
    start: Date,
    endExclusive: Date,
  ): Promise<{ ownerUserId: string; total: number; estimatedSpend: number }[]>;
}

/** Built inside DatabaseModule (which alone holds the private drizzle handle);
 * only the `WEEKLY_SPEND_READER` token is exported, never the raw handle. */
export function buildWeeklySpendReader(db: NodePgDatabase): WeeklySpendReader {
  return {
    async weeklySpendByOwner(start, endExclusive) {
      // Aggregate in integer micro-dollars (`Σ round(cost × 1e6)` per row) — the
      // identical arithmetic the budget and analytics readers use — then convert to
      // dollars once, so this summary reconciles exactly with those figures instead
      // of drifting at the sub-µ$ margin a raw float `sum(cost)` would introduce (A-15).
      // Estimate-priced spend — native-family OR listed (record-listed-price-
      // fallback) — so the weekly summary's estimate caveat covers both.
      const estimatedPredicate = sql`${requestLogs.priceSource} in ('native_family', 'listed')`;
      const estimatedAttemptPredicate = sql`${requestAttempts.priceSource} in ('native_family', 'listed')`;
      const logs = await db
        .select({
          ownerUserId: requestLogs.ownerUserId,
          micros: microsSum(requestLogs.cost),
          estimatedMicros: microsSumIf(requestLogs.cost, estimatedPredicate),
        })
        .from(requestLogs)
        .where(and(gte(requestLogs.createdAt, start), lt(requestLogs.createdAt, endExclusive)))
        .groupBy(requestLogs.ownerUserId);
      const attempts = await db
        .select({
          ownerUserId: requestAttempts.ownerUserId,
          micros: microsSum(requestAttempts.cost),
          estimatedMicros: microsSumIf(requestAttempts.cost, estimatedAttemptPredicate),
        })
        .from(requestAttempts)
        .where(
          and(gte(requestAttempts.createdAt, start), lt(requestAttempts.createdAt, endExclusive)),
        )
        .groupBy(requestAttempts.ownerUserId);

      const microsByOwner = new Map<string, { micros: number; estimated: number }>();
      const bump = (owner: string, micros: number, estimated: number): void => {
        const cur = microsByOwner.get(owner) ?? { micros: 0, estimated: 0 };
        microsByOwner.set(owner, {
          micros: cur.micros + micros,
          estimated: cur.estimated + estimated,
        });
      };
      for (const r of logs) bump(r.ownerUserId, Number(r.micros), Number(r.estimatedMicros));
      for (const r of attempts) bump(r.ownerUserId, Number(r.micros), Number(r.estimatedMicros));
      return [...microsByOwner].map(([ownerUserId, v]) => ({
        ownerUserId,
        total: v.micros / 1_000_000,
        estimatedSpend: v.estimated / 1_000_000,
      }));
    },
  };
}
