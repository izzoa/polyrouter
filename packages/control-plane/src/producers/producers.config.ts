import { loadConfig, registerConfig, z } from '@polyrouter/shared';
import type { BaseConfig } from '@polyrouter/shared';
import type { AllowedEndpoint } from '@polyrouter/shared/server';
import { parseAllowedEndpoints } from '../notifications/notify.config';

/** Notification-producer config (#15b, spec §10.1/§12). Server-wide `SMTP_*`
 * defaults power the password-reset mailer (the reset email has no channel);
 * the spike counter + weekly scheduler are tuned here. All optional — producers
 * degrade to no-op when unconfigured. */

const SECURE = z.enum(['none', 'starttls', 'tls']);

registerConfig(
  'producers',
  z.object({
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_FROM: z.string().optional(),
    SMTP_SECURE: SECURE.default('starttls'),
    NOTIFY_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(20),
    NOTIFY_FAILURE_WINDOW_MS: z.coerce.number().int().min(1000).default(900_000),
    NOTIFY_WEEKLY_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === 'true'),
    NOTIFY_WEEKLY_CRON: z.string().default('0 8 * * 1'),
  }),
);

export const PRODUCERS_CONFIG = 'polyrouter:producers-config';

export type ProducersRawConfig = {
  SMTP_HOST?: string;
  SMTP_PORT: number;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  SMTP_FROM?: string;
  SMTP_SECURE: 'none' | 'starttls' | 'tls';
  NOTIFY_FAILURE_THRESHOLD: number;
  NOTIFY_FAILURE_WINDOW_MS: number;
  NOTIFY_WEEKLY_ENABLED: boolean;
  NOTIFY_WEEKLY_CRON: string;
  NOTIFY_ALLOWED_ENDPOINTS?: string; // shared with #15a's notify config
};

/** Server-wide SMTP settings, present only when a host + from-address are set. */
export interface SystemSmtp {
  readonly host: string;
  readonly port: number;
  readonly secure: 'none' | 'starttls' | 'tls';
  readonly user?: string;
  readonly pass?: string;
  readonly from: string;
}

/** The resolved config the producers depend on. */
export interface ProducersConfig {
  readonly mode: 'selfhosted' | 'cloud';
  readonly allowedEndpoints: AllowedEndpoint[];
  readonly systemSmtp: SystemSmtp | undefined;
  readonly failureThreshold: number;
  readonly failureWindowMs: number;
  readonly weeklyEnabled: boolean;
  readonly weeklyCron: string;
}

/** SMTP is usable only with a host AND a from-address. */
export function resolveSystemSmtp(cfg: ProducersRawConfig): SystemSmtp | undefined {
  if (!cfg.SMTP_HOST || !cfg.SMTP_FROM) return undefined;
  return {
    host: cfg.SMTP_HOST,
    port: cfg.SMTP_PORT,
    secure: cfg.SMTP_SECURE,
    ...(cfg.SMTP_USER !== undefined ? { user: cfg.SMTP_USER } : {}),
    ...(cfg.SMTP_PASS !== undefined ? { pass: cfg.SMTP_PASS } : {}),
    from: cfg.SMTP_FROM,
  };
}

export function resolveProducersConfig(): ProducersConfig {
  const all = loadConfig<ProducersRawConfig & BaseConfig>();
  return {
    mode: all.MODE,
    allowedEndpoints: parseAllowedEndpoints(all.NOTIFY_ALLOWED_ENDPOINTS),
    systemSmtp: resolveSystemSmtp(all),
    failureThreshold: all.NOTIFY_FAILURE_THRESHOLD,
    failureWindowMs: all.NOTIFY_FAILURE_WINDOW_MS,
    weeklyEnabled: all.NOTIFY_WEEKLY_ENABLED,
    weeklyCron: all.NOTIFY_WEEKLY_CRON,
  };
}
