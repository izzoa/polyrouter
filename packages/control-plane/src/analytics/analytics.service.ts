import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ruleOrder } from '@polyrouter/data-plane';
import {
  PERSISTENCE_PORT,
  decryptSecret,
  parseRoutingTarget,
  type AnalyticsBreakdownRow,
  type AnalyticsRange,
  type AnalyticsRequestRow,
  type AnalyticsRequestsCursor,
  type AnalyticsSummary,
  type AnalyticsTimeseriesPoint,
  type AutoCounterfactualRates,
  type AutoPerformanceData,
  type CalibrationEvidenceEntry,
  type PersistencePort,
  type Principal,
} from '@polyrouter/shared/server';
import { PricingService } from '../pricing/pricing.service';
import { BODY_CAPTURE_CONFIG, type BodyCaptureConfig } from '../body-capture/body-capture.config';
import {
  ROUTING_CONFIG,
  effectiveThresholds,
  type RoutingConfig,
} from '../proxy/routing.config';
import {
  CALIBRATION_CONFIG,
  CALIBRATION_RAILS,
  EDGE_WIDTH,
  calibrationHalted,
  RATE_HIGH,
  RATE_LOW,
  type CalibrationConfig,
  type CalibrationRails,
} from '../calibration/calibration.config';
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
  /** Per-agent calibration evidence (add-per-agent-calibration-evidence).
   * Additive; carries its own (calibration) window, so it does NOT follow the
   * range every other figure on this response uses. */
  calibrationEvidence: CalibrationEvidenceView;
  savings: {
    /** Null when zero rows were costable — unknown, never $0 (r3-High-2). */
    netUsd: number | null;
    grossUsd: number | null;
    excessUsd: number | null;
    rows: number;
    uncostedRows: number;
    basis: { kind: 'tier' | 'model'; label: string; model: string; scoped: boolean };
  } | null;
}

/** The calibration-evidence block (add-per-agent-calibration-evidence). Carries
 * its OWN window bounds, because it is calibration-window-scoped rather than
 * range-scoped, and the rails a reader needs to interpret its counts: without
 * `actingFloor` a consumer hardcodes 50, and without the decision rates a count
 * shown against that floor implies that reaching it causes a move. */
export interface CalibrationEvidenceView {
  window: { from: string; to: string; days: number };
  high: number;
  low: number;
  edgeWidth: number;
  actingFloor: number;
  rateHigh: number;
  rateLow: number;
  calibrationEpoch: number;
  /** The most recent threshold event's timestamp; null when there has never been
   * one. The clock the arrival rate of current-epoch evidence is measured against. */
  epochStartedAt: string | null;
  enabled: boolean;
  /** The calibrator would decline to evaluate this tenant at all — contracted
   * edge zones, or a degenerate instance pair. Reporting counts without this
   * asserts a readiness that does not exist (fix-calibration-evidence-honesty). */
  contracted: boolean;
  /** The agent list is a bounded top-N; the TOTAL is still over every agent. */
  truncated: boolean;
  total: CalibrationEvidenceEntry;
  agents: CalibrationEvidenceEntry[];
}

/** Max analytics window — bounds the *range* (not row count) so a pathological
 * request can't span the whole table (400 days). */
const MAX_RANGE_MS = 400 * 86_400_000;
const DEFAULT_BREAKDOWN_LIMIT = 10;
const DEFAULT_REQUESTS_LIMIT = 50;

/** A request-log row for the dashboard — the enriched analytics row minus the
 * ownership columns (never leave the server), plus the body-capture existence
 * flag (add-body-capture; content NEVER rides the listing). */
export type SafeRequestRow = Omit<AnalyticsRequestRow, 'ownerUserId' | 'orgId'> & {
  hasBodies: boolean;
};
export interface RequestsPageView {
  rows: SafeRequestRow[];
  nextCursor: string | null;
}

/** One stored body direction, decrypted ON READ for the inspector's lazily
 * fetched Payload section (add-body-capture). */
export interface RequestBodyContentView {
  direction: 'request' | 'response';
  content: string;
  bytes: number;
  truncated: boolean;
  partial: boolean;
}

