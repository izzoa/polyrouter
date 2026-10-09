import {
  BATCH_JOB_TERMINAL_STATUSES,
  validBudgetProgressIds,
  type AvailableBudgetProgress,
  type BudgetProgressResponse,
} from '@polyrouter/shared';
import {
  batchJobs,
  budgets,
  ownershipPredicate,
  requestAttempts,
  requestLogs,
  type BudgetProgressAccessor,
  type BudgetRow,
  type Principal,
} from '@polyrouter/shared/server';
import { and, eq, gte, inArray, isNotNull, lt, notInArray, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import { periodInfo, type BudgetWindow } from '../budgets/period';
import {
  cumulativeProgress,
  progressAllowance,
  progressBucketSeconds,
} from '../budgets/progress-math';
import { isCashLike, microsSum, unknownMicrosSum } from './cost-sql';

export const BUDGET_PROGRESS_WORK_MS = 3000;

/** This read always owns a connection and snapshot. Transaction-bound facilities
 * deliberately cannot nest it inside a caller's writable transaction. */
export function createBudgetProgressAccessor(
  pool?: Pick<Pool, 'connect'>,
  workMs = BUDGET_PROGRESS_WORK_MS,
): BudgetProgressAccessor {
  return {
    async read(principal, ids) {
      if (!validBudgetProgressIds(ids)) throw new Error('invalid budget progress ids');
      if (!pool) throw new Error('budget progress requires its own snapshot');
      let client: PoolClient | undefined;
      let expired = false;
      let released = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = performance.now() + workMs;
      const release = (destroy: boolean): void => {
        if (client && !released) {
          released = true;
          client.release(destroy);
        }
      };
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          // Destroying the checked-out socket rejects an outstanding pg query.
          // LOCAL statement_timeout also bounds server execution after disconnect.
          release(true);
          reject(new Error('budget progress deadline'));
        }, workMs);
      });
      const work = async (): Promise<BudgetProgressResponse> => {
        client = await pool.connect();
        // A queued checkout that arrives after the deadline is returned immediately:
        // it must never start a transaction or leave a leaked connection.
        if (expired) {
          release(true);
          throw new Error('budget progress deadline');
        }
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const db = drizzle(client);
        const bounded = async (): Promise<void> => {
          const remaining = Math.floor(deadline - performance.now());
          if (remaining <= 0 || expired) throw new Error('budget progress deadline');
          await client!.query(`SET LOCAL statement_timeout = ${String(remaining)}`);
          await client!.query(`SET LOCAL lock_timeout = ${String(remaining)}`);
        };
        await bounded();
        const stamp = await client.query<{ as_of: Date }>(
          'SELECT transaction_timestamp() AS as_of',
        );
        const asOf = stamp.rows[0]!.as_of;
        const owned = await db
          .select()
          .from(budgets)
          .where(and(ownershipPredicate(budgets, principal), inArray(budgets.id, [...ids])));
        const byId = new Map(owned.map((b) => [b.id, b]));
        const groups = new Map<string, Awaited<ReturnType<typeof aggregateProgress>>>();
        const results: BudgetProgressResponse['results'] = [];
        for (const id of ids) {
          const budget = byId.get(id);
          if (!budget) {
            results.push({ id, availability: 'not_found' });
            continue;
          }
          const key = JSON.stringify([
            budget.scope,
            budget.agentId,
            budget.window,
            budget.meteringBasis,
          ]);
          let aggregate = groups.get(key);
          if (!aggregate) {
            await bounded();
            aggregate = await aggregateProgress(db, principal, budget, asOf, bounded);
            groups.set(key, aggregate);
          }
          const points = aggregate.points;
          const spent = points[points.length - 1]!.spentMicros;
          results.push({
            id,
            availability: 'available',
            budget: safeProgressBudget(budget),
            ...aggregate,
            ...progressAllowance(
              budget.amount,
              spent,
              aggregate.pendingMicros,
              budget.enabled,
              budget.action,
            ),
          });
        }
        await bounded();
        await client.query('COMMIT');
        return { asOf: asOf.toISOString(), results };
      };
      let failed = true;
      try {
        const result = await Promise.race([work(), timeout]);
        failed = false;
        return result;
      } finally {
        clearTimeout(timer);
        // Any fault destroys the transaction rather than waiting on a rollback.
        release(failed);
      }
    },
  };
}

function safeProgressBudget(b: BudgetRow): AvailableBudgetProgress['budget'] {
  return {
    id: b.id,
    name: b.name,
    scope: b.scope,
    agentId: b.agentId,
    window: b.window,
    action: b.action,
    meteringBasis: b.meteringBasis,
    amount: b.amount,
    enabled: b.enabled,
    createdAt: b.createdAt.toISOString(),
    notifyChannelIds: b.notifyChannelIds?.split(',').filter(Boolean) ?? [],
  };
}

