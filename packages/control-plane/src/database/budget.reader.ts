import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { budgets, requestAttempts, requestLogs, type BudgetRow } from '@polyrouter/shared/server';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { microsSum, microsSumIf } from './cost-sql';

/** DI token for the budget reconcile reader (a narrow, scheduler-only capability). */
export const BUDGET_READER = 'polyrouter:budget-reader';

export interface BudgetReader {
  /** Every enabled budget across all owners (the reconcile work-list). */
  listActiveBudgets(): Promise<BudgetRow[]>;
  /**
   * One owner's spend over `[start, endExclusive)` as integer micro-dollars,
   * summing BOTH ledgers — `request_log.cost` + cascade `request_attempt.cost`
   * (#14). Each ledger is filtered by its OWN `created_at` + `owner_user_id`; for
   * an agent-scoped budget (`agentId` non-null), `request_log` is filtered by its
   * `agent_id`, and `request_attempt` (which has no `agent_id`) is joined to its
   * parent `request_log` solely to read that `agent_id`. Cross-owner by
   * construction — a scheduler-only reader, never a request-handler accessor.
   */
  spendMicrosFor(
    ownerUserId: string,
    agentId: string | null,
    start: Date,
    endExclusive: Date,
  ): Promise<{ micros: number; estimatedMicros: number }>;
}

/** Built inside DatabaseModule (which alone holds the private drizzle handle);
 * only the `BUDGET_READER` token is exported, never the raw handle. */
export function buildBudgetReader(db: NodePgDatabase): BudgetReader {
  return {
    async listActiveBudgets() {
      return db.select().from(budgets).where(eq(budgets.enabled, true));
    },
    async spendMicrosFor(ownerUserId, agentId, start, endExclusive) {
      const logWhere = [
        eq(requestLogs.ownerUserId, ownerUserId),
        gte(requestLogs.createdAt, start),
        lt(requestLogs.createdAt, endExclusive),
        ...(agentId !== null ? [eq(requestLogs.agentId, agentId)] : []),
      ];
      // Estimate-priced spend — native-family OR listed (record-listed-price-
      // fallback), both non-authoritative — so a budget alert's provenance caveat
      // covers either.
      const estimatedLog = sql`${requestLogs.priceSource} in ('native_family', 'listed')`;
      const logs = await db
        .select({
          total: microsSum(requestLogs.cost),
          estimated: microsSumIf(requestLogs.cost, estimatedLog),
        })
        .from(requestLogs)
        .where(and(...logWhere));

      const attemptWhere = [
        eq(requestAttempts.ownerUserId, ownerUserId),
        gte(requestAttempts.createdAt, start),
        lt(requestAttempts.createdAt, endExclusive),
      ];
      const estimatedAttempt = sql`${requestAttempts.priceSource} in ('native_family', 'listed')`;
      const attemptQuery =
        agentId !== null
          ? db
              .select({
                total: microsSum(requestAttempts.cost),
                estimated: microsSumIf(requestAttempts.cost, estimatedAttempt),
              })
              .from(requestAttempts)
              .innerJoin(requestLogs, eq(requestAttempts.requestLogId, requestLogs.id))
              .where(and(...attemptWhere, eq(requestLogs.agentId, agentId)))
          : db
              .select({
                total: microsSum(requestAttempts.cost),
                estimated: microsSumIf(requestAttempts.cost, estimatedAttempt),
              })
              .from(requestAttempts)
              .where(and(...attemptWhere));
      const attempts = await attemptQuery;

      return {
        micros: Number(logs[0]?.total ?? 0) + Number(attempts[0]?.total ?? 0),
        estimatedMicros: Number(logs[0]?.estimated ?? 0) + Number(attempts[0]?.estimated ?? 0),
      };
    },
  };
}
