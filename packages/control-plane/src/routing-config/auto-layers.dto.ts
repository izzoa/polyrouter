import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

/** The tenant's auto-layer preference (#20) — a full replacement of the layer
 * flags. `cascade → structural` and `semantic → structural` are normalized in
 * the upsert. `semantic` (add-semantic-routing) and `calibration`
 * (add-auto-threshold-calibration) are OPTIONAL — omission PRESERVES the
 * stored flag, so an older client replaying only structural/cascade can never
 * silently flip them. */
export class AutoLayersDto {
  @IsBoolean()
  structural!: boolean;

  @IsBoolean()
  cascade!: boolean;

  @IsOptional()
  @IsBoolean()
  semantic?: boolean;

  @IsOptional()
  @IsBoolean()
  calibration?: boolean;
}

/** History pagination (add-auto-threshold-calibration): default 20, cap 100,
 * anything non-integer/out-of-range → 400. */
export class CalibrationHistoryQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
