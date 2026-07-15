import { loadConfig, registerConfig, z } from '@polyrouter/shared';
import type { BaseConfig } from '@polyrouter/shared';
import { isLoopbackAddress } from '../auth/auth.config';

/** Provider-credential encryption key (#7). Credentials are encrypted at rest
 * with the shared `encryptSecret` util under this 32-byte-hex key; the value is
 * never echoed in a thrown message. Gated exactly like the auth secrets: a
 * fixed dev fallback only on a loopback-bound, non-production self-host. */

const HEX_64 = /^[0-9a-f]{64}$/i;
const DEV_CREDENTIAL_KEY_FALLBACK = 'de'.repeat(32);

registerConfig(
  'providers',
  z.object({
    PROVIDER_CREDENTIAL_KEY: z
      .string()
      .refine((v) => HEX_64.test(v), { message: 'expected 32-byte hex' })
      .optional(),
  }),
);

export type ProvidersConfig = {
  PROVIDER_CREDENTIAL_KEY?: string;
};

/** Fixed dev fallback ONLY on a loopback-bound, non-production self-host;
 * anything network-reachable or production requires a real key. Never echoes
 * the key material. */
export function resolveCredentialKey(
  cfg: ProvidersConfig,
  base: Pick<BaseConfig, 'NODE_ENV' | 'MODE' | 'BIND_ADDRESS'>,
): string {
  const provided = cfg.PROVIDER_CREDENTIAL_KEY;
  if (provided) return provided;
  const devEligible =
    base.NODE_ENV !== 'production' &&
    base.MODE === 'selfhosted' &&
    isLoopbackAddress(base.BIND_ADDRESS);
  if (!devEligible) {
    throw new Error(
      'PROVIDER_CREDENTIAL_KEY is required (no dev fallback outside a loopback-bound, non-production self-hosted instance). Set it to 32-byte hex (openssl rand -hex 32).',
    );
  }
  return DEV_CREDENTIAL_KEY_FALLBACK;
}

export function loadProvidersConfig(): { providers: ProvidersConfig; base: BaseConfig } {
  const all = loadConfig<ProvidersConfig & BaseConfig>();
  return { providers: all, base: all };
}
