import { createProviderAdapter } from '@polyrouter/data-plane';
import { loadProvidersConfig, resolveCredentialKey } from '../providers/providers.config';

/** DI tokens for the proxy layer. */
export const PROXY_RUNTIME = 'polyrouter:proxy-runtime';
export const PROXY_ADAPTER_FACTORY = 'polyrouter:proxy-adapter-factory';

export type ProxyAdapterFactory = typeof createProviderAdapter;

export interface ProxyRuntime {
  /** Provider-credential encryption key (#7). */
  readonly key: string;
  readonly mode: 'selfhosted' | 'cloud';
  readonly defaultMaxOutputTokens: number;
  /** Abort a streamed call if headers/first event do not arrive in time. */
  readonly firstByteTimeoutMs: number;
  /** Max time to wait for in-flight streams to finish on shutdown. */
  readonly streamDrainDeadlineMs: number;
}

/** Resolve the proxy runtime from config (reuses #7's credential-key logic). */
export function loadProxyRuntime(): ProxyRuntime {
  const { providers, base } = loadProvidersConfig();
  return {
    key: resolveCredentialKey(providers, base),
    mode: base.MODE,
    defaultMaxOutputTokens: 4096,
    firstByteTimeoutMs: 30_000,
    streamDrainDeadlineMs: 15_000,
  };
}
