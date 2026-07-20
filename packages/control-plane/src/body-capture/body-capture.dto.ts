import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min, ValidateIf } from 'class-validator';

export class BodyCaptureUpdateDto {
  @IsOptional()
  @IsIn(['off', 'errors_only', 'all'])
  mode?: 'off' | 'errors_only' | 'all';

  /** null = infinite — legal ONLY alongside `keepForever: true` (service-enforced). */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(3650)
  retentionDays?: number | null;

  @IsOptional()
  @IsBoolean()
  keepForever?: boolean;
}

export class AgentOverrideDto {
  /** null clears the override back to inherit. */
  @ValidateIf((_, v) => v !== null)
  @IsIn(['always', 'never'])
  override!: 'always' | 'never' | null;
}
