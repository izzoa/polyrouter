import { createProviderAdapter } from '@polyrouter/data-plane';
import { loadConfig, registerConfig, z } from '@polyrouter/shared';
import { INTERMEDIARY_REAP_FLOOR_MS } from '../intermediary';
import { loadProvidersConfig, resolveCredentialKey } from '../providers/providers.config';

/** DI tokens for the proxy layer. */
export const PROXY_RUNTIME = 'polyrouter:proxy-runtime';
export const PROXY_ADAPTER_FACTORY = 'polyrouter:proxy-adapter-factory';
export const PROXY_BREAKER = 'polyrouter:proxy-breaker';

/** Bound each breaker Redis op with a fail-fast deadline so a down/slow Redis
 * degrades to the in-memory fallback promptly instead of stalling the hot path
 * on ioredis retries (#12). */
export const BREAKER_REDIS_TIMEOUT_MS = 150;

/**
 * Proxy hot-path tunables (E1). `PROXY_MAX_BODY_BYTES` bounds the `/v1` request
 * body (large enough for real harness payloads). `PROXY_FIRST_EVENT_TIMEOUT_MS`
 * is the operator knob for the adapter's time-to-first-byte/event abort (raise
 * it for slow local models); core's first/inter-event bound is derived as
 * first-byte + `PROXY_EVENT_TIMEOUT_MARGIN_MS` so the adapter's typed
 * `unavailable` timeout wins for a pre-headers hang (and such a system-imposed
 * timeout trips the breaker, unlike a genuine caller abort).
 */
/** Default `/v1` request body cap (10 MiB) — large enough for real harness
 * payloads. Also the fallback when the proxy runtime is not wired (auth-only
 * test harnesses that mount body parsing without the proxy module). */
export const DEFAULT_MAX_BODY_BYTES = 10_485_760;

/** 1 hour — an upper bound on the configurable timeouts, well under Node's
 * ~2^31-1 ms timer ceiling (past which a timer silently clamps to ~1ms and would
 * fire immediately). No legitimate time-to-first-token exceeds this. */
const MAX_TIMEOUT_MS = 3_600_000;

/** The proxy config schema. Exported so the parse/default/validation contract is
 * unit-testable without the global registry. The margin is strictly positive so
 * core's first/inter-event bound is always ABOVE the adapter first-byte bound
 * (the adapter's typed `unavailable` timeout must win a pre-headers race, E1.3). */
export const proxyConfigSchema = z.object({
  PROXY_MAX_BODY_BYTES: z.coerce.number().int().positive().default(DEFAULT_MAX_BODY_BYTES),
  PROXY_FIRST_EVENT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .default(30_000),
  PROXY_EVENT_TIMEOUT_MARGIN_MS: z.coerce.number().int().positive().max(60_000).default(500),
  // Inter-chunk idle deadline for buffered upstream reads (E4.3). Raise it
  // alongside PROXY_FIRST_EVENT_TIMEOUT_MS for slow local models.
  PROXY_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().max(MAX_TIMEOUT_MS).default(30_000),
  // add-stream-keepalive: the longest a committed `/v1` stream may leave its client
  // silent before a keepalive, and the longest a stream waits for its first event
  // before an early RESPONSE commit (200 + SSE headers). `0` disables each — hence
  // nonnegative, not positive. Bounded below the intermediary reap floor at build.
  PROXY_STREAM_HEARTBEAT_MS: z.coerce.number().int().nonnegative().default(15_000),
  PROXY_STREAM_EARLY_COMMIT_MS: z.coerce.number().int().nonnegative().default(20_000),
});

registerConfig('proxy', proxyConfigSchema);

export type ProxyRawConfig = {
  PROXY_MAX_BODY_BYTES: number;
  PROXY_FIRST_EVENT_TIMEOUT_MS: number;
  PROXY_EVENT_TIMEOUT_MARGIN_MS: number;
  PROXY_IDLE_TIMEOUT_MS: number;
  PROXY_STREAM_HEARTBEAT_MS: number;
  PROXY_STREAM_EARLY_COMMIT_MS: number;
};