async function aggregateProgress(
  db: NodePgDatabase,
  principal: Principal,
  budget: BudgetRow,
  asOf: Date,
  bounded: () => Promise<void>,
) {
  const period = periodInfo(budget.window as BudgetWindow, asOf);
  const bucketSeconds = progressBucketSeconds(budget.window as BudgetWindow);
  const start = new Date(period.startMs);
  const agent = budget.scope === 'agent' ? budget.agentId : null;
  const fields = (row: {
    createdAt: AnyPgColumn;
    cost: AnyPgColumn;
    providerKind: AnyPgColumn;
    usageEstimated: AnyPgColumn;
    priceSource: AnyPgColumn;
  }) => ({
    bucket: sql<number>`floor(extract(epoch from (${row.createdAt} - ${start.toISOString()}::timestamptz)) / ${bucketSeconds})::int`,
    micros: microsSum(row.cost),
    meteredRows: sql<number>`count(*)::int`,
    unpricedRows: sql<number>`count(*) filter (where ${row.cost} is null)::int`,
    unknownSpendMicros: unknownMicrosSum(row.cost, row.providerKind),
    usageEstimated: sql<boolean>`coalesce(bool_or(${row.usageEstimated}), false)`,
    priceEstimated: sql<boolean>`coalesce(bool_or(${row.priceSource} in ('native_family', 'listed')), false)`,
  });
  const logFields = fields(requestLogs);
  const logs = await db
    .select(logFields)
    .from(requestLogs)
    .where(
      and(
        ownershipPredicate(requestLogs, principal),
        gte(requestLogs.createdAt, start),
        lt(requestLogs.createdAt, asOf),
        agent !== null ? eq(requestLogs.agentId, agent) : undefined,
        budget.meteringBasis === 'cash' ? isCashLike(requestLogs.providerKind) : undefined,
      ),
    )
    .groupBy(sql`1`);
  await bounded();
  const attemptFields = fields(requestAttempts);
  const attemptWhere = and(
    ownershipPredicate(requestAttempts, principal),
    gte(requestAttempts.createdAt, start),
    lt(requestAttempts.createdAt, asOf),
    budget.meteringBasis === 'cash' ? isCashLike(requestAttempts.providerKind) : undefined,
  );
  const attempts =
    agent !== null
      ? await db
          .select(attemptFields)
          .from(requestAttempts)
          .innerJoin(
            requestLogs,
            and(
              eq(requestLogs.id, requestAttempts.requestLogId),
              ownershipPredicate(requestLogs, principal),
            ),
          )
          .where(and(attemptWhere, eq(requestLogs.agentId, agent)))
          .groupBy(sql`1`)
      : await db
          .select(attemptFields)
          .from(requestAttempts)
          .where(attemptWhere)
          .groupBy(sql`1`);
  const sums = new Map<number, number>();
  const provenance: AvailableBudgetProgress['provenance'] = {
    meteredRows: 0,
    unpricedRows: 0,
    unknownSpendMicros: 0,
    usageEstimated: false,
    priceEstimated: false,
  };
  for (const row of [...logs, ...attempts]) {
    sums.set(row.bucket, (sums.get(row.bucket) ?? 0) + Number(row.micros));
    provenance.meteredRows += Number(row.meteredRows);
    provenance.unpricedRows += Number(row.unpricedRows);
    provenance.unknownSpendMicros += Number(row.unknownSpendMicros);
    provenance.usageEstimated ||= row.usageEstimated;
    provenance.priceEstimated ||= row.priceEstimated;
  }
  await bounded();
  const pending = await db
    .select({ micros: sql<number>`coalesce(sum(${batchJobs.reservedCeilingMicros}), 0)` })
    .from(batchJobs)
    .where(
      and(
        ownershipPredicate(batchJobs, principal),
        gte(batchJobs.submittedAt, start),
        lt(batchJobs.submittedAt, asOf),
        notInArray(batchJobs.status, [...BATCH_JOB_TERMINAL_STATUSES]),
        isNotNull(batchJobs.reservedCeilingMicros),
        agent !== null ? eq(batchJobs.agentId, agent) : undefined,
      ),
    );
  return {
    period: {
      id: period.periodId,
      start: start.toISOString(),
      end: new Date(period.endMs).toISOString(),
    },
    bucketSeconds,
    provenance,
    pendingMicros: Number(pending[0]?.micros ?? 0),
    points: cumulativeProgress(period, asOf.getTime(), bucketSeconds, sums),
  };
}
