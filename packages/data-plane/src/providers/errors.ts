/**
 * Provider-error taxonomy and the two classifiers the layers above read:
 * `shouldFallback` (does the proxy try another model?) and `breakerImpact`
 * (does this open the provider-level breaker?). Kept separate on purpose — a
 * retired model must fall back without disabling a healthy provider (§7.4).
 * No classifier or error message ever embeds the credential (invariant 8).
 */

export type ProviderErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'unavailable'
  | 'bad_request'
  | 'unknown_model'
  // A local credential-resolution failure (add-subscription-oauth): a revoked OAuth
  // grant (`reauthorize required`) or a transient identity-provider outage. Fallback-
  // eligible (the chain moves on) but breaker-NEUTRAL — credential state and IdP
  // availability are not upstream provider health.
  | 'credential';

export interface ProviderErrorMeta {
  readonly status?: number;
  readonly requestId?: string;
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly requestId?: string;
  constructor(kind: ProviderErrorKind, message: string, meta: ProviderErrorMeta = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    if (meta.status !== undefined) this.status = meta.status;
    if (meta.requestId !== undefined) this.requestId = meta.requestId;
  }
}

/** Thrown by `withBreaker*` when the breaker is open — the provider is skipped. */
export class ProviderCircuitOpenError extends Error {
  constructor(providerId: string) {
    super(`circuit open for provider ${providerId}`);
    this.name = 'ProviderCircuitOpenError';
  }
}

/** The caller's own `signal` aborted the call — breaker-neutral, not a fault. */
export class CallCancelledError extends Error {
  constructor(message = 'call cancelled by caller') {
    super(message);
    this.name = 'CallCancelledError';
  }
}

/** The proxy (#10) walks its chain on these; a client-fault `bad_request` does not. */
export function shouldFallback(kind: ProviderErrorKind): boolean {
  return kind !== 'bad_request';
}

/** What opens the provider-level breaker. `unknown_model` is model-specific
 * (the provider is healthy) and `bad_request` is the client's fault — neither trips. */
export function breakerImpact(kind: ProviderErrorKind): boolean {
  return kind === 'rate_limit' || kind === 'unavailable' || kind === 'auth';
}

const MODEL_NOT_FOUND = /model/i;
const NOT_FOUND_HINT = /(not[_\s-]?found|does not exist|unknown|no such|deprecat|retir)/i;

/** A 404 is a missing MODEL only when the body says so; otherwise it is a wrong
 * path — a provider-misconfig `unavailable`, not a per-model fallback. */
function isModelNotFound(bodyText: string): boolean {
  return MODEL_NOT_FOUND.test(bodyText) && NOT_FOUND_HINT.test(bodyText);
}

export function classifyResponse(
  status: number,
  bodyText: string,
  meta: ProviderErrorMeta = {},
): ProviderError {
  const m = { ...meta, status };
  const snippet = bodyText.slice(0, 200);
  if (status === 401 || status === 403) {
    return new ProviderError('auth', `provider auth failed (${String(status)})`, m);
  }
  if (status === 429) {
    return new ProviderError('rate_limit', `provider rate limited (429)`, m);
  }
  if (status === 404) {
    return isModelNotFound(bodyText)
      ? new ProviderError('unknown_model', `model not found (404)`, m)
      : new ProviderError('unavailable', `provider endpoint not found (404)`, m);
  }
  if (status === 400 || status === 422 || status === 413) {
    return new ProviderError(
      'bad_request',
      `provider rejected the request (${String(status)}): ${snippet}`,
      m,
    );
  }
  if (status === 408 || status === 409 || status >= 500) {
    return new ProviderError('unavailable', `provider unavailable (${String(status)})`, m);
  }
  // Other 4xx: treat as a client-fault bad request (no fallback, no trip).
  if (status >= 400) {
    return new ProviderError(
      'bad_request',
      `provider rejected the request (${String(status)}): ${snippet}`,
      m,
    );
  }
  return new ProviderError('unavailable', `unexpected provider status (${String(status)})`, m);
}

const NETWORK_UNAVAILABLE =
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|socket hang up|other side closed|terminated|UND_ERR/i;

export function classifyNetworkError(err: unknown): ProviderError {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err instanceof Error && 'code' in err ? String((err as { code?: unknown }).code) : '';
  if (NETWORK_UNAVAILABLE.test(message) || NETWORK_UNAVAILABLE.test(code)) {
    return new ProviderError('unavailable', `provider connection failed: ${message}`);
  }
  return new ProviderError('unavailable', `provider request failed: ${message}`);
}

/** Map a normalized `error` event's raw provider type into the taxonomy, so a
 * streamed model/invalid-request error falls back without opening the breaker. */
export function classifyStreamError(rawType: string): ProviderErrorKind {
  const t = rawType.toLowerCase();
  if (
    t.includes('overload') ||
    t.includes('server') ||
    t.includes('api_error') ||
    t.includes('timeout')
  ) {
    return 'unavailable';
  }
  if (t.includes('rate') || t.includes('quota')) return 'rate_limit';
  if (t.includes('auth') || t.includes('permission')) return 'auth';
  if (t.includes('not_found') || t.includes('not found')) return 'unknown_model';
  if (t.includes('invalid_request') || t.includes('invalid')) return 'bad_request';
  return 'unavailable';
}
