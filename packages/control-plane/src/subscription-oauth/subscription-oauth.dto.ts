import { IsBoolean, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
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

  /** Opt the NEW connection into the preset's declared client identity (design D7). Omitted
   * means false; an explicit `null` is a 400 (the `UpdateProviderDto` idiom, no
   * `IsOptional`). `true` is a 422 in the service unless the preset declares an identity.
   * This boolean is the ONLY identity input a connect start accepts: no header names or
   * values, so `forbidNonWhitelisted` rejects `clientIdentity`/`extraHeaders`/`userAgent`. */
  @ValidateIf((_, v) => v !== undefined)
  @IsBoolean()
  imitateClientIdentity?: boolean;
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
