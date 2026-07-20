import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { ruleOrder } from '@polyrouter/data-plane';
import {
  PERSISTENCE_PORT,
  parseRoutingTarget,
  type AnalyticsBreakdownRow,
  type AnalyticsRange,
  type AnalyticsRequestRow,
  type AnalyticsRequestsCursor,
  type AnalyticsSummary,
  type AnalyticsTimeseriesPoint,
  type AutoCounterfactualRates,
  type AutoPerformanceData,
  type PersistencePort,
  type Principal,
} from '@polyrouter/shared/server';
import { PricingService } from '../pricing/pricing.service';
import type {
  AutoQueryDto,
  BreakdownQueryDto,
  RequestsQueryDto,
  SummaryQueryDto,
  TimeseriesQueryDto,
} from './analytics.dto';

/** The auto-performance response: accessor aggregates + the resolved savings
 * presentation (USD from micros, discriminated basis) — or null savings when
 * the `auto_high` basis is unresolvable/unpriced (never a fabricated zero). */
export interface AutoPerformanceView extends Omit<AutoPerformanceData, 'savings'> {
  savings: {
    /** Null when zero rows were costable — unknown, never $0 (r3-High-2). */
    netUsd: number | null;
    grossUsd: number | null;
    excessUsd: number | null;
    rows: number;
    uncostedRows: number;
    basis: { kind: 'tier' | 'model'; label: string; model: string };
  } | null;
}

/** Max analytics window — bounds the *range* (not row count) so a pathological
 * request can't span the whole table (400 days). */
const MAX_RANGE_MS = 400 * 86_400_000;
const DEFAULT_BREAKDOWN_LIMIT = 10;
const DEFAULT_REQUESTS_LIMIT = 50;

/** A request-log row for the dashboard — the enriched analytics row minus the
 * ownership columns (never leave the server). */
export type SafeRequestRow = Omit<AnalyticsRequestRow, 'ownerUserId' | 'orgId'>;
export interface RequestsPageView {
  rows: SafeRequestRow[];
  nextCursor: string | null;
}

