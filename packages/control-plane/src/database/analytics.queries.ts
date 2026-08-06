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
  type AnalyticsTokens,
  type Principal,
  type RequestLogRow,
} from '@polyrouter/shared/server';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Db } from './database.internal';
import {
  cashMicrosSum,
  isCashLike,
  knownCashMicrosSum,
  microsSum,
  microsSumIf,
  subscriptionMicrosSum,
  unknownMicrosSum,
} from './cost-sql';
import { computeSignalQuality } from './signal-quality';

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
      // Deliberately the UNFILTERED sum: this is per-request detail for the listing and
      // inspector — what THIS request's attempts actually cost — not a range spend
      // aggregate. A subscription request must still show its recorded notional cost
      // here, or the inspector would claim it was free. Only aggregate spend figures
      // exclude the subscription component (split-subscription-spend).
      micros: microsSum(requestAttempts.cost),
      // Any attempt priced by an ESTIMATE source — native-family OR listed
      // (record-listed-price-fallback), both non-authoritative.
      hasEstimated: sql<boolean>`bool_or(${requestAttempts.priceSource} in ('native_family', 'listed'))`,
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
  const estimatedAttemptByLog = new Map(
    attemptRows.map((r) => [r.requestLogId, r.hasEstimated === true]),
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
    // Rolled-up estimate flag: the served row OR any attempt priced by an estimate
    // source (native_family or listed).
    priceEstimated:
      r.priceSource === 'native_family' ||
      r.priceSource === 'listed' ||
      (estimatedAttemptByLog.get(r.id) ?? false),
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

  /** The four recorded token components for a ledger.
   *
   * Reported as components, never collapsed: `input_tokens` is recorded as *uncached*
   * input (the adapters subtract cached tokens out — `translate/usage.ts`), so a single
   * total that dropped cache would under-report a cached workload while looking exact.
   * Null cache coalesces to zero, matching how the summary has always aggregated it. */
  const tokenSums = (t: typeof requestLogs | typeof requestAttempts) => ({
    inputTokens: sql<number>`coalesce(sum(${t.inputTokens}), 0)`,
    outputTokens: sql<number>`coalesce(sum(${t.outputTokens}), 0)`,
    cacheReadTokens: sql<number>`coalesce(sum(coalesce(${t.cacheReadTokens}, 0)), 0)`,
    cacheWriteTokens: sql<number>`coalesce(sum(coalesce(${t.cacheWriteTokens}, 0)), 0)`,
  });

  /** Tokens from rows whose usage was ESTIMATED. A component of the totals, never
   * subtracted from them — excluding estimated rows would understate real work and make a
   * ranking depend on how completely each provider reports usage. */
  const estimatedTokenSum = (t: typeof requestLogs | typeof requestAttempts) =>
    sql<number>`coalesce(sum(case when ${t.usageEstimated} then ${t.inputTokens} + ${t.outputTokens} + coalesce(${t.cacheReadTokens}, 0) + coalesce(${t.cacheWriteTokens}, 0) else 0 end), 0)`;

  const addTokens = (a: AnalyticsTokens, b: Partial<AnalyticsTokens> | undefined): AnalyticsTokens => ({
    inputTokens: a.inputTokens + Number(b?.inputTokens ?? 0),
    outputTokens: a.outputTokens + Number(b?.outputTokens ?? 0),
    cacheReadTokens: a.cacheReadTokens + Number(b?.cacheReadTokens ?? 0),
    cacheWriteTokens: a.cacheWriteTokens + Number(b?.cacheWriteTokens ?? 0),
  });
  const ZERO_TOKENS: AnalyticsTokens = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const totalTokens = (t: AnalyticsTokens): number =>
    t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;

  return {
    async summary(principal, range): Promise<AnalyticsSummary> {
      const [log] = await db
        .select({
          requests: intCount(),
          // Reported spend EXCLUDES prepaid subscription traffic (split-subscription-
          // spend) — this is what a `cash`-basis budget meters, so the two reconcile.
          spendMicros: cashMicrosSum(requestLogs.cost, requestLogs.providerKind),
          inputTokens: sql<number>`coalesce(sum(${requestLogs.inputTokens}), 0)`,
          outputTokens: sql<number>`coalesce(sum(${requestLogs.outputTokens}), 0)`,
          cacheReadTokens: sql<number>`coalesce(sum(coalesce(${requestLogs.cacheReadTokens}, 0)), 0)`,
          cacheWriteTokens: sql<number>`coalesce(sum(coalesce(${requestLogs.cacheWriteTokens}, 0)), 0)`,
          successCount: intCount(sql`${requestLogs.status} = 'success'`),
          fallbackCount: intCount(sql`${requestLogs.status} = 'fallback'`),
          errorCount: intCount(sql`${requestLogs.status} = 'error'`),
          escalatedCount: intCount(sql`${requestLogs.escalated}`),
          estimatedCount: intCount(sql`${requestLogs.usageEstimated}`),
          // Cost classification runs BEFORE the component: null = unpriced, 0 = free
          // (including a zero-cost subscription or local row). Only positive-cost rows
          // are split by provider kind. `paidRequests` is retained as the priced TOTAL
          // so existing consumers are not broken; the split is additive beside it.
          freeRequests: intCount(sql`${requestLogs.cost} = 0`),
          paidRequests: intCount(sql`${requestLogs.cost} > 0`),
          unpricedRequests: intCount(sql`${requestLogs.cost} is null`),
          subscriptionPricedRequests: intCount(
            sql`${requestLogs.cost} > 0 and ${requestLogs.providerKind} = 'subscription'`,
          ),
          cashPricedRequests: intCount(
            sql`${requestLogs.cost} > 0 and ${requestLogs.providerKind} is distinct from 'subscription'`,
          ),
          // Estimate provenance is a SEPARATE axis from the component. Scoped to the
          // REPORTED-SPEND population (cash + unknown) — the same rows `spend` above
          // sums — because this field is documented as a portion OF that total.
          // Narrowing it to known-cash would let a range whose spend is entirely
          // unclassified-and-estimated report `nativeFamilySpend: 0`, hiding that the
          // headline is estimate-priced. Subscription rows are excluded because they are
          // not in the total either. (The budget reader computes its own estimate figure
          // over whatever ITS basis meters — deliberately different; do not unify.)
          nativeMicros: microsSumIf(
            requestLogs.cost,
            sql`${requestLogs.priceSource} = 'native_family' and ${isCashLike(requestLogs.providerKind)}`,
          ),
          subscriptionMicros: subscriptionMicrosSum(requestLogs.cost, requestLogs.providerKind),
          unknownMicros: unknownMicrosSum(requestLogs.cost, requestLogs.providerKind),
          knownCashMicros: knownCashMicrosSum(requestLogs.cost, requestLogs.providerKind),
        })
        .from(requestLogs)
        .where(logRange(principal, range));
      const [attempt] = await db
        .select({
          spendMicros: cashMicrosSum(requestAttempts.cost, requestAttempts.providerKind),
          // Tokens now sum BOTH ledgers: an escalated cascade attempt consumed tokens the
          // user was billed for, so counting only the served row under-reports usage.
          // (Request counts stay served-only — an attempt is a billable call, not a user
          // request.)
          ...tokenSums(requestAttempts),
          nativeMicros: microsSumIf(
            requestAttempts.cost,
            sql`${requestAttempts.priceSource} = 'native_family' and ${isCashLike(requestAttempts.providerKind)}`,
          ),
          subscriptionMicros: subscriptionMicrosSum(
            requestAttempts.cost,
            requestAttempts.providerKind,
          ),
          unknownMicros: unknownMicrosSum(requestAttempts.cost, requestAttempts.providerKind),
          knownCashMicros: knownCashMicrosSum(
            requestAttempts.cost,
            requestAttempts.providerKind,
          ),
        })
        .from(requestAttempts)
        .where(attemptRange(principal, range));

      // Each component sums BOTH ledgers, each filtered by its own `created_at` —
      // identical per-row micro-dollar arithmetic to the total it is a portion of.
      const micros = Number(log?.spendMicros ?? 0) + Number(attempt?.spendMicros ?? 0);
      const nativeMicros = Number(log?.nativeMicros ?? 0) + Number(attempt?.nativeMicros ?? 0);
      const subscriptionMicros =
        Number(log?.subscriptionMicros ?? 0) + Number(attempt?.subscriptionMicros ?? 0);
      const unknownMicros = Number(log?.unknownMicros ?? 0) + Number(attempt?.unknownMicros ?? 0);
      const knownCashMicros =
        Number(log?.knownCashMicros ?? 0) + Number(attempt?.knownCashMicros ?? 0);
      const tokens = addTokens(addTokens(ZERO_TOKENS, log), attempt);
      return {
        spend: micros / 1_000_000,
        requests: Number(log?.requests ?? 0),
        ...tokens,
        successCount: Number(log?.successCount ?? 0),
        fallbackCount: Number(log?.fallbackCount ?? 0),
        errorCount: Number(log?.errorCount ?? 0),
        escalatedCount: Number(log?.escalatedCount ?? 0),
        estimatedCount: Number(log?.estimatedCount ?? 0),
        freeRequests: Number(log?.freeRequests ?? 0),
        paidRequests: Number(log?.paidRequests ?? 0),
        unpricedRequests: Number(log?.unpricedRequests ?? 0),
        subscriptionPricedRequests: Number(log?.subscriptionPricedRequests ?? 0),
        cashPricedRequests: Number(log?.cashPricedRequests ?? 0),
        nativeFamilySpend: nativeMicros / 1_000_000,
        // `spend` above is cash + unknown. These expose the partition so a consumer can
        // reconstruct any basis, and so the UI can show a pure-cash figure without
        // inferring one by subtraction.
        cashSpend: knownCashMicros / 1_000_000,
        subscriptionSpend: subscriptionMicros / 1_000_000,
        unknownSpend: unknownMicros / 1_000_000,
      };
    },

    async timeseries(principal, range, bucket): Promise<AnalyticsTimeseriesPoint[]> {
      const logBucket = bucketExpr(requestLogs.createdAt, bucket);
      const logRows = await db
        .select({
          bucket: logBucket,
          requests: intCount(),
          // Reported spend EXCLUDES prepaid subscription traffic (split-subscription-
          // spend) — this is what a `cash`-basis budget meters, so the two reconcile.
          spendMicros: cashMicrosSum(requestLogs.cost, requestLogs.providerKind),
          ...tokenSums(requestLogs),
          errorCount: intCount(sql`${requestLogs.status} = 'error'`),
          fallbackCount: intCount(sql`${requestLogs.status} = 'fallback'`),
          escalatedCount: intCount(sql`${requestLogs.escalated}`),
        })
        .from(requestLogs)
        .where(logRange(principal, range))
        .groupBy(logBucket);

      const attemptBucket = bucketExpr(requestAttempts.createdAt, bucket);
      const attemptRows = await db
        .select({
          bucket: attemptBucket,
          spendMicros: cashMicrosSum(requestAttempts.cost, requestAttempts.providerKind),
          // Tokens on this ledger too. Without them a bucket containing ONLY attempt rows
          // reported zero tokens beside a non-zero spend.
          ...tokenSums(requestAttempts),
        })
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
          ...addTokens(ZERO_TOKENS, r),
          errorCount: Number(r.errorCount),
          fallbackCount: Number(r.fallbackCount),
          escalatedCount: Number(r.escalatedCount),
        });
      }
      for (const r of attemptRows) {
        const at = new Date(r.bucket).getTime();
        const p = points.get(at);
        if (p) {
          p.micros += Number(r.spendMicros);
          Object.assign(p, addTokens(p, r));
        } else
          points.set(at, {
            bucket: new Date(at),
            requests: 0,
            spend: 0,
            micros: Number(r.spendMicros),
            // An attempt-only bucket now carries its tokens instead of zero.
            ...addTokens(ZERO_TOKENS, r),
            errorCount: 0,
            fallbackCount: 0,
            escalatedCount: 0,
          });
      }
      return [...points.values()]
        .sort((a, b) => a.bucket.getTime() - b.bucket.getTime())
        .map(({ micros, ...p }) => ({ ...p, spend: micros / 1_000_000 }));
    },

    async breakdown(principal, range, dimension, limit, metric): Promise<AnalyticsBreakdownRow[]> {
      const logKey =
        dimension === 'model'
          ? requestLogs.modelId
          : dimension === 'provider'
            ? requestLogs.providerId
            : dimension === 'agent'
              ? requestLogs.agentId
              : requestLogs.tierAssigned;
      const logRows = await db
        .select({
          key: logKey,
          requests: intCount(),
          spendMicros: cashMicrosSum(requestLogs.cost, requestLogs.providerKind),
          ...tokenSums(requestLogs),
          estimatedTokens: estimatedTokenSum(requestLogs),
        })
        .from(requestLogs)
        .where(logRange(principal, range))
        .groupBy(logKey);

      // Attempt-ledger spend by the same dimension. The agent breakdown joins
      // attempts to their PARENT log for agent_id — BOTH sides owner-scoped.
      let attemptRows: ({ key: string | null; spendMicros: number; estimatedTokens: number } & AnalyticsTokens)[];
      if (dimension === 'agent') {
        attemptRows = await db
          .select({
          key: requestLogs.agentId,
          spendMicros: cashMicrosSum(requestAttempts.cost, requestAttempts.providerKind),
          ...tokenSums(requestAttempts),
          estimatedTokens: estimatedTokenSum(requestAttempts),
        })
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
          .select({
          key: attKey,
          spendMicros: cashMicrosSum(requestAttempts.cost, requestAttempts.providerKind),
          ...tokenSums(requestAttempts),
          estimatedTokens: estimatedTokenSum(requestAttempts),
        })
          .from(requestAttempts)
          .where(attemptRange(principal, range))
          .groupBy(attKey);
      }

      type Agg = AnalyticsTokens & { micros: number; requests: number; estimatedTokens: number };
      const blank = (): Agg => ({ ...ZERO_TOKENS, micros: 0, requests: 0, estimatedTokens: 0 });
      const agg = new Map<string, Agg>();
      for (const r of logRows) {
        const k = r.key ?? '';
        const e = agg.get(k) ?? blank();
        e.micros += Number(r.spendMicros);
        e.requests += Number(r.requests);
        Object.assign(e, addTokens(e, r));
        e.estimatedTokens += Number(r.estimatedTokens);
        agg.set(k, e);
      }
      for (const r of attemptRows) {
        const k = r.key ?? '';
        const e = agg.get(k) ?? blank();
        e.micros += Number(r.spendMicros);
        // Tokens from BOTH ledgers; `requests` deliberately not incremented — an attempt
        // is a billable call, not a user request.
        Object.assign(e, addTokens(e, r));
        e.estimatedTokens += Number(r.estimatedTokens);
        agg.set(k, e);
      }

      // Rank by the metric being ASKED for, then truncate. Doing it the other way round —
      // taking the top N by spend and re-sorting — silently drops a dimension value that
      // leads on tokens and trails on spend, producing a chart that is wrong only in what
      // is missing from it. Ties break on key so the row set is stable between requests.
      const rank = (v: Agg): number => (metric === 'tokens' ? totalTokens(v) : v.micros);
      const top = [...agg.entries()]
        .sort((a, b) => rank(b[1]) - rank(a[1]) || a[0].localeCompare(b[0]))
        .slice(0, limit)
        .map(([key, v]) => ({
          key,
          spend: v.micros / 1_000_000,
          requests: v.requests,
          inputTokens: v.inputTokens,
          outputTokens: v.outputTokens,
          cacheReadTokens: v.cacheReadTokens,
          cacheWriteTokens: v.cacheWriteTokens,
          estimatedTokens: v.estimatedTokens,
        }));

      const labels = await resolveLabels(
        db,
        principal,
        dimension,
        top.map((t) => t.key).filter((k) => k !== ''),
      );
      return top.map((t) => ({
        ...t,
        label: t.key === '' ? null : (labels.get(t.key) ?? null),
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
      // ONE routed predicate shared by the routed-per-band counts AND the outcome
      // split (clink change-4 Med-1): a `decision_layer='semantic'` row with a
      // null/ambiguous band must contribute to NEITHER, so the four outcomes stay
      // disjoint + exhaustive over — and sum exactly to — the routed total.
      const semanticRouted = sql`${requestLogs.decisionLayer} = 'semantic' and ${requestLogs.semanticBand} in ('high','low')`;
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
          // L2 semantic slice (add-semantic-dashboard D4). semantic_band non-null
          // ⊆ structural_band='ambiguous' ⊆ banded, so these are within `banded`.
          semanticEvaluated: intCount(sql`${requestLogs.semanticBand} is not null`),
          semanticRoutedHigh: intCount(sql`${semanticRouted} and ${requestLogs.semanticBand} = 'high'`),
          semanticRoutedLow: intCount(sql`${semanticRouted} and ${requestLogs.semanticBand} = 'low'`),
          // Routed outcome split — DISJOINT + EXHAUSTIVE over the SAME routed
          // population, so success+fallback+error+cancelled == routed total.
          semanticSuccess: intCount(sql`${semanticRouted} and ${requestLogs.status} = 'success'`),
          semanticFallback: intCount(sql`${semanticRouted} and ${requestLogs.status} = 'fallback'`),
          semanticError: intCount(sql`${semanticRouted} and ${requestLogs.status} = 'error'`),
          semanticCancelled: intCount(sql`${semanticRouted} and ${requestLogs.status} = 'cancelled'`),
          // Source split over EVALUATED rows.
          semanticBundled: intCount(
            sql`${requestLogs.semanticBand} is not null and ${requestLogs.semanticSource} = 'bundled'`,
          ),
          semanticLearned: intCount(
            sql`${requestLogs.semanticBand} is not null and ${requestLogs.semanticSource} = 'learned'`,
          ),
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

      // Per-agent signal quality (add-auto-signal-honesty): two grouped scans
      // over the SAME all-epoch banded population (half-open range — never
      // BETWEEN), judgments in the pure module. The bucket cardinality is
      // bounded (≤ 101 two-decimal buckets per agent), so the merge is tiny.
      const ambiguousOnly = sql`${requestLogs.structuralBand} = 'ambiguous'`;
      const sqPerAgent = await db
        .select({
          agentId: requestLogs.agentId,
          bandedRows: intCount(),
          ambiguousRows: intCount(ambiguousOnly),
          distinctScores: sql<number>`cast(count(distinct ${requestLogs.structuralScore}) filter (where ${ambiguousOnly}) as int)`,
        })
        .from(requestLogs)
        .where(banded)
        .groupBy(requestLogs.agentId);
      // The operator-facing 2-decimal bucket (numeric rounding DEFINES the
      // bucket; ::float8 so node-pg hands back a number, not a string).
      const sqBucket = sql<number>`(round((${requestLogs.structuralScore})::numeric, 2))::float8`;
      const sqPerBucket = await db
        .select({ agentId: requestLogs.agentId, bucket: sqBucket, rows: intCount() })
        .from(requestLogs)
        .where(and(banded, ambiguousOnly, sql`${requestLogs.structuralScore} is not null`))
        .groupBy(requestLogs.agentId, sqBucket);
      // Owner-scoped labels via the SAME resolver the breakdown uses: a
      // denormalized foreign agent_id simply misses (null label) — another
      // tenant's name can never appear here.
      const sqLabels = await resolveLabels(
        db,
        principal,
        'agent',
        sqPerAgent.map((r) => r.agentId).filter((v): v is string => v !== null),
      );
      const signalQuality = computeSignalQuality(sqPerAgent, sqPerBucket, sqLabels);

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
        semantic: {
          evaluated: t!.semanticEvaluated,
          routed: { high: t!.semanticRoutedHigh, low: t!.semanticRoutedLow },
          outcomes: {
            success: t!.semanticSuccess,
            fallback: t!.semanticFallback,
            error: t!.semanticError,
            cancelled: t!.semanticCancelled,
          },
          source: { bundled: t!.semanticBundled, learned: t!.semanticLearned },
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
        signalQuality,
      };
    },

    async calibrationStats(principal, range, args) {
      // The DECIDED population, fail-closed on provenance (r2-High-2): a pass
      // is served+scored+non-escalated with a NULL escalation source; a
      // failure is a quality-gate escalation regardless of the strong leg's
      // terminal status. Epoch equality is the freshness rail (r2-Med-3) —
      // rows decided under an earlier pair never re-qualify, whatever the
      // async writer's insertion clock says.
      const base = and(
        logRange(principal, range),
        sql`${requestLogs.structuralBand} = 'ambiguous'`,
        sql`${requestLogs.decisionLayer} = 'cascade'`,
        sql`${requestLogs.structuralBandSource} = 'threshold'`,
        sql`${requestLogs.structuralEpoch} = ${args.epoch}`,
      );
      const pass = sql`(not ${requestLogs.escalated} and ${requestLogs.escalationSource} is null and ${requestLogs.status} in ('success','fallback') and ${requestLogs.qualitySignal} is not null)`;
      const failure = sql`(${requestLogs.escalated} and ${requestLogs.escalationSource} = 'quality_gate')`;
      const decided = sql`(${pass} or ${failure})`;
      const highZone = sql`(${requestLogs.structuralScore} >= ${args.high - args.edgeWidth} and ${requestLogs.structuralScore} < ${args.high})`;
      const lowZone = sql`(${requestLogs.structuralScore} > ${args.low} and ${requestLogs.structuralScore} <= ${args.low + args.edgeWidth})`;
      const [t] = await db
        .select({
          highSamples: intCount(sql`${decided} and ${highZone}`),
          highFailures: intCount(sql`${failure} and ${highZone}`),
          lowSamples: intCount(sql`${decided} and ${lowZone}`),
          lowFailures: intCount(sql`${failure} and ${lowZone}`),
        })
        .from(requestLogs)
        .where(base);
      return {
        highEdge: { samples: t!.highSamples, failures: t!.highFailures },
        lowEdge: { samples: t!.lowSamples, failures: t!.lowFailures },
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
