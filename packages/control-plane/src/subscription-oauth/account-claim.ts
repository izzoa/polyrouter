/**
 * ChatGPT account-id claim extraction (add-chatgpt-responses). The exchange
 * response's `id_token` carries the account id the Responses backend addresses
 * requests by, at the NESTED claim `payload["https://api.openai.com/auth"]
 * .chatgpt_account_id`. Decoding is local and strict — 3-part split, size-capped
 * base64url payload, charset-validated — with NO signature verification: the value
 * is an addressing hint the backend re-authenticates on every request, not an auth
 * input. The value is later emitted as the `chatgpt-account-id` HTTP header, so it
 * must be header-safe; anything else is rejected. Failures are a fixed-message
 * typed error — the token, payload, and claim are NEVER logged or echoed
 * (invariant 8).
 */

const AUTH_CLAIM = 'https://api.openai.com/auth';
/** Bound on the base64url payload segment (a real id_token payload is ~1 KB). */
const MAX_PAYLOAD_B64_CHARS = 64 * 1024;
/** Bound on the extracted id (real ids are UUID-sized); over-long is rejected, not truncated. */
const MAX_ACCOUNT_ID_LEN = 128;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
/** Header-safe charset — the value goes into the `chatgpt-account-id` header verbatim. */
const ACCOUNT_ID_RE = /^[A-Za-z0-9._-]+$/;

/** Fixed message only — never the token or any claim content. */
export class AccountClaimError extends Error {
  constructor() {
    super('sign-in response did not carry a usable account id');
    this.name = 'AccountClaimError';
  }
}

export function extractChatgptAccountId(idToken: string): string {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new AccountClaimError();
  const payloadB64 = parts[1]!;
  // Node's base64url decoder is lenient — charset-validate BEFORE decoding.
  if (
    payloadB64 === '' ||
    payloadB64.length > MAX_PAYLOAD_B64_CHARS ||
    !BASE64URL_RE.test(payloadB64)
  ) {
    throw new AccountClaimError();
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw new AccountClaimError();
  }
  if (typeof payload !== 'object' || payload === null) throw new AccountClaimError();
  const auth = (payload as Record<string, unknown>)[AUTH_CLAIM];
  if (typeof auth !== 'object' || auth === null) throw new AccountClaimError();
  const id = (auth as Record<string, unknown>)['chatgpt_account_id'];
  if (
    typeof id !== 'string' ||
    id === '' ||
    id.length > MAX_ACCOUNT_ID_LEN ||
    !ACCOUNT_ID_RE.test(id)
  ) {
    throw new AccountClaimError();
  }
  return id;
}
