/**
 * OAuth token exchange + refresh against a preset's FIXED endpoint
 * (add-subscription-oauth). Mirrors the pricing LiteLLM fetch's guardrails:
 * SSRF-guarded dispatcher (defense-in-depth on a constant URL), 3xx rejected,
 * bounded timeout, streaming size cap. Responses are UNTRUSTED: a hostile body is
 * never echoed into errors/logs (invariant 8) — failures map to a typed class
 * distinguishing `invalid_grant` (the reauthorize signal) from `transient`.
 */
import { fetch as undiciFetch } from 'undici';
import {
  SsrfError,
  assertUrlSafe,
  createGuardedDispatcher,
  type UrlGuardOptions,
} from '@polyrouter/shared/server';
import { readCapped } from '../pricing/litellm-fetch';

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 64 * 1024;

export type TokenFailureKind = 'invalid_grant' | 'transient';

export class TokenEndpointError extends Error {
  readonly kind: TokenFailureKind;
  constructor(kind: TokenFailureKind) {
    // Fixed message — the endpoint's response body is untrusted and never included.
    super(kind === 'invalid_grant' ? 'oauth grant rejected' : 'oauth token endpoint unavailable');
    this.name = 'TokenEndpointError';
    this.kind = kind;
  }
}

export interface TokenSet {
  readonly accessToken: string;
  /** Always present on an authorization-code exchange (required); MAY be absent on a
   * refresh response (non-rotating endpoints) — the caller then RETAINS the stored one. */
  readonly refreshToken?: string;
  /** Absolute epoch ms, from the response's expires_in against the local clock. */
  readonly expiresAt: number;
  /** OIDC id_token, surfaced from the EXCHANGE response only (add-chatgpt-responses:
   * the account-id claim source) — never from a refresh. Untrusted until the caller's
   * strict claim extraction; never logged. */
  readonly idToken?: string;
}

export interface ExchangeInput {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly mode: 'selfhosted' | 'cloud';
  readonly body: Record<string, string>;
  /** Preset-declared body encoding (add-chatgpt-responses): Claude's endpoint takes
   * JSON (the default — SO-1 behavior unchanged); auth.openai.com takes
   * application/x-www-form-urlencoded. */
  readonly encoding?: 'json' | 'form';
  /** Which grant this call is. Defaults to 'exchange' — the STRICTER parse
   * (refresh_token required), so a missed call site fails closed. */
  readonly grant?: 'exchange' | 'refresh';
}

/** Injectable for tests (stub IdP). */
export type OauthTokenFetch = (input: ExchangeInput) => Promise<TokenSet>;

/** The exact outbound request (exported for unit tests — the wire-encoding
 * contract is preset-declared and must be pinnable without network).
 *
 * `Accept-Encoding: identity` is deliberate (found in live verification): undici
 * otherwise advertises zstd/br, and a compressed IdP response the runtime cannot
 * decode surfaces as an unhandled stream error — a ≤64KB JSON body needs no
 * compression, and the identity form also makes the read cap a WIRE-byte cap. */
export function buildTokenRequest(input: ExchangeInput): {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
} {
  const params = { ...input.body, client_id: input.clientId };
  const form = (input.encoding ?? 'json') === 'form';
  return {
    headers: {
      'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json',
      'Accept-Encoding': 'identity',
    },
    body: form ? new URLSearchParams(params).toString() : JSON.stringify(params),
  };
}

export function parseTokenSet(text: string, now: number, grant: 'exchange' | 'refresh'): TokenSet {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new TokenEndpointError('transient');
  }
  if (typeof doc !== 'object' || doc === null) throw new TokenEndpointError('transient');
  const rec = doc as Record<string, unknown>;
  const access = rec['access_token'];
  const refresh = rec['refresh_token'];
  const expiresIn = rec['expires_in'];
  if (typeof access !== 'string' || access === '') throw new TokenEndpointError('transient');
  const refreshToken = typeof refresh === 'string' && refresh !== '' ? refresh : undefined;
  // The exchange REQUIRES a refresh token (a grant we cannot renew is dead on
  // arrival); a refresh response may omit it (non-rotating endpoints — retained by
  // the caller).
  if (grant === 'exchange' && refreshToken === undefined) throw new TokenEndpointError('transient');
  const idToken = rec['id_token'];
  const seconds = typeof expiresIn === 'number' && Number.isFinite(expiresIn) ? expiresIn : 3600;
  return {
    accessToken: access,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    expiresAt: now + seconds * 1000,
    // id_token surfaces from the EXCHANGE only — a refresh response's is ignored.
    ...(grant === 'exchange' && typeof idToken === 'string' && idToken !== ''
      ? { idToken }
      : {}),
  };
}

/** Only an explicit dead-grant token in the (bounded, untrusted) body marks the grant
 * dead — reauthorization is the fix ONLY for a revoked/expired grant. TWO shapes are
 * recognized, both verified against the live endpoints:
 *
 *   - RFC 6749 flat: `{"error": "invalid_grant"}` (console.anthropic.com), and
 *   - auth.openai.com's NESTED object: `{"error": {"code": "token_expired" | "invalid_grant"}}`
 *     (observed live during ChatGPT verification — an expired/invalid code returns
 *     401 with `code: "token_expired"`; the flat check alone would classify every
 *     dead grant as transient and loop "try again" forever).
 *
 * Every other 4xx (`invalid_request`, `invalid_client`, malformed bodies, hostile
 * content) and all 5xx/429 are `transient`: the stored tokens stay untouched and the
 * backoff prevents hammering. Nothing from the body ever reaches an error message. */
export function classifyTokenFailure(status: number, bodyText: string): TokenFailureKind {
  if (status === 400 || status === 401 || status === 403) {
    try {
      const doc: unknown = JSON.parse(bodyText);
      if (typeof doc !== 'object' || doc === null) return 'transient';
      const err = (doc as Record<string, unknown>)['error'];
      if (err === 'invalid_grant') return 'invalid_grant';
      if (typeof err === 'object' && err !== null) {
        const code = (err as Record<string, unknown>)['code'];
        if (code === 'invalid_grant' || code === 'token_expired') return 'invalid_grant';
      }
    } catch {
      /* unparseable body → transient */
    }
  }
  return 'transient';
}

export async function fetchTokenSet(input: ExchangeInput): Promise<TokenSet> {
  const guard: UrlGuardOptions = { context: { mode: input.mode } }; // no loopback exception
  await assertUrlSafe(input.tokenEndpoint, guard);
  const dispatcher = createGuardedDispatcher(guard);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const outbound = buildTokenRequest(input);
    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await undiciFetch(input.tokenEndpoint, {
        method: 'POST',
        redirect: 'manual',
        dispatcher,
        signal: controller.signal,
        headers: { ...outbound.headers },
        body: outbound.body,
      });
    } catch (err) {
      if (err instanceof TypeError && err.cause instanceof SsrfError) throw err.cause;
      throw new TokenEndpointError('transient');
    }
    const text = await readCapped(
      res.body as ReadableStream<Uint8Array> | null,
      MAX_BYTES,
    ).catch(() => {
      throw new TokenEndpointError('transient');
    });
    if (res.status >= 200 && res.status < 300) {
      return parseTokenSet(text, Date.now(), input.grant ?? 'exchange');
    }
    throw new TokenEndpointError(classifyTokenFailure(res.status, text));
  } finally {
    clearTimeout(timer);
    await dispatcher.close().catch(() => undefined);
  }
}
