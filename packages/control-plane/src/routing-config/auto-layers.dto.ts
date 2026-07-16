import { IsBoolean } from 'class-validator';

/** The tenant's auto-layer preference (#20) — a full replacement (both booleans
 * required). `cascade → structural` is normalized in the service. */
export class AutoLayersDto {
  @IsBoolean()
  structural!: boolean;

  @IsBoolean()
  cascade!: boolean;
}