@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(PERSISTENCE_PORT) private readonly db: PersistencePort,
    private readonly pricing: PricingService,
  ) {}

  summary(principal: Principal, q: SummaryQueryDto): Promise<AnalyticsSummary> {
    return this.db.analytics.summary(principal, this.parseRange(q.from, q.to));
  }

  timeseries(principal: Principal, q: TimeseriesQueryDto): Promise<AnalyticsTimeseriesPoint[]> {
    return this.db.analytics.timeseries(
      principal,
      this.parseRange(q.from, q.to),
      q.bucket ?? 'day',
    );
  }

  /** Auto-performance aggregation (add-auto-performance-view). The savings
   * counterfactual basis is the CURRENT `auto_high` target (the same
   * deterministic rule ordering the routers use), priced live via the pricing
   * service — a labeled display hypothetical, never persisted (invariant 4). */
  async autoPerformance(principal: Principal, q: AutoQueryDto): Promise<AutoPerformanceView> {
    const range = this.parseRange(q.from, q.to);
    const basis = await this.resolveAutoHighBasis(principal);
    const data = await this.db.analytics.autoPerformance(
      principal,
      range,
      q.bucket ?? 'day',
      basis?.rates ?? null,
    );
    return {
      ...data,
      savings:
        data.savings !== null && basis !== null
          ? {
              netUsd: data.savings.netMicros === null ? null : data.savings.netMicros / 1_000_000,
              grossUsd:
                data.savings.grossMicros === null ? null : data.savings.grossMicros / 1_000_000,
              excessUsd:
                data.savings.excessMicros === null ? null : data.savings.excessMicros / 1_000_000,
              rows: data.savings.rows,
              uncostedRows: data.savings.uncostedRows,
              basis: basis.basis,
            }
          : null,
    };
  }

  /** Resolve the current `auto_high` target to a priced counterfactual basis:
   * tier target → its position-0 primary model; model target → that model.
   * Null when no rule / unresolvable target / unpriced model. */
  private async resolveAutoHighBasis(principal: Principal): Promise<{
    rates: AutoCounterfactualRates;
    basis: { kind: 'tier' | 'model'; label: string; model: string };
  } | null> {
    const rules = (await this.db.routingRules.list(principal))
      .filter((r) => r.matchType === 'auto_high')
      .sort(ruleOrder);
    const rule = rules[0];
    if (rule === undefined) return null;
    const target = parseRoutingTarget(rule.target);
    if (target === null) return null;
    let modelId: string | null;
    let basisMeta: { kind: 'tier' | 'model'; label: string };
    if (target.kind === 'tier') {
      const tier = (await this.db.tiers.list(principal)).find((t) => t.key === target.key);
      if (tier === undefined) return null;
      const entries = await this.db.routingEntries.listForTier(principal, tier.id);
      const primary = entries.find((e) => e.position === 0);
      if (primary === undefined) return null;
      modelId = primary.modelId;
      basisMeta = { kind: 'tier', label: target.key };
    } else {
      modelId = target.id;
      basisMeta = { kind: 'model', label: target.id };
    }
    if (modelId === null) return null;
    const model = await this.db.models.findById(principal, modelId);
    if (model === null) return null;
    const provider = await this.db.providers.findById(principal, model.providerId);
    if (provider === null) return null;
    const price = await this.pricing.resolveForModel(
      {
        externalModelId: model.externalModelId,
        inputPricePer1m: model.inputPricePer1m,
        outputPricePer1m: model.outputPricePer1m,
        isFree: model.isFree,
      },
      provider.baseUrl,
      provider.kind,
      new Date(),
    );
    if (price === null || price.inputPricePer1m == null || price.outputPricePer1m == null) {
      return null; // unpriced basis — unknown never becomes a number
    }
    return {
      rates: {
        inputPer1m: price.inputPricePer1m,
        outputPer1m: price.outputPricePer1m,
        cacheReadPer1m: price.cacheReadPricePer1m ?? null,
        cacheWritePer1m: price.cacheWritePricePer1m ?? null,
      },
      basis: {
        kind: basisMeta.kind,
        label: basisMeta.kind === 'model' ? model.externalModelId : basisMeta.label,
        model: model.externalModelId,
      },
    };
  }

  breakdown(principal: Principal, q: BreakdownQueryDto): Promise<AnalyticsBreakdownRow[]> {
    return this.db.analytics.breakdown(
      principal,
      this.parseRange(q.from, q.to),
      q.dimension,
      q.limit ?? DEFAULT_BREAKDOWN_LIMIT,
    );
  }

  async listRequests(principal: Principal, q: RequestsQueryDto): Promise<RequestsPageView> {
    const range = this.parseRange(q.from, q.to);
    const page = await this.db.analytics.listRequests(principal, {
      from: range.from,
      to: range.to,
      limit: q.limit ?? DEFAULT_REQUESTS_LIMIT,
      ...(q.cursor !== undefined ? { cursor: this.parseCursor(q.cursor) } : {}),
      ...(q.status !== undefined ? { status: q.status } : {}),
      ...(q.layer !== undefined ? { decisionLayers: q.layer } : {}),
      ...(q.escalated !== undefined ? { escalated: q.escalated } : {}),
    });
    return { rows: page.rows.map(toSafeRequest), nextCursor: page.nextCursor };
  }

  /** Semantic range validation (422) — the DTO already guaranteed ISO strings. */
  private parseRange(fromStr: string, toStr: string): AnalyticsRange {
    const from = new Date(fromStr);
    const to = new Date(toStr);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new UnprocessableEntityException('invalid from/to');
    }
    if (from.getTime() >= to.getTime()) {
      throw new UnprocessableEntityException('from must be before to');
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
      throw new UnprocessableEntityException('range exceeds the maximum window');
    }
    return { from, to };
  }

  /** Decode + validate a keyset cursor (`base64 "<iso>|<id>"`); malformed → 422. */
  private parseCursor(raw: string): AnalyticsRequestsCursor {
    let decoded: string;
    try {
      decoded = Buffer.from(raw, 'base64').toString('utf8');
    } catch {
      throw new UnprocessableEntityException('invalid cursor');
    }
    const sep = decoded.indexOf('|');
    if (sep <= 0) throw new UnprocessableEntityException('invalid cursor');
    // The full-precision timestamp TEXT (bound back as ::timestamptz in the query).
    // Validate the exact server-emitted grammar (ISO-8601, UTC, µs) so a malformed
    // or crafted cursor is a clean 422, never a downstream cast 500 (E3).
    const createdAt = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    const wellFormed = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(createdAt);
    if (!wellFormed || Number.isNaN(new Date(createdAt).getTime()) || id.length === 0) {
      throw new UnprocessableEntityException('invalid cursor');
    }
    return { createdAt, id };
  }
}

function toSafeRequest(r: AnalyticsRequestRow): SafeRequestRow {
  const { ownerUserId: _owner, orgId: _org, ...safe } = r;
  return safe;
}
