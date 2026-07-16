import { and, desc, eq, gte, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import {
  agents,
  models,
  ownershipPredicate,
  providers,
  requestAttempts,
  requestLogs,
  type AnalyticsAccessor,
  type AnalyticsBreakdownRow,
  type AnalyticsBucket,
  type AnalyticsDimension,
  type AnalyticsRange,
  type AnalyticsRequestRow,
  type AnalyticsSummary,
  type AnalyticsTimeseriesPoint,
  type Principal,
  type RequestLogRow,
} from '@polyrouter/shared/server';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Db } from './database.internal';

/** Per-row µ$ — the EXACT expression the budget reader (#16) uses, so dashboard
 * spend reconciles with the budget counters (a float `sum(cost)` would diverge). */
function microsSum(col: AnyPgColumn): SQL<number> {
  return sql<number>`coalesce(sum(round(coalesce(${col}, 0) * 1000000)), 0)`;
}

function intCount(filter?: SQL): SQL<number> {
  return filter
    ? sql<number>`cast(count(*) filter (where ${filter}) as int)`
    : sql<number>`cast(count(*) as int)`;
}

/** UTC-aligned `date_trunc` (matching #16's UTC calendar periods, not the session
 * tz). The unit is a FIXED literal per validated bucket — never interpolated from
 * input. `AT TIME ZONE 'UTC'` twice: timestamptz → UTC wall clock → truncate →
 * back to a timestamptz at that UTC instant (so node-pg returns the right Date). */
