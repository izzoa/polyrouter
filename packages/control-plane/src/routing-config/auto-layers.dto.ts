import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

/** The tenant's auto-layer preference (#20) — a full replacement of the two
 * layer flags. `cascade → structural` is normalized in the service.
 * `calibration` (add-auto-threshold-calibration) is OPTIONAL — omission
 * PRESERVES the stored flag, so an older client replaying only the layer
 * flags can never silently disable calibration. */
export class AutoLayersDto {
  @IsBoolean()
  structural!: boolean;

  @IsBoolean()
  cascade!: boolean;

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
