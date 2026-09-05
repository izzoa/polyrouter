import { and, asc, desc, eq, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { BATCH_JOB_TERMINAL_STATUSES } from '@polyrouter/shared';
import {
  assertUserPrincipal,
  batchJobs,
  ownershipPredicate,
  type BatchJobAccessor,
  type BatchJobRow,
  type BatchJobSystemPatch,
} from '@polyrouter/shared/server';
import { encodeBatchJobsCursor } from './batch-jobs.cursor';
import type { Db } from './database.internal';

/** `status IN (<terminal>)` as one SQL fragment — the listing's first sort key
 * (active first) and the cursor's first component. */
const TERMINAL_LIST = sql.raw(BATCH_JOB_TERMINAL_STATUSES.map((s) => `'${s}'`).join(', '));
const isTerminal = (): SQL<boolean> => sql<boolean>`(${batchJobs.status} IN (${TERMINAL_LIST}))`;
const notTerminal = (): SQL<boolean> =>
  sql<boolean>`(${batchJobs.status} NOT IN (${TERMINAL_LIST}))`;

/** A DateStyle-independent, always-UTC, µs-precision rendering of `submitted_at`
 * so the keyset cursor round-trips at the column's full precision — the same
 * rule as the request listing's cursor (analytics-api). */
const submittedAtText = (): SQL<string> =>
  sql<string>`to_char(${batchJobs.submittedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export { encodeBatchJobsCursor } from './batch-jobs.cursor';

/** The columns a lifecycle patch may touch — enforced at runtime too, so a cast
 * cannot smuggle an identity, route, snapshot, or ceiling column through (D7). */
const PATCHABLE = new Set<keyof BatchJobSystemPatch>([
  'status',
  'upstreamBatchId',
  'completedCount',
  'failedCount',
  'cancelRequested',
  'errorKind',
  'lastPolledAt',
  'stalledSince',
  'resultsExpireAt',
]);

function pickPatch(patch: BatchJobSystemPatch): Partial<typeof batchJobs.$inferInsert> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (PATCHABLE.has(k as keyof BatchJobSystemPatch) && v !== undefined) out[k] = v;
  }
  return out;
}

/** Owner-scoped batch jobs (add-batch-inference; invariant 5). Every read and
 * write carries the ownership predicate; status transitions are compare-and-set. */
export function createBatchJobAccessor(db: Db): BatchJobAccessor {
  return {
    async insert(principal, values) {
      assertUserPrincipal(principal);
      const rows = await db
        .insert(batchJobs)
        .values({
          ...values,
          ownerUserId: principal.userId,
          orgId: null,
          // Forced, not caller-assignable: the D6 order starts every job here.
          status: 'submitting',
          upstreamBatchId: null,
          completedCount: 0,
          failedCount: 0,
          cancelRequested: false,
          settledCostMicros: null,
          terminalAt: null,
          errorKind: null,
        })
        .returning();
      const row = rows[0];
      if (row === undefined) throw new Error('batch_job insert returned no row');
      return row;
    },
    async findById(principal, id) {
      const rows = await db
        .select()
        .from(batchJobs)
        .where(and(eq(batchJobs.id, id), ownershipPredicate(batchJobs, principal)))
        .limit(1);
      return rows[0] ?? null;
    },
    async listActive(principal, opts = {}) {
      const conds: SQL[] = [ownershipPredicate(batchJobs, principal), notTerminal()];
      if (opts.agentId !== undefined) conds.push(eq(batchJobs.agentId, opts.agentId));
      return db
        .select()
        .from(batchJobs)
        .where(and(...conds))
        .orderBy(desc(batchJobs.submittedAt), desc(batchJobs.id));
    },
    async list(principal, query) {
      const conds: SQL[] = [ownershipPredicate(batchJobs, principal)];
      if (query.agentId !== undefined) conds.push(eq(batchJobs.agentId, query.agentId));
      if (query.cursor !== undefined) {
        // Rows AFTER the cursor in (terminal ASC, submitted_at DESC, id DESC) order.
        // Bound as ::timestamptz so Postgres compares at the column's µs precision.
        const ts = query.cursor.submittedAt;
        const olderSameBand = or(
          sql`${batchJobs.submittedAt} < ${ts}::timestamptz`,
          and(
            sql`${batchJobs.submittedAt} = ${ts}::timestamptz`,
            sql`${batchJobs.id} < ${query.cursor.id}`,
          ),
        ) as SQL;
        conds.push(
          query.cursor.terminal
            ? (and(isTerminal(), olderSameBand) as SQL)
            : (or(isTerminal(), and(notTerminal(), olderSameBand)) as SQL),
        );
      }
      const raw = await db
        .select({ row: batchJobs, terminal: isTerminal(), submittedAtText: submittedAtText() })
        .from(batchJobs)
        .where(and(...conds))
        .orderBy(asc(isTerminal()), desc(batchJobs.submittedAt), desc(batchJobs.id))
        .limit(query.limit + 1);
      const hasMore = raw.length > query.limit;
      const page = raw.slice(0, query.limit);
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last
          ? encodeBatchJobsCursor({
              terminal: last.terminal,
              submittedAt: last.submittedAtText,
              id: last.row.id,
            })
          : null;
      return { rows: page.map((r) => r.row), nextCursor };
    },
    async update(principal, id, patch, opts = {}) {
      const conds: SQL[] = [eq(batchJobs.id, id), ownershipPredicate(batchJobs, principal)];
      if (opts.whenStatusIn !== undefined) {
        if (opts.whenStatusIn.length === 0) return null;
        conds.push(inArray(batchJobs.status, [...opts.whenStatusIn]));
      }
      const set = pickPatch(patch);
      const rows = await db
        .update(batchJobs)
        .set({ ...set, updatedAt: new Date() })
        .where(and(...conds))
        .returning();
      return rows[0] ?? null;
    },
    async settle(principal, id, settlement, opts = {}) {
      const allowed = opts.whenStatusIn ?? (['finalizing', 'cancelling'] as const);
      if (allowed.length === 0) return null;
      const rows = await db
        .update(batchJobs)
        .set({
          status: settlement.status,
          completedCount: settlement.completedCount,
          failedCount: settlement.failedCount,
          settledCostMicros: settlement.settledCostMicros,
          terminalAt: settlement.terminalAt,
          errorKind: settlement.errorKind ?? null,
          resultsExpireAt: settlement.resultsExpireAt ?? null,
          stalledSince: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(batchJobs.id, id),
            ownershipPredicate(batchJobs, principal),
            inArray(batchJobs.status, [...allowed]),
            // A settled job is never re-settled: the CAS above already excludes
            // terminal rows; this keeps the intent visible.
            isNull(batchJobs.terminalAt),
          ),
        )
        .returning();
      return rows[0] ?? null;
    },
    async cursorForJob(principal, id) {
      const rows = await db
        .select({ terminal: isTerminal(), submittedAtText: submittedAtText(), id: batchJobs.id })
        .from(batchJobs)
        .where(and(eq(batchJobs.id, id), ownershipPredicate(batchJobs, principal)))
        .limit(1);
      const r = rows[0];
      if (r === undefined) return null;
      return encodeBatchJobsCursor({
        terminal: r.terminal,
        submittedAt: r.submittedAtText,
        id: r.id,
      });
    },
    async discard(principal, id) {
      const rows = await db
        .delete(batchJobs)
        .where(
          and(
            eq(batchJobs.id, id),
            ownershipPredicate(batchJobs, principal),
            eq(batchJobs.status, 'submitting'),
            isNull(batchJobs.upstreamBatchId),
          ),
        )
        .returning({ id: batchJobs.id });
      return rows.length > 0;
    },
    async fail(principal, id, errorKind) {
      const rows = await db
        .update(batchJobs)
        .set({
          status: 'failed',
          errorKind,
          settledCostMicros: 0,
          terminalAt: new Date(),
          stalledSince: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(batchJobs.id, id),
            ownershipPredicate(batchJobs, principal),
            notInArray(batchJobs.status, [...BATCH_JOB_TERMINAL_STATUSES]),
          ),
        )
        .returning();
      return rows[0] ?? null;
    },
  };
}

export type { BatchJobRow };