function bucketExpr(col: AnyPgColumn, bucket: AnalyticsBucket): SQL<Date> {
  switch (bucket) {
    case 'hour':
      return sql<Date>`(date_trunc('hour', ${col} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;
    case 'week':
      return sql<Date>`(date_trunc('week', ${col} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;
    case 'month':
      return sql<Date>`(date_trunc('month', ${col} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;
    case 'day':
    default:
      return sql<Date>`(date_trunc('day', ${col} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;
  }
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64');
}

/** Subquery of the principal's provider ids — models are owned THROUGH providers. */
function ownedProviderIds(db: Db, principal: Principal) {
  return db
    .select({ id: providers.id })
    .from(providers)
    .where(ownershipPredicate(providers, principal));
}

/** Owner-scoped label resolution for a set of dimension keys (tier key is its own
 * label; models are scoped through their provider). Deleted/foreign ids are absent. */
async function resolveLabels(
  db: Db,
  principal: Principal,
  dimension: AnalyticsDimension,
  keys: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (keys.length === 0) return out;
  if (dimension === 'tier') {
    for (const k of keys) out.set(k, k);
    return out;
  }
  if (dimension === 'model') {
    const rows = await db
      .select({ id: models.id, label: models.externalModelId })
      .from(models)
      .where(
        and(inArray(models.id, keys), inArray(models.providerId, ownedProviderIds(db, principal))),
      );
    for (const r of rows) out.set(r.id, r.label);
  } else if (dimension === 'provider') {
    const rows = await db
      .select({ id: providers.id, label: providers.name })
      .from(providers)
      .where(and(inArray(providers.id, keys), ownershipPredicate(providers, principal)));
    for (const r of rows) out.set(r.id, r.label);
  } else {
    const rows = await db
      .select({ id: agents.id, label: agents.name })
      .from(agents)
      .where(and(inArray(agents.id, keys), ownershipPredicate(agents, principal)));
    for (const r of rows) out.set(r.id, r.label);
  }
  return out;
}

/** Add per-row attempt cost (µ$) + owner-scoped model/provider/agent labels. */
async function enrich(
  db: Db,
  principal: Principal,
  page: RequestLogRow[],
): Promise<AnalyticsRequestRow[]> {
  if (page.length === 0) return [];
  const logIds = page.map((r) => r.id);
  const attemptRows = await db
    .select({
      requestLogId: requestAttempts.requestLogId,
      micros: microsSum(requestAttempts.cost),
    })
    .from(requestAttempts)
    .where(
      and(
        ownershipPredicate(requestAttempts, principal),
        inArray(requestAttempts.requestLogId, logIds),
      ),
    )
    .groupBy(requestAttempts.requestLogId);
  const attemptByLog = new Map(attemptRows.map((r) => [r.requestLogId, Number(r.micros)]));

  const uniq = (v: (string | null)[]): string[] => [
    ...new Set(v.filter((x): x is string => x !== null)),
  ];
  const [modelLabels, providerLabels, agentLabels] = await Promise.all([
    resolveLabels(db, principal, 'model', uniq(page.map((r) => r.modelId))),
    resolveLabels(db, principal, 'provider', uniq(page.map((r) => r.providerId))),
    resolveLabels(db, principal, 'agent', uniq(page.map((r) => r.agentId))),
  ]);

  return page.map((r) => ({
    ...r,
    modelLabel: r.modelId !== null ? (modelLabels.get(r.modelId) ?? null) : null,
    providerLabel: r.providerId !== null ? (providerLabels.get(r.providerId) ?? null) : null,
    agentLabel: r.agentId !== null ? (agentLabels.get(r.agentId) ?? null) : null,
    attemptCostMicros: attemptByLog.get(r.id) ?? 0,
  }));
}

/** Owner-scoped analytics aggregations (#17). Every query filters
 * `ownershipPredicate` + the half-open range; spend sums both ledgers in µ$. */
export function createAnalyticsAccessor(db: Db): AnalyticsAccessor {
  const logRange = (principal: Principal, r: AnalyticsRange): SQL =>
    and(
      ownershipPredicate(requestLogs, principal),
      gte(requestLogs.createdAt, r.from),
      lt(requestLogs.createdAt, r.to),
    ) as SQL;
  const attemptRange = (principal: Principal, r: AnalyticsRange): SQL =>
    and(
      ownershipPredicate(requestAttempts, principal),
      gte(requestAttempts.createdAt, r.from),
      lt(requestAttempts.createdAt, r.to),
    ) as SQL;

  return {
    async summary(principal, range): Promise<AnalyticsSummary> {
      const [log] = await db
        .select({
          requests: intCount(),
          spendMicros: microsSum(requestLogs.cost),
          inputTokens: sql<number>`coalesce(sum(${requestLogs.inputTokens}), 0)`,
          outputTokens: sql<number>`coalesce(sum(${requestLogs.outputTokens}), 0)`,
          cacheReadTokens: sql<number>`coalesce(sum(coalesce(${requestLogs.cacheReadTokens}, 0)), 0)`,
          cacheWriteTokens: sql<number>`coalesce(sum(coalesce(${requestLogs.cacheWriteTokens}, 0)), 0)`,
          successCount: intCount(sql`${requestLogs.status} = 'success'`),
          fallbackCount: intCount(sql`${requestLogs.status} = 'fallback'`),
          errorCount: intCount(sql`${requestLogs.status} = 'error'`),
          escalatedCount: intCount(sql`${requestLogs.escalated}`),
          estimatedCount: intCount(sql`${requestLogs.usageEstimated}`),
          freeRequests: intCount(sql`${requestLogs.cost} = 0`),
          paidRequests: intCount(sql`${requestLogs.cost} > 0`),
          unpricedRequests: intCount(sql`${requestLogs.cost} is null`),
        })
        .from(requestLogs)
        .where(logRange(principal, range));
      const [attempt] = await db
        .select({ spendMicros: microsSum(requestAttempts.cost) })
        .from(requestAttempts)
        .where(attemptRange(principal, range));

      const micros = Number(log?.spendMicros ?? 0) + Number(attempt?.spendMicros ?? 0);
      return {
        spend: micros / 1_000_000,
        requests: Number(log?.requests ?? 0),
        inputTokens: Number(log?.inputTokens ?? 0),
        outputTokens: Number(log?.outputTokens ?? 0),
        cacheReadTokens: Number(log?.cacheReadTokens ?? 0),
        cacheWriteTokens: Number(log?.cacheWriteTokens ?? 0),
        successCount: Number(log?.successCount ?? 0),
        fallbackCount: Number(log?.fallbackCount ?? 0),
        errorCount: Number(log?.errorCount ?? 0),
        escalatedCount: Number(log?.escalatedCount ?? 0),
        estimatedCount: Number(log?.estimatedCount ?? 0),
        freeRequests: Number(log?.freeRequests ?? 0),
        paidRequests: Number(log?.paidRequests ?? 0),
        unpricedRequests: Number(log?.unpricedRequests ?? 0),
      };
    },

    async timeseries(principal, range, bucket): Promise<AnalyticsTimeseriesPoint[]> {
      const logBucket = bucketExpr(requestLogs.createdAt, bucket);
      const logRows = await db
        .select({
          bucket: logBucket,
          requests: intCount(),
          spendMicros: microsSum(requestLogs.cost),
          inputTokens: sql<number>`coalesce(sum(${requestLogs.inputTokens}), 0)`,
          outputTokens: sql<number>`coalesce(sum(${requestLogs.outputTokens}), 0)`,
          errorCount: intCount(sql`${requestLogs.status} = 'error'`),
          fallbackCount: intCount(sql`${requestLogs.status} = 'fallback'`),
          escalatedCount: intCount(sql`${requestLogs.escalated}`),
        })
        .from(requestLogs)
        .where(logRange(principal, range))
        .groupBy(logBucket);

      const attemptBucket = bucketExpr(requestAttempts.createdAt, bucket);
      const attemptRows = await db
        .select({ bucket: attemptBucket, spendMicros: microsSum(requestAttempts.cost) })
        .from(requestAttempts)
        .where(attemptRange(principal, range))
        .groupBy(attemptBucket);

      const points = new Map<number, AnalyticsTimeseriesPoint & { micros: number }>();
      for (const r of logRows) {
        const at = new Date(r.bucket).getTime();
        points.set(at, {
          bucket: new Date(at),
          requests: Number(r.requests),
          spend: 0,
          micros: Number(r.spendMicros),
          inputTokens: Number(r.inputTokens),
          outputTokens: Number(r.outputTokens),
          errorCount: Number(r.errorCount),
          fallbackCount: Number(r.fallbackCount),
          escalatedCount: Number(r.escalatedCount),
        });
      }
      for (const r of attemptRows) {
        const at = new Date(r.bucket).getTime();
        const p = points.get(at);
        if (p) p.micros += Number(r.spendMicros);
        else
          points.set(at, {
            bucket: new Date(at),
            requests: 0,
            spend: 0,
            micros: Number(r.spendMicros),
            inputTokens: 0,
            outputTokens: 0,
            errorCount: 0,
            fallbackCount: 0,
            escalatedCount: 0,
          });
      }
      return [...points.values()]
        .sort((a, b) => a.bucket.getTime() - b.bucket.getTime())
        .map(({ micros, ...p }) => ({ ...p, spend: micros / 1_000_000 }));
    },

    async breakdown(principal, range, dimension, limit): Promise<AnalyticsBreakdownRow[]> {
      const logKey =
        dimension === 'model'
          ? requestLogs.modelId
          : dimension === 'provider'
            ? requestLogs.providerId
            : dimension === 'agent'
              ? requestLogs.agentId
              : requestLogs.tierAssigned;
      const logRows = await db
        .select({ key: logKey, requests: intCount(), spendMicros: microsSum(requestLogs.cost) })
        .from(requestLogs)
        .where(logRange(principal, range))
        .groupBy(logKey);

      // Attempt-ledger spend by the same dimension. The agent breakdown joins
      // attempts to their PARENT log for agent_id — BOTH sides owner-scoped.
      let attemptRows: { key: string | null; spendMicros: number }[];
      if (dimension === 'agent') {
        attemptRows = await db
          .select({ key: requestLogs.agentId, spendMicros: microsSum(requestAttempts.cost) })
          .from(requestAttempts)
          .innerJoin(requestLogs, eq(requestAttempts.requestLogId, requestLogs.id))
          .where(
            and(
              ownershipPredicate(requestAttempts, principal),
              ownershipPredicate(requestLogs, principal),
              gte(requestAttempts.createdAt, range.from),
              lt(requestAttempts.createdAt, range.to),
            ),
          )
          .groupBy(requestLogs.agentId);
      } else {
        const attKey =
          dimension === 'model'
            ? requestAttempts.modelId
            : dimension === 'provider'
              ? requestAttempts.providerId
              : requestAttempts.tierKey;
        attemptRows = await db
          .select({ key: attKey, spendMicros: microsSum(requestAttempts.cost) })
          .from(requestAttempts)
          .where(attemptRange(principal, range))
          .groupBy(attKey);
      }

      const agg = new Map<string, { micros: number; requests: number }>();
      for (const r of logRows) {
        const k = r.key ?? '';
        const e = agg.get(k) ?? { micros: 0, requests: 0 };
        e.micros += Number(r.spendMicros);
        e.requests += Number(r.requests);
        agg.set(k, e);
      }
      for (const r of attemptRows) {
        const k = r.key ?? '';
        const e = agg.get(k) ?? { micros: 0, requests: 0 };
        e.micros += Number(r.spendMicros);
        agg.set(k, e);
      }

      const top = [...agg.entries()]
        .sort((a, b) => b[1].micros - a[1].micros)
        .slice(0, limit)
        .map(([key, v]) => ({ key, spend: v.micros / 1_000_000, requests: v.requests }));

      const labels = await resolveLabels(
        db,
        principal,
        dimension,
        top.map((t) => t.key).filter((k) => k !== ''),
      );
      return top.map((t) => ({
        key: t.key,
        label: t.key === '' ? null : (labels.get(t.key) ?? null),
        spend: t.spend,
        requests: t.requests,
      }));
    },

    async listRequests(principal, query) {
      const conds: SQL[] = [
        ownershipPredicate(requestLogs, principal),
        gte(requestLogs.createdAt, query.from),
        lt(requestLogs.createdAt, query.to),
      ];
      if (query.status !== undefined) conds.push(eq(requestLogs.status, query.status));
      if (query.decisionLayer !== undefined)
        conds.push(eq(requestLogs.decisionLayer, query.decisionLayer));
      if (query.escalated !== undefined) conds.push(eq(requestLogs.escalated, query.escalated));
      if (query.cursor !== undefined) {
        conds.push(
          or(
            lt(requestLogs.createdAt, query.cursor.createdAt),
            and(
              eq(requestLogs.createdAt, query.cursor.createdAt),
              lt(requestLogs.id, query.cursor.id),
            ),
          ) as SQL,
        );
      }
      const raw = await db
        .select()
        .from(requestLogs)
        .where(and(...conds))
        .orderBy(desc(requestLogs.createdAt), desc(requestLogs.id))
        .limit(query.limit + 1);

      const hasMore = raw.length > query.limit;
      const page = raw.slice(0, query.limit);
      const last = page[page.length - 1];
      const nextCursor = hasMore && last ? encodeCursor(last) : null;
      return { rows: await enrich(db, principal, page), nextCursor };
    },
  };
}
