import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { MAX_PASTE_LEN } from './paste';

export class OauthStartDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  preset!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;
}

/** `pasted` is CREDENTIAL MATERIAL — validated for shape here, parsed defensively in
 * the service, and never logged or echoed anywhere. */
export class OauthCompleteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sessionId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_PASTE_LEN)
  pasted!: string;
}
