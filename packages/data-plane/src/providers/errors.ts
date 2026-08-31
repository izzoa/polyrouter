/**
 * Provider-error taxonomy and the two classifiers the layers above read:
 * `shouldFallback` (does the proxy try another model?) and `breakerImpact`
 * (does this open the provider-level breaker?). Kept separate on purpose — a
 * retired model must fall back without disabling a healthy provider (§7.4).
 * No classifier or error message ever embeds the credential (invariant 8).
 */

/**
 * The taxonomy, as a canonical array so tests can be exhaustive by construction
 * (fix-4xx-error-taxonomy). A hand-maintained test list can silently omit a new
 * member; iterating this cannot. Each member's contract is (fallback, breaker
 * outcome, message policy):
 *
 * - `auth`            401 ONLY — a credential that fails EVERY request.
 *                     (fallback, TRIP, verbatim)
 * - `permission`      403 without a policy marker — the credential is valid; this
 *                     model/region/resource is not permitted to it. Per-model, not
 *                     provider-wide, so it must NOT disable a provider that is
 *                     answering. (fallback, success, WITHHELD)
 * - `rate_limit`      429. (fallback, TRIP, verbatim)
 * - `unavailable`     5xx/408/409/405/415, network, timeouts, wrong-path 404/410.
 *                     (fallback, TRIP, verbatim)
 * - `bad_request`     400/413/422 — the caller's own malformed request, which every
 *                     chain member would reject identically. (NO fallback, success,
 *                     withheld)
 * - `unknown_model`   404/410 whose body names a missing or retired model.
 *                     (fallback, success, verbatim)
 * - `insufficient_funds` 402 — the provider account cannot pay. Rejects every request
 *                     until a human tops it up, so it trips. (fallback, TRIP, WITHHELD)
 * - `content_policy`  403 carrying a moderation marker — one provider's content
 *                     opinion, which another may not share. (fallback, success,
 *                     policy-withheld)
 * - `policy_block`    451 — a legally-mandated denial. The router CAN try another
 *                     member and deliberately MUST NOT: walking on would make this an
 *                     automatic circumvention mechanism. (NO fallback, success,
 *                     policy-withheld)
 * - `upstream_rejected` any other 4xx — an upstream refusal we could not classify.
 *                     Evidence of nothing, so strictly NEUTRAL: it must not erase a
 *                     provider's accumulated failures. (fallback, NEUTRAL, withheld)
 * - `credential`      A local credential-resolution failure (add-subscription-oauth):
 *                     a revoked OAuth grant (`reauthorize required`) or a transient
 *                     identity-provider outage. Fallback-eligible (the chain moves on)
 *                     but breaker-NEUTRAL — credential state and IdP availability are
 *                     not upstream provider health.
 */
export const PROVIDER_ERROR_KINDS = [
  'auth',
  'permission',
  'rate_limit',
  'unavailable',
  'bad_request',
  'unknown_model',
  'insufficient_funds',
  'content_policy',
  'policy_block',
  'upstream_rejected',
  'credential',
] as const;

export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

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

/**
 * The proxy (#10) walks its chain on these. Exactly TWO kinds stop the walk, and
 * they stop it for DIFFERENT reasons — do not merge these branches:
 *   - `bad_request`  the caller's fault; every member would reject it identically,
 *                    so walking on is pure waste.
 *   - `policy_block` a 451 legal denial; another member might well SERVE it, and
 *                    that is exactly why we must not try (fix-4xx-error-taxonomy).
 * The first is futility, the second is principle. A refactor that collapses them
 * into "the caller's fault" reintroduces an automatic circumvention path.
 */
export function shouldFallback(kind: ProviderErrorKind): boolean {
  return kind !== 'bad_request' && kind !== 'policy_block';
}

