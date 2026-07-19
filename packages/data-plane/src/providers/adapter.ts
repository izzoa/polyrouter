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
// 'openai_responses' (add-chatgpt-responses) is UPSTREAM/preset-only — no client speaks
// it to /v1, and the public provider-create DTO deliberately does not accept it.
export type ProviderProtocol = 'openai_compatible' | 'anthropic_compatible' | 'openai_responses';
export type RuntimeMode = 'selfhosted' | 'cloud';

/** Per-call context. `signal` aborts the call (breaker-neutral); `traceId` is
 * for the caller's own correlation (never the credential). */
export interface CallContext {
  readonly signal?: AbortSignal;
  readonly traceId?: string;
}

/** How the credential authenticates (add-subscription-oauth). `api_key` (default) is
 * every pre-existing behavior; `oauth_bearer` is set by credential resolution when the
 * envelope is a structured OAuth credential — Anthropic-compatible adapters then send
 * `Authorization: Bearer` + `anthropic-beta: <oauthBeta>` instead of `x-api-key`. */
export type AuthScheme = 'api_key' | 'oauth_bearer';

export interface ProviderConfig {
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  /** Already-decrypted by the caller (#7). Passed only in the auth header. */
  readonly credential: string;
  readonly kind: ProviderKind;
  readonly mode: RuntimeMode;
  /** Defaults to 'api_key' — every existing caller unchanged. */
  readonly authScheme?: AuthScheme;
  /** The preset's OAuth `anthropic-beta` value — TRUSTED registry data threaded by
   * credential resolution, never user input. Required under `oauth_bearer` on the
   * Anthropic protocol (missing → typed configuration error, never a header-less call). */
  readonly oauthBeta?: string;
  /** The ChatGPT account id for the Responses protocol (add-chatgpt-responses) —
   * TRUSTED envelope data threaded by credential resolution, never user input.
   * Emitted as the `chatgpt-account-id` header; required for `openai_responses`. */
  readonly oauthAccountId?: string;
  /** The designated validating-probe model for a models-endpoint-less protocol —
   * TRUSTED preset-registry data (the preset's first bundled model). */
  readonly probeModel?: string;
  /** Anthropic requires max_tokens; used when the IR omits maxOutputTokens. */
  readonly defaultMaxOutputTokens?: number;
  /** Abort if no response headers / first stream event arrive in time. */
  readonly firstByteTimeoutMs?: number;
  /** Optional bound on inter-event gaps for a stream (not an overall deadline). */
  readonly idleTimeoutMs?: number;
  /** Cap on a buffered (non-streaming) response body; defaults to
   * `DEFAULT_MAX_RESPONSE_BYTES`. Overridable mainly for tests (E11.1). */
  readonly maxResponseBytes?: number;
  /** Forwarded to #5's translate adapter (genuine provider deviations). */
  readonly quirks?: AdapterQuirks;
  /** Merged into outbound requests (subscription/custom header seam). */
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

/**
 * A provider-listed price for DISPLAY only (add-provider-price-sync-and-edit) —
 * surfaced from a models endpoint that carries per-model prices (OpenRouter and
 * OpenAI-compatible aggregators). Normalized to per-1M USD at the adapter boundary.
 * NEVER a billing/cost source (invariant 4): recorded cost comes from the bundled
 * catalog, not provider `/models`. `isFree` is set only when every monetary dimension
 * the provider lists is zero — a zero-token model with a per-request/image charge is
 * `$0` but not free.
 */
export interface ProviderListedPricing {
  readonly inputPricePer1m: number;
  readonly outputPricePer1m: number;
  readonly isFree?: boolean;
}

export interface ProviderModelInfo {
  readonly id: string;
  readonly displayName?: string;
  readonly pricing?: ProviderListedPricing;
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

/**
 * Hard cap on a buffered (non-streaming) provider response body (E11.1). A
 * `base_url` only has to pass the SSRF *address* check — a hostile-but-public
 * endpoint is allowed by design — so the buffered drain must bound memory itself.
 * 10 MiB mirrors the `/v1` ingress bound; a real model list or completion JSON is
 * orders of magnitude smaller. Streaming SSE is consumed incrementally and exempt.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** Parse-time cap on the number of DISTINCT, length-valid model ids
 * `parseModelList` will materialize from one `listModels` response (defense-in-depth
 * under the byte cap; the write-time `MAX_SYNCED_MODELS` bound is what protects the
 * DB). Oversized/duplicate ids are skipped BEFORE they count toward this cap, so a
 * flood of junk ids can't starve out the valid ones (E11.1). */
export const MAX_PARSED_MODELS = 5_000;

/** Max external-model-id length. A longer id is skipped (not truncated — a
 * truncated id is a *wrong* id that could collide on `(provider_id, id)`). Shared
 * by the data-plane parse cap and the control-plane upsert guard. */
export const MAX_MODEL_ID_LEN = 512;
