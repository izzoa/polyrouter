import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  MAX_MODELS_PER_TIER,
  RULE_MATCH_TYPES,
  TIER_KEY_PATTERN,
  type RuleMatchType,
} from '@polyrouter/shared/server';

// `priority` is stored in an int4 column; bound it so an oversized value is a
// clean 4xx, never an insert-time overflow 500.
const PRIORITY_MAX = 1_000_000;

/** Validate a field only when it is PRESENT (E10.1). Unlike `@IsOptional()`
 * (which skips validators for BOTH `undefined` and `null`), this still runs them
 * for an explicit `null` — so a non-nullable field sent as `null` is a clean 4xx
 * rather than a downstream TypeError / NOT NULL 500. */
const IfDefined = (): PropertyDecorator => ValidateIf((_o, v) => v !== undefined);

export class CreateTierDto {
  // Pattern also bounds length (1–64) and charset (lowercase slug).
  @Matches(TIER_KEY_PATTERN, { message: 'key must be a lowercase slug (1–64 chars)' })
  key!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

// No `key` — a tier key is immutable after creation.
export class UpdateTierDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class ReplaceEntriesDto {
  @IsArray()
  @ArrayMaxSize(MAX_MODELS_PER_TIER, {
    message: `a tier holds at most ${MAX_MODELS_PER_TIER} models`,
  })
  @IsString({ each: true })
  modelIds!: string[];
}

export class CreateRuleDto {
  @IsIn(RULE_MATCH_TYPES)
  matchType!: RuleMatchType;

  // Optional on create; defaults to the tier header (normalized in the service).
  @IfDefined()
  @IsString()
  @MaxLength(128)
  headerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  headerValue?: string;

  // Structured reference: `tier:<key>` or `model:<id>` (validated in the service).
  @IsString()
  @MinLength(1)
  @MaxLength(320)
  target!: string;

  @IfDefined()
  @IsInt()
  @Min(0)
  @Max(PRIORITY_MAX)
  priority?: number;
}

// Every field optional — the service validates the effective merged row.
export class UpdateRuleDto {
  @IfDefined()
  @IsIn(RULE_MATCH_TYPES)
  matchType?: RuleMatchType;

  @IfDefined()
  @IsString()
  @MaxLength(128)
  headerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  headerValue?: string;

  @IfDefined()
  @IsString()
  @MinLength(1)
  @MaxLength(320)
  target?: string;

  @IfDefined()
  @IsInt()
  @Min(0)
  @Max(PRIORITY_MAX)
  priority?: number;
}
