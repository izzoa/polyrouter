import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class OverrideDto {
  @IsNumber()
  @Min(0)
  inputPricePer1m!: number;

  @IsNumber()
  @Min(0)
  outputPricePer1m!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  cacheReadPricePer1m?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  cacheWritePricePer1m?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  contextWindow?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxOutputTokens?: number;

  // Batch-tier pair (add-batch-inference). A trusted source may supply it — an
  // operator pricing a batch the catalog does not (LiteLLM carries no
  // anthropic-family pair). Both-or-neither is enforced by the service's
  // trusted-source validation, not here, so the rejection names the rule.
  @IsOptional()
  @IsNumber()
  @Min(0)
  batchInputPricePer1m?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  batchOutputPricePer1m?: number;

  @IsOptional()
  @IsBoolean()
  supportsTools?: boolean;

  @IsOptional()
  @IsBoolean()
  supportsVision?: boolean;

  @IsOptional()
  @IsBoolean()
  supportsReasoning?: boolean;

  @IsOptional()
  @IsBoolean()
  isFree?: boolean;
}

/** One entry in an admin-supplied refresh body. */
export class RefreshEntryDto extends OverrideDto {
  @IsString()
  @MaxLength(200)
  modelKey!: string;
}

export class RefreshDto {
  @IsIn(['bundled', 'body', 'litellm'])
  source!: 'bundled' | 'body' | 'litellm';

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RefreshEntryDto)
  entries?: RefreshEntryDto[];
}
