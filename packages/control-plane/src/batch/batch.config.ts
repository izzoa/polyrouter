import { createProviderAdapter } from '@polyrouter/data-plane';
import { loadConfig, registerConfig, z } from '@polyrouter/shared';
import { loadProvidersConfig, resolveCredentialKey } from '../providers/providers.config';
import { resolveProxyBounds, type ProxyRawConfig } from '../proxy/proxy.config';

/** Timer ceiling shared with the proxy config: past ~2^31-1 ms a Node timer clamps
 * to ~1 ms and fires immediately. */
const MAX_INTERVAL_MS = 3_600_000;
/** One week — an upper bound on how long past its window a job may be treated as
 * "still possibly running" before the upstream's own answer decides (D21). */
const MAX_MARGIN_MS = 7 * 86_400_000;
/** 64 MiB: the honest in-memory bound for a self-hosted single container — items
 * live in memory only until the upstream create returns (D1). OpenAI accepts 200 MB
 * and Anthropic 256 MB per batch; an operator who wants that raises this. */
const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;

/**
 * Batch-inference config (add-batch-inference). Exported so the parse/default/
 * validation contract is unit-testable without the global registry.
 * `BATCH_ENABLED=false` refuses NEW submissions only — the poller, reads, results,
 * and cancel keep running so in-flight jobs drain to a terminal state and release
 * their reservations rather than being stranded (D23).
 */
export const batchConfigSchema = z.object({
  BATCH_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false'), // default true
  BATCH_MAX_ITEMS: z.coerce.number().int().min(1).max(1_000_000).default(50_000),
  BATCH_MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(2 ** 31 - 1)
    .default(DEFAULT_MAX_BODY_BYTES),
  BATCH_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).max(MAX_INTERVAL_MS).default(15_000),
  BATCH_WINDOW_MARGIN_MS: z.coerce.number().int().min(0).max(MAX_MARGIN_MS).default(3_600_000),
});

registerConfig('batch', batchConfigSchema);

export const BATCH_CONFIG = 'polyrouter:batch-config';

export type BatchRawConfig = {
  BATCH_ENABLED: boolean;
  BATCH_MAX_ITEMS: number;
  BATCH_MAX_BODY_BYTES: number;
  BATCH_POLL_INTERVAL_MS: number;
  BATCH_WINDOW_MARGIN_MS: number;
};

/** The resolved config the batch subsystem depends on. */
export interface BatchConfig {
  readonly enabled: boolean;
  readonly maxItems: number;
  readonly maxBodyBytes: number;
  readonly pollIntervalMs: number;
  readonly windowMarginMs: number;
}

export function resolveBatchConfig(): BatchConfig {
  const all = loadConfig<BatchRawConfig>();
  return {
    enabled: all.BATCH_ENABLED,
    maxItems: all.BATCH_MAX_ITEMS,
    maxBodyBytes: all.BATCH_MAX_BODY_BYTES,
    pollIntervalMs: all.BATCH_POLL_INTERVAL_MS,
    windowMarginMs: all.BATCH_WINDOW_MARGIN_MS,
  };
}

export const BATCH_RUNTIME = 'polyrouter:batch-runtime';
export const BATCH_ADAPTER_FACTORY = 'polyrouter:batch-adapter-factory';
export type BatchAdapterFactory = typeof createProviderAdapter;

/** A batch create uploads the whole item set before the upstream answers, so
 * its first-byte bound must outlast a large upload; never below this floor. */
const SUBMIT_FIRST_BYTE_FLOOR_MS = 120_000;

/** What the batch path needs beyond its own config: the credential key + mode
 * (the shared adapter builder's runtime) and the upstream timeout bounds. */
export interface BatchRuntime {
  readonly key: string;
  readonly mode: 'selfhosted' | 'cloud';
  readonly firstByteTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly streamEventTimeoutMs: number;
}

export function loadBatchRuntime(): BatchRuntime {
  const { providers, base } = loadProvidersConfig();
  const bounds = resolveProxyBounds(loadConfig<ProxyRawConfig>());
  return {
    key: resolveCredentialKey(providers, base),
    mode: base.MODE,
    firstByteTimeoutMs: Math.max(bounds.firstByteTimeoutMs, SUBMIT_FIRST_BYTE_FLOOR_MS),
    idleTimeoutMs: bounds.idleTimeoutMs,
    streamEventTimeoutMs: Math.max(bounds.firstEventTimeoutMs, SUBMIT_FIRST_BYTE_FLOOR_MS),
  };
}
