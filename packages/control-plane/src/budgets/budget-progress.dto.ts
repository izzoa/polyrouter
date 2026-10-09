import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';
import { BUDGET_PROGRESS_MAX_ID_LENGTH, BUDGET_PROGRESS_MAX_IDS } from '@polyrouter/shared';

export class BudgetProgressQueryDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',').map((id) => id.trim()) : [],
  )
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BUDGET_PROGRESS_MAX_IDS)
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(BUDGET_PROGRESS_MAX_ID_LENGTH, { each: true })
  ids!: string[];
}
