import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { budgets, requestAttempts, requestLogs, type BudgetRow } from '@polyrouter/shared/server';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { isCashLike, microsSum, microsSumIf, subscriptionMicrosSum } from './cost-sql';

/** What a budget meters (split-subscription-spend). `cash` counts money owed — the
 * cash + unknown components; `notional` additionally counts subscription traffic priced
 * at the vendor's API rate. Existing budgets are `notional` so upgrading changes nobody's
 * enforcement; new budgets default to `cash`. */
export type MeteringBasis = 'cash' | 'notional';

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
    basis: MeteringBasis,
  ): Promise<{ micros: number; estimatedMicros: number; subscriptionMicros: number }>;
}

/** Built inside DatabaseModule (which alone holds the private drizzle handle);
 * only the `BUDGET_READER` token is exported, never the raw handle. */
export function buildBudgetReader(db: NodePgDatabase): BudgetReader {
  return {
    async listActiveBudgets() {
      return db.select().from(budgets).where(eq(budgets.enabled, true));
    },
    async spendMicrosFor(ownerUserId, agentId, start, endExclusive, basis) {
      // `notional` meters everything (today's behaviour); `cash` drops the prepaid
      // subscription component. Unknown rows are metered under BOTH — a row we cannot
      // classify keeps its prior treatment rather than silently loosening a budget.
      const metered = (kindCol: Parameters<typeof isCashLike>[0]): ReturnType<typeof isCashLike> | null =>
        basis === 'notional' ? null : isCashLike(kindCol);
      const logWhere = [
        eq(requestLogs.ownerUserId, ownerUserId),
        gte(requestLogs.createdAt, start),
        lt(requestLogs.createdAt, endExclusive),
        ...(agentId !== null ? [eq(requestLogs.agentId, agentId)] : []),
      ];
      // Estimate-priced spend — native-family OR listed (record-listed-price-
      // fallback), both non-authoritative — so a budget alert's provenance caveat
      // covers either.
      // Estimate provenance is ORTHOGONAL to the component and follows the BASIS: it
      // must describe whatever this budget actually meters, not the cash subset. A
      // native-priced subscription row metered by a `notional` budget, or an estimated
      // unclassified row metered by either, belongs in this figure — otherwise the
      // alert's `spendEstimated` flag would render an estimated total as exact.
      const meteredLog = metered(requestLogs.providerKind);
      const estimatedLogBase = sql`${requestLogs.priceSource} in ('native_family', 'listed')`;
      const estimatedLog =
        meteredLog === null ? estimatedLogBase : sql`${estimatedLogBase} and ${meteredLog}`;
      const logs = await db
        .select({
          total:
            meteredLog === null
              ? microsSum(requestLogs.cost)
              : microsSumIf(requestLogs.cost, meteredLog),
          estimated: microsSumIf(requestLogs.cost, estimatedLog),
          subscription: subscriptionMicrosSum(requestLogs.cost, requestLogs.providerKind),
        })
        .from(requestLogs)
        .where(and(...logWhere));

      const attemptWhere = [
        eq(requestAttempts.ownerUserId, ownerUserId),
        gte(requestAttempts.createdAt, start),
        lt(requestAttempts.createdAt, endExclusive),
      ];
      const meteredAttempt = metered(requestAttempts.providerKind);
      const estimatedAttemptBase = sql`${requestAttempts.priceSource} in ('native_family', 'listed')`;
      const estimatedAttempt =
        meteredAttempt === null
          ? estimatedAttemptBase
          : sql`${estimatedAttemptBase} and ${meteredAttempt}`;
      const attemptTotal =
        meteredAttempt === null
          ? microsSum(requestAttempts.cost)
          : microsSumIf(requestAttempts.cost, meteredAttempt);
      const attemptSubscription = subscriptionMicrosSum(
        requestAttempts.cost,
        requestAttempts.providerKind,
      );
      const attemptQuery =
        agentId !== null
          ? db
              .select({
                total: attemptTotal,
                estimated: microsSumIf(requestAttempts.cost, estimatedAttempt),
                subscription: attemptSubscription,
              })
              .from(requestAttempts)
              .innerJoin(requestLogs, eq(requestAttempts.requestLogId, requestLogs.id))
              .where(and(...attemptWhere, eq(requestLogs.agentId, agentId)))
          : db
              .select({
                total: attemptTotal,
                estimated: microsSumIf(requestAttempts.cost, estimatedAttempt),
                subscription: attemptSubscription,
              })
              .from(requestAttempts)
              .where(and(...attemptWhere));
      const attempts = await attemptQuery;

      return {
        micros: Number(logs[0]?.total ?? 0) + Number(attempts[0]?.total ?? 0),
        estimatedMicros: Number(logs[0]?.estimated ?? 0) + Number(attempts[0]?.estimated ?? 0),
        subscriptionMicros:
          Number(logs[0]?.subscription ?? 0) + Number(attempts[0]?.subscription ?? 0),
      };
    },
  };
}
