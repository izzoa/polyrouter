import { and, desc, eq, getTableColumns, gte, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import {
  agents,
  models,
  ownershipPredicate,
  providers,
  requestAttempts,
  requestLogs,
  type AnalyticsAccessor,
  type AnalyticsBreakdownRow,
  type AutoCounterfactualRates,
  type AutoPerformanceData,
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
import { microsSum, microsSumIf } from './cost-sql';

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

function encodeCursor(row: { createdAtText: string; id: string }): string {
  // Encode the FULL-precision timestamp text (µs), not a ms-truncated JS Date, so
  // the next-page predicate can match rows sharing one batched `now()` (E3).
  return Buffer.from(`${row.createdAtText}|${row.id}`, 'utf8').toString('base64');
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
      hasNative: sql<boolean>`bool_or(${requestAttempts.priceSource} = 'native_family')`,
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
  const nativeAttemptByLog = new Map(
    attemptRows.map((r) => [r.requestLogId, r.hasNative === true]),
  );

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
    // Rolled-up estimate flag: the served row OR any attempt priced native_family.
    priceEstimated: r.priceSource === 'native_family' || (nativeAttemptByLog.get(r.id) ?? false),
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
          nativeMicros: microsSumIf(
            requestLogs.cost,
            sql`${requestLogs.priceSource} = 'native_family'`,
          ),
        })
        .from(requestLogs)
        .where(logRange(principal, range));
      const [attempt] = await db
        .select({
          spendMicros: microsSum(requestAttempts.cost),
          nativeMicros: microsSumIf(
            requestAttempts.cost,
            sql`${requestAttempts.priceSource} = 'native_family'`,
          ),
        })
        .from(requestAttempts)
        .where(attemptRange(principal, range));

      const micros = Number(log?.spendMicros ?? 0) + Number(attempt?.spendMicros ?? 0);
      const nativeMicros = Number(log?.nativeMicros ?? 0) + Number(attempt?.nativeMicros ?? 0);
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
        nativeFamilySpend: nativeMicros / 1_000_000,
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

    /** Auto-performance aggregation (add-auto-performance-view): DISJOINT
     * partitions over the decision-telemetry columns; savings as per-row
     * integer micro-dollars against caller-resolved counterfactual rates
     * (tokens × $/1M IS micros — `round(usd × 1e6)` per row by construction,
     * mirroring `computeCost`'s null-on-missing-cache-component rule). */
    async autoPerformance(
      principal: Principal,
      range: AnalyticsRange,
      bucket: AnalyticsBucket,
      counterfactual: AutoCounterfactualRates | null,
    ): Promise<AutoPerformanceData> {
      const banded = and(
        logRange(principal, range),
        sql`${requestLogs.structuralBand} is not null`,
      ) as SQL;
      const cascadeBase = sql`${requestLogs.structuralBand} = 'ambiguous' and ${requestLogs.decisionLayer} = 'cascade'`;
      const [t] = await db
        .select({
          evaluated: intCount(),
          highRequests: intCount(sql`${requestLogs.structuralBand} = 'high'`),
          highDeclared: intCount(
            sql`${requestLogs.structuralBand} = 'high' and ${requestLogs.structuralBandSource} = 'declared'`,
          ),
          highUnroutable: intCount(
            sql`${requestLogs.structuralBand} = 'high' and ${requestLogs.decisionLayer} = 'default'`,
          ),
          lowRequests: intCount(sql`${requestLogs.structuralBand} = 'low'`),
          lowDeclared: intCount(
            sql`${requestLogs.structuralBand} = 'low' and ${requestLogs.structuralBandSource} = 'declared'`,
          ),
          lowUnroutable: intCount(
            sql`${requestLogs.structuralBand} = 'low' and ${requestLogs.decisionLayer} = 'default'`,
          ),
          ambiguous: intCount(sql`${requestLogs.structuralBand} = 'ambiguous'`),
          cascadeRequests: intCount(cascadeBase),
          qualityPassed: intCount(
            sql`${cascadeBase} and not ${requestLogs.escalated} and ${requestLogs.status} in ('success','fallback') and ${requestLogs.qualitySignal} is not null`,
          ),
          qualityUnknown: intCount(
            sql`${cascadeBase} and not ${requestLogs.escalated} and ${requestLogs.status} in ('success','fallback') and ${requestLogs.qualitySignal} is null`,
          ),
          failedOrCancelled: intCount(
            sql`${cascadeBase} and not ${requestLogs.escalated} and ${requestLogs.status} in ('error','cancelled')`,
          ),
          cascadeEscalated: intCount(sql`${cascadeBase} and ${requestLogs.escalated}`),
          fallthrough: intCount(
            sql`${requestLogs.structuralBand} = 'ambiguous' and ${requestLogs.decisionLayer} = 'default'`,
          ),
        })
        .from(requestLogs)
        .where(banded);

      const seriesBucket = bucketExpr(requestLogs.createdAt, bucket);
      const seriesRows = await db
        .select({
          bucket: seriesBucket,
          high: intCount(sql`${requestLogs.structuralBand} = 'high'`),
          low: intCount(sql`${requestLogs.structuralBand} = 'low'`),
          ambiguous: intCount(sql`${requestLogs.structuralBand} = 'ambiguous'`),
        })
        .from(requestLogs)
        .where(banded)
        .groupBy(seriesBucket)
        .orderBy(seriesBucket);

      // RANGE-INDEPENDENT: the tenant's earliest banded row ever.
      const [since] = await db
        .select({ min: sql<Date | null>`min(${requestLogs.createdAt})` })
        .from(requestLogs)
        .where(
          and(
            ownershipPredicate(requestLogs, principal),
            sql`${requestLogs.structuralBand} is not null`,
          ),
        );

      let savings: AutoPerformanceData['savings'] = null;
      if (counterfactual !== null) {
        const c = counterfactual;
        const qualityPassedCond = sql`${cascadeBase} and not ${requestLogs.escalated} and ${requestLogs.status} in ('success','fallback') and ${requestLogs.qualitySignal} is not null`;
        const crMissing = c.cacheReadPer1m === null ? sql`true` : sql`false`;
        const cwMissing = c.cacheWritePer1m === null ? sql`true` : sql`false`;
        const uncostable = sql`(${requestLogs.cost} is null or (coalesce(${requestLogs.cacheReadTokens}, 0) > 0 and ${crMissing}) or (coalesce(${requestLogs.cacheWriteTokens}, 0) > 0 and ${cwMissing}))`;
        const cfMicros = sql`round(${requestLogs.inputTokens} * ${c.inputPer1m} + ${requestLogs.outputTokens} * ${c.outputPer1m} + coalesce(${requestLogs.cacheReadTokens}, 0) * ${c.cacheReadPer1m ?? 0} + coalesce(${requestLogs.cacheWriteTokens}, 0) * ${c.cacheWritePer1m ?? 0})`;
        const deltaMicros = sql`(${cfMicros} - round(${requestLogs.cost} * 1000000))`;
        const [sums] = await db
          .select({
            rows: intCount(sql`not ${uncostable}`),
            uncostedRows: intCount(uncostable),
            netMicros: sql<number>`coalesce(sum(case when not ${uncostable} then ${deltaMicros} else 0 end), 0)`,
            grossMicros: sql<number>`coalesce(sum(case when not ${uncostable} and ${deltaMicros} > 0 then ${deltaMicros} else 0 end), 0)`,
            excessMicros: sql<number>`coalesce(sum(case when not ${uncostable} and ${deltaMicros} < 0 then -${deltaMicros} else 0 end), 0)`,
          })
          .from(requestLogs)
          .where(and(logRange(principal, range), qualityPassedCond));
        // Unknown-not-zero (r3-High-2): with no costable row the totals are
        // null, never a fabricated $0 — coverage still reports the exclusions.
        const costable = sums!.rows > 0;
        savings = {
          rows: sums!.rows,
          uncostedRows: sums!.uncostedRows,
          netMicros: costable ? Number(sums!.netMicros) : null,
          grossMicros: costable ? Number(sums!.grossMicros) : null,
          excessMicros: costable ? Number(sums!.excessMicros) : null,
        };
      }

      const iso = (v: Date | string | null | undefined): string | null =>
        v == null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();
      return {
        evaluated: t!.evaluated,
        bands: {
          high: {
            requests: t!.highRequests,
            declared: t!.highDeclared,
            unroutable: t!.highUnroutable,
          },
          low: { requests: t!.lowRequests, declared: t!.lowDeclared, unroutable: t!.lowUnroutable },
          ambiguous: { requests: t!.ambiguous },
        },
        cascade: {
          requests: t!.cascadeRequests,
          qualityPassed: t!.qualityPassed,
          qualityUnknown: t!.qualityUnknown,
          failedOrCancelled: t!.failedOrCancelled,
          escalated: t!.cascadeEscalated,
        },
        fallthrough: t!.fallthrough,
        series: seriesRows.map((r) => ({
          bucket: iso(r.bucket)!,
          high: r.high,
          low: r.low,
          ambiguous: r.ambiguous,
        })),
        telemetrySince: iso(since?.min),
        savings,
      };
    },

    async listRequests(principal, query) {
      const conds: SQL[] = [
        ownershipPredicate(requestLogs, principal),
        gte(requestLogs.createdAt, query.from),
        lt(requestLogs.createdAt, query.to),
      ];
      if (query.status !== undefined) conds.push(eq(requestLogs.status, query.status));
      if (query.decisionLayers !== undefined && query.decisionLayers.length > 0)
        conds.push(inArray(requestLogs.decisionLayer, query.decisionLayers));
      if (query.escalated !== undefined) conds.push(eq(requestLogs.escalated, query.escalated));
      if (query.cursor !== undefined) {
        // Bind the cursor timestamp as ::timestamptz so Postgres compares at the
        // column's full µs precision (the cursor carries the raw ::text value).
        const cursorTs = query.cursor.createdAt;
        conds.push(
          or(
            sql`${requestLogs.createdAt} < ${cursorTs}::timestamptz`,
            and(
              sql`${requestLogs.createdAt} = ${cursorTs}::timestamptz`,
              lt(requestLogs.id, query.cursor.id),
            ),
          ) as SQL,
        );
      }
      const raw = await db
        .select({
          ...getTableColumns(requestLogs),
          // A DateStyle-independent, always-UTC, µs-precision rendering (not raw
          // `::text`, whose format depends on the server's DateStyle) so the
          // cursor round-trips deterministically and `::timestamptz` re-parses it.
          createdAtText: sql<string>`to_char(${requestLogs.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(requestLogs)
        .where(and(...conds))
        .orderBy(desc(requestLogs.createdAt), desc(requestLogs.id))
        .limit(query.limit + 1);

      const hasMore = raw.length > query.limit;
      const page = raw.slice(0, query.limit);
      const last = page[page.length - 1];
      const nextCursor = hasMore && last ? encodeCursor(last) : null;
      // Strip the cursor-only helper column so it never reaches the safe view.
      const stripped = page.map(({ createdAtText: _t, ...r }) => r);
      return { rows: await enrich(db, principal, stripped), nextCursor };
    },
  };
}
