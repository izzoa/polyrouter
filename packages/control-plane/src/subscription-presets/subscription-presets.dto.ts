import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

/** The longest key a connect accepts: the same bound as a provider's pasted credential. */
export const MAX_KEY_PRESET_CREDENTIAL_LEN = 8192;

/** Printable Latin-1 only: no C0 control characters, DEL or anything above U+00FF. A pasted
 * key never contains one, and one would corrupt (or fail to build) the `Authorization`
 * header it is later sent in, so every later upstream call would fail. */
// eslint-disable-next-line no-control-regex -- the control range IS what this rejects
const NO_CONTROL_CHARS = /^[^\u0000-\u001f\u007f-\uffff]*$/;

/**
 * The key-preset connect body (add-key-subscription-presets, design D7 step 1). Under the
 * global whitelist + forbid pipe these six fields are the ONLY accepted input: no
 * `baseUrl`, `protocol`, `kind`, `keyPreset` or identity value can ride along (the identity
 * opt-in is a boolean, add-key-preset-identity-optin), so a
 * request can never redirect a preset's endpoint or forge its marker. `credential` is
 * CREDENTIAL MATERIAL — validated for shape here, encrypted by the service, and never
 * logged or echoed.
 */
export class KeyPresetConnectDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  preset!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  region?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_KEY_PRESET_CREDENTIAL_LEN)
  @Matches(NO_CONTROL_CHARS, { message: 'credential must be printable Latin-1 characters' })
  credential!: string;

  /** Required `true` for a high-risk preset (design D8). Never stored. An explicit `null`
   * is a 400 (the `UpdateProviderDto` idiom, no `IsOptional`). */
  @ValidateIf((_, v) => v !== undefined)
  @IsBoolean()
  acknowledgeTermsRisk?: boolean;

  /** The identity-imitation opt-in (add-key-preset-identity-optin, design D1): the same field
   * and validation as the OAuth connect start. Absent means off; an explicit `null` is a 400;
   * `true` is a 422 unless the preset declares a client identity. A boolean only — no field
   * can name a header or its value. */
  @ValidateIf((_, v) => v !== undefined)
  @IsBoolean()
  imitateClientIdentity?: boolean;
}
