import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import {
  PERSISTENCE_PORT,
  type AnalyticsBreakdownRow,
  type AnalyticsRange,
  type AnalyticsRequestRow,
  type AnalyticsRequestsCursor,
  type AnalyticsSummary,
  type AnalyticsTimeseriesPoint,
  type PersistencePort,
  type Principal,
} from '@polyrouter/shared/server';
import type {
  BreakdownQueryDto,
  RequestsQueryDto,
  SummaryQueryDto,
  TimeseriesQueryDto,
} from './analytics.dto';

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
  constructor(@Inject(PERSISTENCE_PORT) private readonly db: PersistencePort) {}

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
      ...(q.layer !== undefined ? { decisionLayer: q.layer } : {}),
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
    const createdAt = new Date(decoded.slice(0, sep));
    const id = decoded.slice(sep + 1);
    if (Number.isNaN(createdAt.getTime()) || id.length === 0) {
      throw new UnprocessableEntityException('invalid cursor');
    }
    return { createdAt, id };
  }
}

function toSafeRequest(r: AnalyticsRequestRow): SafeRequestRow {
  const { ownerUserId: _owner, orgId: _org, ...safe } = r;
  return safe;
}
