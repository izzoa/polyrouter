import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';

export const PROVIDER_KINDS = ['api_key', 'subscription', 'custom', 'local'] as const;
export const PROVIDER_PROTOCOLS = ['openai_compatible', 'anthropic_compatible'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];
export type ProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number];

const urlOpts = { protocols: ['http', 'https'], require_protocol: true };

export class CreateProviderDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsIn(PROVIDER_KINDS)
  kind!: ProviderKind;

  @IsIn(PROVIDER_PROTOCOLS)
  protocol!: ProviderProtocol;

  // Address safety (private/metadata, userinfo, query/fragment) is enforced by
  // the service's SSRF gate — this only checks URL shape.
  @IsUrl(urlOpts)
  baseUrl!: string;

  @IsOptional()
  @IsString()
  @MaxLength(8192)
  credential?: string;
}

export class UpdateProviderDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsIn(PROVIDER_KINDS)
  kind?: ProviderKind;

  @IsOptional()
  @IsIn(PROVIDER_PROTOCOLS)
  protocol?: ProviderProtocol;

  @IsOptional()
  @IsUrl(urlOpts)
  baseUrl?: string;

  // Present-but-empty clears the stored credential; omitted preserves it.
  @IsOptional()
  @IsString()
  @MaxLength(8192)
  credential?: string;
}

const asBool = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

export class ListModelsQueryDto {
  @IsOptional()
  @IsString()
  providerId?: string;

  @IsOptional()
  @Transform(asBool)
  @IsBoolean()
  isFree?: boolean;

  @IsOptional()
  @Transform(asBool)
  @IsBoolean()
  supportsTools?: boolean;

  @IsOptional()
  @Transform(asBool)
  @IsBoolean()
  supportsVision?: boolean;
}
