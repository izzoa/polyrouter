/**
 * The provider-call layer's public contract. A `ProviderAdapter` takes the
 * protocol-agnostic `Normalized*` IR (from #5), serializes it to the provider's
 * wire protocol, calls the provider over the SSRF-guarded transport, and parses
 * the reply back into the IR — plus `listModels`/`testConnection`. It defines no
 * response shape of its own (CLAUDE.md invariant 2) and stores nothing; #7
 * supplies the decrypted credential, #10 composes routing/fallback + the breaker.
 */
import type {
  AdapterQuirks,
  NormalizedRequest,
  NormalizedResponse,
  NormalizedStreamEvent,
} from '../proxy/translate';

export type ProviderKind = 'api_key' | 'subscription' | 'custom' | 'local';
export type ProviderProtocol = 'openai_compatible' | 'anthropic_compatible';
export type RuntimeMode = 'selfhosted' | 'cloud';

/** Per-call context. `signal` aborts the call (breaker-neutral); `traceId` is
 * for the caller's own correlation (never the credential). */
export interface CallContext {
  readonly signal?: AbortSignal;
  readonly traceId?: string;
}

export interface ProviderConfig {
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  /** Already-decrypted by the caller (#7). Passed only in the auth header. */
  readonly credential: string;
  readonly kind: ProviderKind;
  readonly mode: RuntimeMode;
  /** Anthropic requires max_tokens; used when the IR omits maxOutputTokens. */
  readonly defaultMaxOutputTokens?: number;
  /** Abort if no response headers / first stream event arrive in time. */
  readonly firstByteTimeoutMs?: number;
  /** Optional bound on inter-event gaps for a stream (not an overall deadline). */
  readonly idleTimeoutMs?: number;
  /** Forwarded to #5's translate adapter (genuine provider deviations). */
  readonly quirks?: AdapterQuirks;
  /** Merged into outbound requests (subscription/custom header seam). */
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

export interface ProviderModelInfo {
  readonly id: string;
  readonly displayName?: string;
}

export type ConnectionResult =
  | { readonly ok: true; readonly models: number }
  | { readonly ok: false; readonly kind: string; readonly message: string };

export interface ProviderAdapter {
  readonly protocol: ProviderProtocol;
  chat(request: NormalizedRequest, ctx?: CallContext): Promise<NormalizedResponse>;
  chatStream(request: NormalizedRequest, ctx?: CallContext): AsyncGenerator<NormalizedStreamEvent>;
  listModels(ctx?: CallContext): Promise<ProviderModelInfo[]>;
  testConnection(ctx?: CallContext): Promise<ConnectionResult>;
}

export const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 30_000;