@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(PERSISTENCE_PORT) private readonly db: PersistencePort,
    private readonly pricing: PricingService,
    @Inject(BODY_CAPTURE_CONFIG) private readonly bodyCfg: BodyCaptureConfig,
    @Inject(ROUTING_CONFIG) private readonly routingCfg: RoutingConfig,
    @Inject(CALIBRATION_CONFIG) private readonly calibrationCfg: CalibrationConfig,
    @Inject(CALIBRATION_RAILS) private readonly calibrationRails: CalibrationRails,
  ) {}

  /**
   * Per-agent calibration evidence (add-per-agent-calibration-evidence).
   *
   * Computed over the CALIBRATION window — `CALIBRATION_WINDOW_DAYS` ending now —
   * and NOT the caller's `from`/`to`. The calibrator reads a fixed rolling window;
   * the endpoint's range is caller-chosen from an hour to a year. Reporting the
   * caller's range would agree with `calibrationStats` on any fixture seeded with
   * matching bounds and diverge in production the moment someone picks "24 hours",
   * which is the precise failure this block exists to avoid.
   *
   * The geometry comes from the SAME `effectiveThresholds` call the calibrator and
   * the hot path use — three callers, one formula — so a calibrated tenant's
   * reported thresholds cannot drift from the ones that decided its rows.
   */
  async calibrationEvidence(
    principal: Principal,
    now = Date.now(),
  ): Promise<CalibrationEvidenceView> {
    const pref = await this.db.routingSettings.get(principal);
    const eff = effectiveThresholds(this.routingCfg.structural, pref, this.calibrationRails);
    const epoch = pref?.calibrationEpoch ?? 0;
    // Anchor the window to the containing MINUTE, and query the same bounds we
    // report. A window derived from a raw `Date.now()` moves every millisecond,
    // which makes two reads of this endpoint differ for a reason that has nothing
    // to do with the data — it churns the rendered bounds on every dashboard poll
    // and makes the response impossible to compare. The cost is that the reported
    // window trails the calibrator's exact rolling window by under a minute, on a
    // window 14 days long.
    const anchor = Math.floor(now / 60_000) * 60_000;
    const from = new Date(anchor - this.calibrationCfg.windowDays * 86_400_000);
    const to = new Date(anchor);
    const [data, epochStartedAt] = await Promise.all([
      this.db.analytics.calibrationEvidence(
        principal,
        { from, to },
        { high: eff.high, low: eff.low, edgeWidth: EDGE_WIDTH, epoch },
      ),
      // The epoch's birth is the most recent threshold event; null when the
      // tenant has never had one. Without it the ARRIVAL RATE of current
      // evidence is not computable, and that rate is the number this block
      // exists to supply.
      this.db.calibrationEvents
        .list(principal, 1)
        .then((rows) => rows[0]?.createdAt ?? null)
        .catch(() => null),
    ]);
    return {
      window: { from: from.toISOString(), to: to.toISOString(), days: this.calibrationCfg.windowDays },
      high: eff.high,
      low: eff.low,
      edgeWidth: EDGE_WIDTH,
      // Runtime-configurable and scheduled to change in SQ-2 — a consumer that
      // hardcoded it would break silently the day that lands.
      actingFloor: this.calibrationCfg.minEdgeSamples,
      rateHigh: RATE_HIGH,
      rateLow: RATE_LOW,
      calibrationEpoch: epoch,
      epochStartedAt,
      enabled: pref?.calibrationEnabled ?? false,
      // From the calibrator's OWN predicate, shared rather than restated.
      contracted: calibrationHalted(this.routingCfg.structural, eff, this.calibrationRails),
      truncated: data.truncated,
      total: data.total,
      agents: data.agents,
    };
  }

  private get credentialKey(): string {
    return this.bodyCfg.credentialKey;
  }

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
    const [data, calibrationEvidence] = await Promise.all([
      this.db.analytics.autoPerformance(principal, range, q.bucket ?? 'day', basis?.rates ?? null),
      this.calibrationEvidence(principal),
    ]);
    return {
      ...data,
      calibrationEvidence,
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
    basis: { kind: 'tier' | 'model'; label: string; model: string; scoped: boolean };
  } | null> {
    const all = await this.db.routingRules.list(principal);
    // The basis is the GENERIC (unscoped) strong target (add-workload-scoped-
    // bands): a class-scoped `auto_high` rule — however high its priority —
    // never moves the tenant-wide counterfactual; `scoped` tells the consumer
    // that class-scoped band rules exist, so the basis does not separate
    // class-scoped traffic.
    const scoped = all.some(
      (r) => (r.matchType === 'auto_high' || r.matchType === 'auto_low') && r.workloadClass != null,
    );
    const rules = all
      .filter((r) => r.matchType === 'auto_high' && r.workloadClass == null)
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
        listedInputPricePer1m: model.listedInputPricePer1m,
        listedOutputPricePer1m: model.listedOutputPricePer1m,
        listedIsFree: model.listedIsFree,
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
        scoped,
      },
    };
  }

  breakdown(principal: Principal, q: BreakdownQueryDto): Promise<AnalyticsBreakdownRow[]> {
    return this.db.analytics.breakdown(
      principal,
      this.parseRange(q.from, q.to),
      q.dimension,
      q.limit ?? DEFAULT_BREAKDOWN_LIMIT,
      q.metric ?? 'spend',
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
      ...(q.mode !== undefined ? { mode: q.mode } : {}),
      ...(q.batchId !== undefined ? { batchId: q.batchId } : {}),
      ...(q.agentId !== undefined ? { agentId: q.agentId } : {}),
    });
    // ONE batched existence read for the page (no N+1, no content).
    const withBodies = await this.db.bodyCapture.existsForRequests(
      principal,
      page.rows.map((r) => r.id),
    );
    return {
      rows: page.rows.map((r) => ({ ...toSafeRequest(r), hasBodies: withBodies.has(r.id) })),
      nextCursor: page.nextCursor,
    };
  }

  /** Decrypt-on-read bodies for ONE owned request; 404 when none/foreign. */
  async requestBodies(principal: Principal, id: string): Promise<RequestBodyContentView[]> {
    const rows = await this.db.bodyCapture.listForRequest(principal, id);
    if (rows.length === 0) throw new NotFoundException('no stored bodies for this request');
    return rows.map((r) => ({
      direction: r.direction,
      content: decryptSecret(r.contentEncrypted, this.credentialKey),
      bytes: r.bytes,
      truncated: r.truncated,
      partial: r.partial,
    }));
  }

  /** Owner-scoped delete + tombstone; 404 for an unknown/foreign request. */
  async deleteRequestBodies(principal: Principal, id: string): Promise<{ ok: true }> {
    const ok = await this.db.bodyCapture.deleteForRequest(principal, id);
    if (!ok) throw new NotFoundException('request not found');
    return { ok: true };
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

function toSafeRequest(r: AnalyticsRequestRow): Omit<SafeRequestRow, 'hasBodies'> {
  const { ownerUserId: _owner, orgId: _org, ...safe } = r;
  return safe;
}
