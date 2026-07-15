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
