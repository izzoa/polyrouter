import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';

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

  /** L2 learning (add-semantic-learning) — OPTIONAL, default OFF; requires
   * semantic effective (dependency-down normalized in the upsert). */
  @IsOptional()
  @IsBoolean()
  semanticLearning?: boolean;

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

  /** Narrow the history to ONE scope (add-per-agent-calibration): an agent id,
   * or the literal `tenant` for the tenant's own events. Omitted returns both
   * in one chronological order, which is what an operator wants by default —
   * a threshold move is a threshold move whichever scope made it. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  scope?: string;
}
