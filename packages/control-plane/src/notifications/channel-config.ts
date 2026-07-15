import { UnprocessableEntityException } from '@nestjs/common';

/** The kind-specific channel config, held encrypted at rest (#15a). Never
 * returned by the API; decrypted only in the worker/test-send. */
export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: 'none' | 'starttls' | 'tls';
  readonly user?: string;
  readonly pass?: string;
  readonly from: string;
  readonly to: readonly string[];
}
export interface AppriseConfig {
  readonly urls: readonly string[];
}
export type ChannelConfig = SmtpConfig | AppriseConfig;

function str(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** Validate + normalize a raw config by kind (throws 422 on a bad shape). */
export function validateChannelConfig(kind: string, raw: unknown): ChannelConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new UnprocessableEntityException('config is required');
  }
  const c = raw as Record<string, unknown>;
  if (kind === 'smtp') {
    const secure = c['secure'];
    const to = Array.isArray(c['to']) ? c['to'].filter(str) : [];
    if (!str(c['host']) || typeof c['port'] !== 'number' || !str(c['from']) || to.length === 0) {
      throw new UnprocessableEntityException(
        'smtp config requires host, port, from, and at least one recipient',
      );
    }
    if (secure !== 'none' && secure !== 'starttls' && secure !== 'tls') {
      throw new UnprocessableEntityException('smtp secure must be none | starttls | tls');
    }
    return {
      host: c['host'],
      port: c['port'],
      secure,
      ...(str(c['user']) ? { user: c['user'] } : {}),
      ...(str(c['pass']) ? { pass: c['pass'] } : {}),
      from: c['from'],
      to,
    };
  }
  if (kind === 'apprise') {
    const urls = Array.isArray(c['urls']) ? c['urls'].filter(str) : [];
    if (urls.length === 0) {
      throw new UnprocessableEntityException('apprise config requires at least one url');
    }
    return { urls };
  }
  throw new UnprocessableEntityException(`unknown channel kind ${kind}`);
}

/** Parse a decrypted stored config blob (already validated at write time). */
export function parseStoredConfig(kind: string, json: string): ChannelConfig {
  return JSON.parse(json) as ChannelConfig;
}
