import { HARNESS_TYPES, type HarnessType } from '@polyrouter/shared';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateAgentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsIn(HARNESS_TYPES)
  harness!: HarnessType;
}
