import { loadConfig, registerConfig, z } from '@polyrouter/shared';
import type { BaseConfig } from '@polyrouter/shared';
import { assertNetworkHostSafe, SsrfError, type AllowedEndpoint } from '@polyrouter/shared/server';
import { isLoopbackAddress } from '../auth/auth.config';

/** Notification config (#15a, spec §10.1/§12). `NOTIFY_CREDENTIALS_SECRET`
 * encrypts channel config at rest (gated like `PROVIDER_CREDENTIAL_KEY`);
 * `APPRISE_API_URL` is SSRF-validated at boot; `NOTIFY_ALLOWED_ENDPOINTS`
 * allowlists soft private ranges (port-bounded); cloud Apprise is gated on
 * `NOTIFY_APPRISE_EGRESS_CONFIRMED`. Server-wide `SMTP_*` defaults are #15b's. */

const HEX_64 = /^[0-9a-f]{64}$/i;
const DEV_NOTIFY_SECRET_FALLBACK = 'ce'.repeat(32);

registerConfig(
  'notify',
  z.object({
    APPRISE_API_URL: z.string().url().optional(),
    NOTIFY_CREDENTIALS_SECRET: z
      .string()
      .refine((v) => HEX_64.test(v), { message: 'expected 32-byte hex' })
      .optional(),
    NOTIFY_ALLOWED_ENDPOINTS: z.string().optional(),
    NOTIFY_APPRISE_EGRESS_CONFIRMED: z
      .string()
      .optional()
      .transform((v) => v === 'true'),
  }),
);

export const NOTIFY_RUNTIME = 'polyrouter:notify-runtime';

export type NotifyConfig = {
  APPRISE_API_URL?: string;
  NOTIFY_CREDENTIALS_SECRET?: string;
  NOTIFY_ALLOWED_ENDPOINTS?: string;
  NOTIFY_APPRISE_EGRESS_CONFIRMED: boolean;
};

/** The resolved runtime the notification providers depend on — built by an async
 * factory so the `APPRISE_API_URL` SSRF check gates construction (and boot). */
export interface NotifyRuntime {
  readonly mode: 'selfhosted' | 'cloud';
  readonly notifySecret: string;
  readonly appriseApiUrl: string | undefined;
  readonly allowedEndpoints: AllowedEndpoint[];
  readonly appriseEgressConfirmed: boolean;
}

/** Fixed dev fallback ONLY on a loopback-bound, non-production self-host; never
 * echoes the key material. */
export function resolveNotifySecret(
  cfg: NotifyConfig,
  base: Pick<BaseConfig, 'NODE_ENV' | 'MODE' | 'BIND_ADDRESS'>,
): string {
  const provided = cfg.NOTIFY_CREDENTIALS_SECRET;
  if (provided) return provided;
  const devEligible =
    base.NODE_ENV !== 'production' &&
    base.MODE === 'selfhosted' &&
    isLoopbackAddress(base.BIND_ADDRESS);
  if (!devEligible) {
    throw new Error(
      'NOTIFY_CREDENTIALS_SECRET is required (no dev fallback outside a loopback-bound, non-production self-hosted instance). Set it to 32-byte hex (openssl rand -hex 32).',
    );
  }
  return DEV_NOTIFY_SECRET_FALLBACK;
}

/** Parse `host,cidr[,port]` entries (`;`-separated) into allowlist endpoints. */
export function parseAllowedEndpoints(raw: string | undefined): AllowedEndpoint[] {
  if (raw === undefined || raw.trim() === '') return [];
  const out: AllowedEndpoint[] = [];
  for (const entry of raw.split(';')) {
    const parts = entry
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length < 2) continue;
    const [host, cidr, port] = parts;
    out.push({
      host: host!,
      cidr: cidr!,
      ...(port !== undefined ? { port: Number(port) } : {}),
    });
  }
  return out;
}

/** Resolve the runtime, validating `APPRISE_API_URL` via SSRF (throws → boot fail). */
export async function resolveNotifyRuntime(): Promise<NotifyRuntime> {
  const all = loadConfig<NotifyConfig & BaseConfig>();
  const allowedEndpoints = parseAllowedEndpoints(all.NOTIFY_ALLOWED_ENDPOINTS);
  if (all.APPRISE_API_URL !== undefined) {
    // Mode-gated host guard (self-host allows the local sidecar; cloud blocks
    // private/metadata unless allowlisted). Fails boot on SsrfError.
    const url = new URL(all.APPRISE_API_URL);
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    try {
      await assertNetworkHostSafe(url.hostname, port, { mode: all.MODE, allowedEndpoints });
    } catch (err) {
      if (err instanceof SsrfError) {
        throw new Error('APPRISE_API_URL failed SSRF validation (private/metadata not allowed).', {
          cause: err,
        });
      }
      throw err;
    }
  }
  return {
    mode: all.MODE,
    notifySecret: resolveNotifySecret(all, all),
    appriseApiUrl: all.APPRISE_API_URL,
    allowedEndpoints,
    appriseEgressConfirmed: all.NOTIFY_APPRISE_EGRESS_CONFIRMED,
  };
}
