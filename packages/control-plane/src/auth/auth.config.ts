import { isIP } from 'node:net';
import { loadConfig, registerConfig, z } from '@polyrouter/shared';
import type { BaseConfig } from '@polyrouter/shared';

const HEX_64 = /^[0-9a-f]{64}$/i;
const DEV_SECRET_FALLBACK = 'polyrouter-dev-only-not-a-real-secret-do-not-use-in-production00';

registerConfig(
  'auth',
  z.object({
    // Validated as 32-byte hex when present; presence/mode policy is applied
    // by resolveAuthSecrets (a bad *format* still fails here, value un-echoed).
    BETTER_AUTH_SECRET: z
      .string()
      .refine((v) => HEX_64.test(v), { message: 'expected 32-byte hex' })
      .optional(),
    API_KEY_HMAC_SECRET: z
      .string()
      .refine((v) => HEX_64.test(v), { message: 'expected 32-byte hex' })
      .optional(),
    BETTER_AUTH_URL: z.string().url().default('http://127.0.0.1:3001'),
    DASHBOARD_ORIGIN: z.string().url().default('http://localhost:3000'),
    SEED_DATA: z
      .string()
      .optional()
      .transform((v) => v === 'true'),
    TRUSTED_PROXY_CIDRS: z
      .string()
      .optional()
      .transform((v) =>
        v
          ? v
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
      ),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),
    DISCORD_CLIENT_ID: z.string().optional(),
    DISCORD_CLIENT_SECRET: z.string().optional(),
  }),
);

export type AuthConfig = {
  BETTER_AUTH_SECRET?: string;
  API_KEY_HMAC_SECRET?: string;
  BETTER_AUTH_URL: string;
  DASHBOARD_ORIGIN: string;
  SEED_DATA: boolean;
  TRUSTED_PROXY_CIDRS: string[];
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
};

export type OauthProvider = 'google' | 'github' | 'discord';

/** The OAuth providers usable for sign-in — one is listed iff BOTH its client id
 * and secret are set (mirrors better-auth's own conditional wiring). Drives the
 * dashboard login gate (#18 `GET /api/login-config`); returns no secrets. */
export function enabledOauthProviders(cfg: AuthConfig): OauthProvider[] {
  const out: OauthProvider[] = [];
  if (cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET) out.push('google');
  if (cfg.GITHUB_CLIENT_ID && cfg.GITHUB_CLIENT_SECRET) out.push('github');
  if (cfg.DISCORD_CLIENT_ID && cfg.DISCORD_CLIENT_SECRET) out.push('discord');
  return out;
}

export function isLoopbackAddress(address: string): boolean {
  const host = address.replace(/^::ffff:/, '');
  if (host === 'localhost') return true;
  if (isIP(host) === 0) return false;
  return host === '::1' || host.startsWith('127.');
}

export interface ResolvedAuthSecrets {
  betterAuthSecret: string;
  apiKeyHmacSecret: string;
  usedDevFallback: boolean;
}

/**
 * Secrets + dev-convenience gating (session-auth requirement, codex round 2):
 * fixed dev fallbacks are permitted ONLY on a loopback-bound, non-production,
 * self-hosted instance. Anything network-reachable or production requires real
 * secrets. Values are never included in thrown messages.
 */
export function resolveAuthSecrets(
  auth: AuthConfig,
  base: Pick<BaseConfig, 'NODE_ENV' | 'MODE' | 'BIND_ADDRESS'>,
): ResolvedAuthSecrets {
  const loopbackBound = isLoopbackAddress(base.BIND_ADDRESS);
  const devEligible = base.NODE_ENV !== 'production' && base.MODE === 'selfhosted' && loopbackBound;

  const resolve = (name: 'BETTER_AUTH_SECRET' | 'API_KEY_HMAC_SECRET'): string => {
    const provided = auth[name];
    if (provided) return provided;
    if (!devEligible) {
      throw new Error(
        `${name} is required (no dev fallback outside a loopback-bound, non-production self-hosted instance). Set it to 32-byte hex (openssl rand -hex 32).`,
      );
    }
    return DEV_SECRET_FALLBACK;
  };

  const betterAuthSecret = resolve('BETTER_AUTH_SECRET');
  const apiKeyHmacSecret = resolve('API_KEY_HMAC_SECRET');
  const usedDevFallback = !auth.BETTER_AUTH_SECRET || !auth.API_KEY_HMAC_SECRET;
  return { betterAuthSecret, apiKeyHmacSecret, usedDevFallback };
}

export function loadAuthConfig(): { auth: AuthConfig; base: BaseConfig } {
  const all = loadConfig<AuthConfig & BaseConfig>();
  return { auth: all, base: all };
}
