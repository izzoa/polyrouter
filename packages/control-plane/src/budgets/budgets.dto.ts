import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  MinLength,
} from 'class-validator';

const SCOPES = ['global', 'agent'] as const;
const WINDOWS = ['day', 'week', 'month'] as const;
const ACTIONS = ['alert', 'block'] as const;
/** What a budget meters (split-subscription-spend). `cash` = money owed; `notional`
 * additionally counts prepaid subscription traffic at the vendor's API rate. */
const BASES = ['cash', 'notional'] as const;
type BudgetScope = (typeof SCOPES)[number];
type BudgetWindow = (typeof WINDOWS)[number];
type BudgetAction = (typeof ACTIONS)[number];
type MeteringBasis = (typeof BASES)[number];

/** USD ceiling matching the DB `budget_amount_range` check — `round(amount×1e6)`
 * stays a JS-safe integer (µ$). */
const MAX_AMOUNT = 1_000_000_000;

export class CreateBudgetDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsIn(SCOPES)
  scope!: BudgetScope;

  /** The cross-field "agent scope requires an agentId" rule is enforced in the
   * service (→ 422), not here, so a missing agentId is a business rejection rather
   * than a malformed-input 400. */
  @IsOptional()
  @IsString()
  agentId?: string;

  @IsIn(WINDOWS)
  window!: BudgetWindow;

  @IsIn(ACTIONS)
  action!: BudgetAction;

  /** Omitted → `cash`. Existing budgets were migrated to `notional` to preserve their
   * enforcement; a NEW budget defaults to metering money owed. */
  @IsOptional()
  @IsIn(BASES)
  meteringBasis?: MeteringBasis;

  @IsNumber()
  @IsPositive()
  @Max(MAX_AMOUNT)
  amount!: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  notifyChannelIds?: string[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateBudgetDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsIn(SCOPES)
  scope?: BudgetScope;

  @IsOptional()
  @IsString()
  agentId?: string;

  @IsOptional()
  @IsIn(WINDOWS)
  window?: BudgetWindow;

  @IsOptional()
  @IsIn(ACTIONS)
  action?: BudgetAction;

  @IsOptional()
  @IsIn(BASES)
  meteringBasis?: MeteringBasis;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Max(MAX_AMOUNT)
  amount?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  notifyChannelIds?: string[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
