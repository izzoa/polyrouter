import { DECISION_LAYERS } from '@polyrouter/data-plane';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export const ANALYTICS_BUCKETS = ['hour', 'day', 'week', 'month'] as const;
export const ANALYTICS_DIMENSIONS = ['model', 'provider', 'agent', 'tier'] as const;
/** What a breakdown is RANKED and truncated by. Defaults to spend, so a caller that
 * predates this parameter is unaffected. `requests` (add-agent-request-attribution)
 * ranks by served request count — without it a request-volume view inherits a spend
 * ranking and silently truncates its highest-volume, lowest-cost rows. */
export const ANALYTICS_METRICS = ['spend', 'tokens', 'requests'] as const;

/** Query-string int → number (validated by `@IsInt` after). */
const toInt = ({ value }: { value: unknown }): unknown =>
  value === undefined || value === '' ? undefined : Number(value);
/** Query-string `'true'`/`'false'` → boolean. */
const toBool = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;
/** Comma-separated `layer` → trimmed string[]; empty/whitespace segments survive
 * as `''` so `@IsNotEmpty({ each })` rejects them (400). */
const toLayers = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.split(',').map((s) => s.trim()) : value;

/** ISO `from`/`to` are DTO-validated (400 on a non-ISO string); the `from < to`
 * + max-window semantics are enforced in the service (422). */
class RangeQueryDto {
  @IsISO8601()
  from!: string;

  @IsISO8601()
  to!: string;
}

export class SummaryQueryDto extends RangeQueryDto {}

export class TimeseriesQueryDto extends RangeQueryDto {
  @IsOptional()
  @IsIn(ANALYTICS_BUCKETS)
  bucket?: (typeof ANALYTICS_BUCKETS)[number];
}

export class AutoQueryDto extends RangeQueryDto {
  @IsOptional()
  @IsIn(ANALYTICS_BUCKETS)
  bucket?: (typeof ANALYTICS_BUCKETS)[number];
}

export class BreakdownQueryDto extends RangeQueryDto {
  @IsIn(ANALYTICS_DIMENSIONS)
  dimension!: (typeof ANALYTICS_DIMENSIONS)[number];

  @IsOptional()
  @IsIn(ANALYTICS_METRICS)
  metric?: (typeof ANALYTICS_METRICS)[number];

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class RequestsQueryDto extends RangeQueryDto {
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @Transform(toLayers)
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(16)
  // Each element must be a known decision layer (add-semantic-routing Low-1):
  // an unknown value is a 400, not a silently-empty filter.
  @IsIn(DECISION_LAYERS, { each: true })
  layer?: string[];

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  escalated?: boolean;

  /** add-batch-inference: partition by execution mode. */
  @IsOptional()
  @IsIn(['sync', 'batch'])
  mode?: 'sync' | 'batch';

  /** add-batch-inference: one owned job's settled items. */
  @IsOptional()
  @IsString()
  batchId?: string;

  /** add-agent-request-attribution: restrict to rows whose RECORDED `agent_id`
   * equals this. Applied INSIDE the owner scope, never instead of it — so a
   * foreign id can only ever match the caller's own denormalized rows.
   * `@IsOptional()` skips null/undefined but NOT `''`, so `?agentId=` falls
   * through to `@IsNotEmpty` and is a 400 rather than a silently-ignored
   * filter (the `layer` precedent). */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  agentId?: string;
}
