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

// The SanitizedMessage brand lives in translate/ir (dependency-neutral) so it
// flows unbroken factory → IR diagnostic → core → persistence, no casts.
import type { SanitizedMessage } from '../proxy/translate/ir';

export type { SanitizedMessage };

export interface ProviderErrorMeta {
  readonly status?: number;
  readonly requestId?: string;
  /** Factory-sanitized provider-verbatim message (add-request-error-detail);
   * persisted on `status=error` RequestLog rows, never client-facing. */
  readonly providerMessage?: SanitizedMessage;
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly requestId?: string;
  readonly providerMessage?: SanitizedMessage;
  constructor(kind: ProviderErrorKind, message: string, meta: ProviderErrorMeta = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    if (meta.status !== undefined) this.status = meta.status;
    if (meta.requestId !== undefined) this.requestId = meta.requestId;
    if (meta.providerMessage !== undefined) this.providerMessage = meta.providerMessage;
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
  secrets: readonly string[] = [],
): ProviderError {
  const snippet = bodyText.slice(0, 200);
  const [kind, curated] = ((): [ProviderErrorKind, string] => {
    if (status === 401 || status === 403)
      return ['auth', `provider auth failed (${String(status)})`];
    if (status === 429) return ['rate_limit', `provider rate limited (429)`];
    if (status === 404) {
      return isModelNotFound(bodyText)
        ? ['unknown_model', `model not found (404)`]
        : ['unavailable', `provider endpoint not found (404)`];
    }
    if (status === 400 || status === 422 || status === 413) {
      return ['bad_request', `provider rejected the request (${String(status)}): ${snippet}`];
    }
    if (status === 408 || status === 409 || status >= 500) {
      return ['unavailable', `provider unavailable (${String(status)})`];
    }
    // Other 4xx: treat as a client-fault bad request (no fallback, no trip).
    if (status >= 400) {
      return ['bad_request', `provider rejected the request (${String(status)}): ${snippet}`];
    }
    return ['unavailable', `unexpected provider status (${String(status)})`];
  })();
  const providerMessage = captureProviderMessage(
    { source: 'parsed-envelope', envelope: parseErrorEnvelope(bodyText) },
    { kind, secrets },
  );
  return new ProviderError(kind, curated, {
    ...meta,
    status,
    ...(providerMessage !== null ? { providerMessage } : {}),
  });
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

// ---------------------------------------------------------------------------
// Error-detail sanitization (add-request-error-detail). Invariant 8 floor under
// "provider-verbatim": secrets AND prompt content must never reach storage.
// ---------------------------------------------------------------------------

const MAX_MESSAGE_LEN = 300;
const REDACTED = '[redacted]';
export const VALIDATION_WITHHELD = '[validation message withheld]';
export const POLICY_WITHHELD = '[content-policy message withheld]';

/** Strip ALL C0 controls (tab/LF/CR included — a line-wrapped `sk-\n…` must
 * not evade exact matching), bidi, and zero-width characters, and uppercase
 * percent-escape triplets (so a lowercase `%2b` matches `encodeURIComponent`'s
 * uppercase output) BEFORE any matching runs (r3-High-2). */
function normalizeForScrub(text: string): string {
  return text
    .replace(
      // eslint-disable-next-line no-control-regex -- deliberately stripping control chars
      /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g,
      '',
    )
    .replace(/%[0-9a-fA-F]{2}/g, (m) => m.toUpperCase());
}

const HEURISTICS: readonly (readonly [RegExp, string])[] = [
  // Key-shaped tokens (ours and the major providers').
  [/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\bpoly_[A-Za-z0-9_-]{8,}/g, REDACTED],
  // Authorization schemes.
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._-]{6,}/gi, REDACTED],
  // Header / query / JSON credential fields: redact the VALUE, keep the name.
  [
    /((?:x-api-key|api[_-]?key|access[_-]?token|client[_-]?secret|secret|token|key)["']?\s*[:=]\s*["']?)[A-Za-z0-9+/=._-]{6,}/gi,
    `$1${REDACTED}`,
  ],
  // Cookies: redact everything after the header name.
  [/\b((?:set-)?cookie\s*[:=]\s*)\S+/gi, `$1${REDACTED}`],
  // Dotted JWTs.
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, REDACTED],
  // Bare long opaque runs (base64/hex ≥ 32) — overreach beats a leak.
  [/\b[A-Fa-f0-9]{32,}\b/g, REDACTED],
  [/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, REDACTED],
];

/** Encoding variants of a secret: raw, percent-encoded, and base64 in its
 * standard / unpadded / URL-safe / URL-safe-unpadded forms (r3-High-2). */
function secretVariants(secret: string): string[] {
  const std = Buffer.from(secret, 'utf8').toString('base64');
  const urlSafe = std.replace(/\+/g, '-').replace(/\//g, '_');
  return [
    secret,
    encodeURIComponent(secret),
    std,
    std.replace(/=+$/, ''),
    urlSafe,
    urlSafe.replace(/=+$/, ''),
  ];
}

/** Redact secrets from provider text: EXACT configured credentials first (incl.
 * URL-encoded + base64 forms — heuristics cannot catch short/custom secrets),
 * then heuristic shapes. Pure, total, idempotent; never throws. */
export function scrubSecrets(text: string, secrets: readonly string[] = []): string {
  let out = normalizeForScrub(text);
  for (const secret of secrets) {
    if (secret === '') continue;
    // Longest-first so an unpadded form cannot leave a padded sibling's `=` tail.
    for (const variant of [...new Set(secretVariants(secret))].sort(
      (a, b) => b.length - a.length,
    )) {
      out = out.split(variant).join(REDACTED);
    }
  }
  for (const [re, replacement] of HEURISTICS) out = out.replace(re, replacement);
  return out;
}

/** Strict allowlist for upstream request ids — an arbitrary response-header
 * value is never copied verbatim (header-injection / oversize defense). */
export function sanitizeRequestId(id: string | null | undefined): string | undefined {
  if (id == null) return undefined;
  return /^[A-Za-z0-9._-]{1,128}$/.test(id) ? id : undefined;
}

/** Discriminated capture input — bare strings are unpassable by construction:
 * raw body text can quote prompt content, which no length cap makes metadata. */
export type CaptureInput =
  | { readonly source: 'parsed-envelope'; readonly envelope: unknown }
  | {
      readonly source: 'stream-wire';
      readonly message?: string;
      readonly type?: string;
      readonly code?: string;
    };

export interface CaptureContext {
  readonly kind: ProviderErrorKind;
  readonly secrets?: readonly string[];
}

const POLICY_MARKER = /content[_-]?filter|content[_-]?policy|moderation/i;

/** Walk a parsed error envelope's nested `error` objects for the first string
 * `message`, collecting EVERY `type`/`code` string visited (bounded depth) — a
 * policy marker hidden behind an outer wrapper (`{type:'error',error:{type:
 * 'content_filter',…}}`) must still be seen (r3-High-1). */
function walkEnvelope(envelope: unknown): { message?: string; markers: string[] } {
  let node: unknown = envelope;
  const markers: string[] = [];
  let message: string | undefined;
  for (let depth = 0; depth < 4 && typeof node === 'object' && node !== null; depth += 1) {
    const rec = node as Record<string, unknown>;
    if (typeof rec['type'] === 'string') markers.push(rec['type']);
    if (typeof rec['code'] === 'string') markers.push(rec['code']);
    if (message === undefined && typeof rec['message'] === 'string') {
      message = rec['message'];
    }
    node = rec['error'];
  }
  return { ...(message !== undefined ? { message } : {}), markers };
}

/**
 * The ONLY producer of a persistable provider message (add-request-error-detail).
 * Structured `error.message` strings only — a shapeless/non-JSON body yields null
 * (raw text NEVER persists). Kind-based verbatim policy: operational kinds
 * verbatim (scrubbed); `bad_request`/validation withheld (validation errors
 * routinely echo submitted content); a content-policy marker in type OR code
 * withheld with its own marker (checked first). Scrub before cap.
 */
export function captureProviderMessage(
  input: CaptureInput,
  ctx: CaptureContext,
): SanitizedMessage | null {
  const { message, markers } =
    input.source === 'parsed-envelope'
      ? walkEnvelope(input.envelope)
      : {
          ...(input.message !== undefined ? { message: input.message } : {}),
          markers: [input.type, input.code].filter((v): v is string => typeof v === 'string'),
        };
  // Conservative policy (r3-High-1): a marker ANYWHERE decides. Policy first,
  // then validation — from the caller's kind OR any marker that classifies as
  // a client-fault validation error (a generic outward type must not launder a
  // `code=invalid_request_error` into the operational-verbatim path).
  if (markers.some((m) => POLICY_MARKER.test(m))) return POLICY_WITHHELD as SanitizedMessage;
  if (ctx.kind === 'bad_request' || markers.some((m) => classifyStreamError(m) === 'bad_request')) {
    return VALIDATION_WITHHELD as SanitizedMessage;
  }
  if (typeof message !== 'string' || message === '') return null;
  const scrubbed = scrubSecrets(message, ctx.secrets ?? []).slice(0, MAX_MESSAGE_LEN);
  return scrubbed === '' ? null : (scrubbed as SanitizedMessage);
}

/** Parse a response body for capture; non-JSON (HTML, proxy pages, truncation)
 * yields null — the factory then records no message for it. */
export function parseErrorEnvelope(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return null;
  }
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