/** What opens the provider-level breaker. Only conditions that make the provider
 * unusable for EVERY request trip: a bad credential (`auth`), saturation
 * (`rate_limit`), an outage (`unavailable`), and a dry account
 * (`insufficient_funds` — it rejects everything until a human tops it up).
 * Everything else describes one request or one model: `unknown_model` is
 * model-specific, `bad_request` is the client's fault, and `permission` /
 * `content_policy` / `policy_block` are per-request decisions from a provider
 * that is demonstrably answering — none may disable it (fix-4xx-error-taxonomy). */
export function breakerImpact(kind: ProviderErrorKind): boolean {
  return (
    kind === 'rate_limit' ||
    kind === 'unavailable' ||
    kind === 'auth' ||
    kind === 'insufficient_funds'
  );
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
  const envelope = parseErrorEnvelope(bodyText);
  const [kind, curated] = ((): [ProviderErrorKind, string] => {
    // 401 and 403 do NOT share a kind. Every provider protocol polyrouter targets
    // separates them — an invalid or revoked credential is 401, while 403 is a
    // permission decision about a resource (region, model, org policy). Reading a
    // 403 as `auth` opened the breaker on providers that were answering every other
    // request (fix-4xx-error-taxonomy).
    if (status === 401) return ['auth', `provider auth failed (401)`];
    if (status === 403) {
      return hasContentPolicyMarker(envelope)
        ? ['content_policy', `provider refused on content policy (403)`]
        : ['permission', `provider denied permission (403)`];
    }
    if (status === 402)
      return ['insufficient_funds', `provider account cannot pay for the request (402)`];
    if (status === 429) return ['rate_limit', `provider rate limited (429)`];
    // 404 and 410 share one rule: a missing MODEL only when the body says so,
    // otherwise a wrong path — a provider-misconfig `unavailable`.
    if (status === 404 || status === 410) {
      return isModelNotFound(bodyText)
        ? ['unknown_model', `model not found (${String(status)})`]
        : ['unavailable', `provider endpoint not found (${String(status)})`];
    }
    // A legally-mandated denial. Fallback-INELIGIBLE on principle, not futility:
    // another member might well serve it, and routing around it automatically is
    // exactly what must not happen (RFC 7725).
    if (status === 451) return ['policy_block', `provider denied for legal reasons (451)`];
    if (status === 400 || status === 422 || status === 413) {
      return ['bad_request', `provider rejected the request (${String(status)}): ${snippet}`];
    }
    // A wrong method or media type against the configured base URL is provider
    // misconfiguration, in the same family as a wrong-path 404.
    if (status === 405 || status === 415)
      return ['unavailable', `provider rejected the transport (${String(status)})`];
    if (status === 408 || status === 409 || status >= 500) {
      return ['unavailable', `provider unavailable (${String(status)})`];
    }
    // Any other 4xx. An ambiguous rejection fails toward the router's promise: a
    // wasted attempt costs one call, an abandoned chain costs invariant 1. Strictly
    // breaker-NEUTRAL — a response we could not classify is evidence of nothing and
    // must not erase a provider's real failure history.
    if (status >= 400) {
      return ['upstream_rejected', `provider rejected the request (${String(status)})`];
    }
    return ['unavailable', `unexpected provider status (${String(status)})`];
  })();
  const providerMessage = captureProviderMessage(
    { source: 'parsed-envelope', envelope },
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
/** fix-4xx-error-taxonomy. Neither 402 nor 403 guarantees its body's semantics
 * (402 is formally reserved; 403 is a bare refusal), custom and aggregating
 * endpoints may return anything under either, and `scrubSecrets` removes credential
 * SHAPES but cannot detect arbitrary echoed prompt text — so the status alone cannot
 * establish the body is safe to persist (invariant 8). The KIND carries the
 * operator's diagnosis; the body would add only provider phrasing. */
export const FUNDS_WITHHELD = '[insufficient-funds message withheld]';
export const PERMISSION_WITHHELD = '[permission message withheld]';

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
    // Nested provider-classification metadata (fix-4xx-error-taxonomy): aggregating
    // gateways commonly carry the REAL classification one level down (e.g. an
    // OpenRouter `error.metadata.error_type`), so an outward-only check misses
    // exactly the provider shape that produced the reported incident.
    markers.push(...metadataMarkers(rec['metadata']));
    if (message === undefined && typeof rec['message'] === 'string') {
      message = rec['message'];
    }
    node = rec['error'];
  }
  return { ...(message !== undefined ? { message } : {}), markers };
}

