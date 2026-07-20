import { loadConfig, type BaseConfig } from '@polyrouter/shared';
import { resolveCredentialKey } from '../providers/providers.config';

export const BODY_CAPTURE_CONFIG = 'polyrouter:body-capture-config';

export interface BodyCaptureConfig {
  /** MODE=selfhosted — the ONLY mode where capture can arm (defense in depth:
   * enforced at the settings API and again at the capture seam). */
  readonly selfhosted: boolean;
  /** Per-direction plaintext cap. Clamp range is a CONTRACT (spec): an unsafe
   * value is rejected at boot, never silently honored. */
  readonly maxBytes: number;
  /** Writer bounds (design D5): total plaintext byte budget across queued
   * drafts, and per-write-batch budget. */
  readonly queueBudgetBytes: number;
  readonly batchBudgetBytes: number;
  /** PROVIDER_CREDENTIAL_KEY — the instance encryption key the writer uses for
   * body ciphertext (same key discipline as provider credentials). */
  readonly credentialKey: string;
}

const MIN_MAX_BYTES = 1024;
const MAX_MAX_BYTES = 1_048_576;
const DEFAULT_MAX_BYTES = 262_144;

export function loadBodyCaptureConfig(): BodyCaptureConfig {
  const env = loadConfig<
    {
      MODE?: string;
      BODY_CAPTURE_MAX_BYTES?: string;
      PROVIDER_CREDENTIAL_KEY?: string;
    } & Pick<BaseConfig, 'NODE_ENV' | 'BIND_ADDRESS'>
  >();
  const raw = env.BODY_CAPTURE_MAX_BYTES;
  let maxBytes = DEFAULT_MAX_BYTES;
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < MIN_MAX_BYTES || parsed > MAX_MAX_BYTES) {
      throw new Error(
        `BODY_CAPTURE_MAX_BYTES must be an integer in [${String(MIN_MAX_BYTES)}, ${String(MAX_MAX_BYTES)}]; got ${raw}`,
      );
    }
    maxBytes = parsed;
  }
  return {
    selfhosted: env.MODE === 'selfhosted',
    maxBytes,
    queueBudgetBytes: 64 * 1024 * 1024,
    batchBudgetBytes: 4 * 1024 * 1024,
    // THE canonical resolution (clink impl-Med-5): same key + same loopback-dev
    // fallback discipline as provider-credential encryption — a valid local dev
    // setup must capture, and a network-reachable instance without a key fails
    // fast rather than silently dropping every body.
    credentialKey: resolveCredentialKey(env, {
      NODE_ENV: env.NODE_ENV,
      MODE: env.MODE as BaseConfig['MODE'],
      BIND_ADDRESS: env.BIND_ADDRESS,
    }),
  };
}
