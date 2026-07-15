import {
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { EVENT_TYPES, type EventType } from './notification.types';

const KINDS = ['smtp', 'apprise'] as const;
type ChannelKind = (typeof KINDS)[number];

/** The kind-specific `config` object is validated by kind in the service
 * (`validateChannelConfig`) — here it is only shape-gated as an object; the
 * global `ValidationPipe` (whitelist) strips unknown top-level fields. */
export class CreateChannelDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsIn(KINDS)
  kind!: ChannelKind;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsArray()
  @IsIn(EVENT_TYPES, { each: true })
  eventsSubscribed!: EventType[];

  @IsObject()
  config!: Record<string, unknown>;
}

export class UpdateChannelDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsIn(KINDS)
  kind?: ChannelKind;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsArray()
  @IsIn(EVENT_TYPES, { each: true })
  eventsSubscribed?: EventType[];

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}