/** String-valued entries of a `metadata` object, one level deep (arrays of strings
 * included). Bounded and total — never throws on a hostile shape. */
function metadataMarkers(metadata: unknown): string[] {
  if (typeof metadata !== 'object' || metadata === null) return [];
  const out: string[] = [];
  for (const value of Object.values(metadata as Record<string, unknown>)) {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string') out.push(item);
    }
  }
  return out;
}

/**
 * The ONE content-policy signal, shared by the KIND decision (`classifyResponse`'s
 * 403 refinement) and the MESSAGE decision (`captureProviderMessage`), so the two
 * cannot drift apart (fix-4xx-error-taxonomy). Reads the outward `type`/`code`, the
 * same fields on nested `error` objects, and nested classification metadata.
 */
export function hasContentPolicyMarker(envelope: unknown): boolean {
  return walkEnvelope(envelope).markers.some((m) => POLICY_MARKER.test(m));
}

/**
 * The ONLY producer of a persistable provider message (add-request-error-detail).
 * Structured `error.message` strings only — a shapeless/non-JSON body yields null
 * (raw text NEVER persists). Kind-based verbatim policy: operational kinds
 * verbatim (scrubbed); `bad_request`/validation withheld (validation errors
 * routinely echo submitted content); a content-policy marker in type OR code
 * withheld with its own marker (checked first). `insufficient_funds`, `permission`,
 * and `upstream_rejected` withhold too (fix-4xx-error-taxonomy) — see the marker
 * constants. Scrub before cap.
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
  if (ctx.kind === 'content_policy' || ctx.kind === 'policy_block') {
    return POLICY_WITHHELD as SanitizedMessage;
  }
  if (markers.some((m) => POLICY_MARKER.test(m))) return POLICY_WITHHELD as SanitizedMessage;
  // Each of these withholds under a marker naming its OWN reason, so the drawer never
  // mislabels a credit or permission failure as a validation error.
  if (ctx.kind === 'insufficient_funds') return FUNDS_WITHHELD as SanitizedMessage;
  if (ctx.kind === 'permission') return PERMISSION_WITHHELD as SanitizedMessage;
  if (
    ctx.kind === 'bad_request' ||
    // An unrecognized upstream body carries no guarantee of being content-free, and
    // invariant 8 outranks diagnosability for a status we could not classify.
    ctx.kind === 'upstream_rejected' ||
    markers.some((m) => classifyStreamError(m) === 'bad_request')
  ) {
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
  // `quota` stays with `rate` deliberately: it is ambiguous between a rate quota and
  // a credit quota, and this change does not guess where today's answer is defensible.
  if (t.includes('rate') || t.includes('quota')) return 'rate_limit';
  if (POLICY_MARKER.test(t)) return 'content_policy';
  if (t.includes('credit') || t.includes('billing') || t.includes('payment')) {
    return 'insufficient_funds';
  }
  // Mirror the HTTP 401/403 split exactly: collapsing `permission` into `auth` here
  // would trip the breaker for the same wrong reason 403 did (fix-4xx-error-taxonomy).
  if (t.includes('permission') || t.includes('forbidden')) return 'permission';
  if (t.includes('auth')) return 'auth';
  if (t.includes('not_found') || t.includes('not found')) return 'unknown_model';
  if (t.includes('invalid_request') || t.includes('invalid')) return 'bad_request';
  return 'unavailable';
}