/** The `/v1` stream keepalive settings (add-stream-keepalive). `0` = disabled. */
export interface StreamKeepaliveConfig {
  /** Max client-facing silence on a committed stream before a keepalive. */
  readonly heartbeatMs: number;
  /** Max wait for the first event before the early response commit. */
  readonly earlyCommitMs: number;
}

/** Validate the keepalive knobs against the intermediary reap floor (fail boot fast,
 * naming the knob): a value at or above it would silently reintroduce the drop the
 * knob exists to prevent. `0` (disabled) is always accepted. */
export function resolveStreamKeepalive(proxy: ProxyRawConfig): StreamKeepaliveConfig {
  for (const [knob, v] of [
    ['PROXY_STREAM_HEARTBEAT_MS', proxy.PROXY_STREAM_HEARTBEAT_MS],
    ['PROXY_STREAM_EARLY_COMMIT_MS', proxy.PROXY_STREAM_EARLY_COMMIT_MS],
  ] as const) {
    if (v !== 0 && v >= INTERMEDIARY_REAP_FLOOR_MS) {
      throw new Error(
        `${knob} must be 0 (disabled) or below the ~${String(INTERMEDIARY_REAP_FLOOR_MS)}ms intermediary idle-reap window`,
      );
    }
  }
  return {
    heartbeatMs: proxy.PROXY_STREAM_HEARTBEAT_MS,
    earlyCommitMs: proxy.PROXY_STREAM_EARLY_COMMIT_MS,
  };
}

export type ProxyAdapterFactory = typeof createProviderAdapter;

export interface ProxyRuntime {
  /** Provider-credential encryption key (#7). */
  readonly key: string;
  readonly mode: 'selfhosted' | 'cloud';
  readonly defaultMaxOutputTokens: number;
  /** Adapter bound: abort a call whose headers/first byte do not arrive in time. */
  readonly firstByteTimeoutMs: number;
  /** Core bound (= firstByte + margin): the per-event wait for the first and every
   * subsequent stream event, kept above the adapter bound so the adapter's typed
   * `unavailable` timeout wins for a pre-headers hang (E1.3). */
  readonly firstEventTimeoutMs: number;
  /** Adapter bound: inter-chunk idle deadline for a buffered upstream read (E4.3). */
  readonly idleTimeoutMs: number;
  /** Max `/v1` request body size in bytes. */
  readonly maxBodyBytes: number;
  /** Max time to wait for in-flight streams to finish on shutdown. */
  readonly streamDrainDeadlineMs: number;
  /** `/v1` stream keepalive + early response commit (add-stream-keepalive). */
  readonly streamKeepalive: StreamKeepaliveConfig;
}

/** Pure derivation of the body/timeout bounds from the validated proxy config,
 * so the arithmetic (core bound = adapter bound + margin, E1.3) is unit-testable
 * without the credential-key/registry side effects of {@link loadProxyRuntime}. */
export function resolveProxyBounds(proxy: ProxyRawConfig): {
  firstByteTimeoutMs: number;
  firstEventTimeoutMs: number;
  idleTimeoutMs: number;
  maxBodyBytes: number;
} {
  const firstByteTimeoutMs = proxy.PROXY_FIRST_EVENT_TIMEOUT_MS;
  return {
    firstByteTimeoutMs,
    firstEventTimeoutMs: firstByteTimeoutMs + proxy.PROXY_EVENT_TIMEOUT_MARGIN_MS,
    idleTimeoutMs: proxy.PROXY_IDLE_TIMEOUT_MS,
    maxBodyBytes: proxy.PROXY_MAX_BODY_BYTES,
  };
}

/** Resolve the proxy runtime from config (reuses #7's credential-key logic). */
export function loadProxyRuntime(): ProxyRuntime {
  const { providers, base } = loadProvidersConfig();
  const raw = loadConfig<ProxyRawConfig>();
  const bounds = resolveProxyBounds(raw);
  return {
    key: resolveCredentialKey(providers, base),
    mode: base.MODE,
    defaultMaxOutputTokens: 4096,
    ...bounds,
    streamDrainDeadlineMs: 15_000,
    streamKeepalive: resolveStreamKeepalive(raw),
  };
}
