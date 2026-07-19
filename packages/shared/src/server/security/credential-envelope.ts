/**
 * Typed credential envelope (add-subscription-oauth). The DECRYPTED content of
 * `provider.encrypted_credentials` is either:
 *
 *   - a legacy raw string (every pre-existing row) — read as `plain`, or
 *   - `polycred:v1:` + JSON `{ v:1, kind:'plain', value }` | `{ v:1, kind:'oauth', … }`.
 *
 * Every NEW write serializes the typed form. Plain writes WRAP user input, so a
 * pasted `polycred:v1:…` lookalike becomes a `plain` credential whose value contains
 * that string — the `oauth` kind is unforgeable through every paste path by
 * construction (only the connect/refresh code path calls `serializeOauthCredential`).
 * Marker-prefixed content that fails to parse is a typed tampered-envelope error,
 * NEVER a silent fallback to plain.
 *
 * SECURITY: fixed error messages only — never the content (invariant 8).
 */

export const POLYCRED_MARKER = 'polycred:v1:';

/** Structured OAuth credential (per-preset extensible; `expiresAt` is epoch ms). */
export interface OauthCredential {
  readonly preset: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  /** Per-preset extension (add-chatgpt-responses): the ChatGPT account id captured
   * from the exchange `id_token`. Lives ONLY in the envelope — never logged, echoed,
   * or exposed — and is retained across refresh rotations. */
  readonly accountId?: string;
}

export type ParsedCredential =
  | { readonly kind: 'plain'; readonly value: string }
  | { readonly kind: 'oauth'; readonly cred: OauthCredential };

/** Thrown for marker-prefixed content that does not parse as a valid typed payload. */
export class TamperedCredentialError extends Error {
  constructor() {
    super('credential-envelope: malformed typed credential');
    this.name = 'TamperedCredentialError';
  }
}

export function serializePlainCredential(value: string): string {
  return POLYCRED_MARKER + JSON.stringify({ v: 1, kind: 'plain', value });
}

export function serializeOauthCredential(cred: OauthCredential): string {
  return (
    POLYCRED_MARKER +
    JSON.stringify({
      v: 1,
      kind: 'oauth',
      preset: cred.preset,
      accessToken: cred.accessToken,
      refreshToken: cred.refreshToken,
      expiresAt: cred.expiresAt,
      ...(cred.accountId !== undefined ? { accountId: cred.accountId } : {}),
    })
  );
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Advisory-lock key for a provider's credential mutations (add-subscription-oauth).
 * Refresh, PATCH rotate/clear, and reauthorize completion all serialize on this key so
 * a refresh can never clobber or resurrect a concurrent user mutation (rotation
 * safety). FNV-1a over the provider id, folded to a positive int32 (the advisory-lock
 * facility takes a number). */
export function credentialLockKey(providerId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < providerId.length; i += 1) {
    h ^= providerId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) & 0x7fffffff;
}

/** Unwrap a decrypted envelope expected to hold a PLAIN credential (legacy raw or
 * typed plain). An `oauth` envelope here is a wiring error — OAuth credentials resolve
 * only through the subscription-oauth seam — so it fails typed rather than ever being
 * used as a bearer string. */
export function resolvePlainCredentialValue(decrypted: string): string {
  const parsed = parseCredentialEnvelope(decrypted);
  if (parsed.kind === 'plain') return parsed.value;
  throw new TamperedCredentialError();
}

export function parseCredentialEnvelope(decrypted: string): ParsedCredential {
  if (!decrypted.startsWith(POLYCRED_MARKER)) {
    // Legacy raw string — every pre-existing credential, unchanged semantics.
    return { kind: 'plain', value: decrypted };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(decrypted.slice(POLYCRED_MARKER.length));
  } catch {
    throw new TamperedCredentialError();
  }
  if (typeof doc !== 'object' || doc === null) throw new TamperedCredentialError();
  const rec = doc as Record<string, unknown>;
  if (rec['v'] !== 1) throw new TamperedCredentialError();
  if (rec['kind'] === 'plain' && typeof rec['value'] === 'string') {
    return { kind: 'plain', value: rec['value'] };
  }
  if (
    rec['kind'] === 'oauth' &&
    typeof rec['preset'] === 'string' &&
    typeof rec['accessToken'] === 'string' &&
    typeof rec['refreshToken'] === 'string' &&
    isFiniteNumber(rec['expiresAt']) &&
    // Optional accountId: absent is fine; PRESENT-but-wrong-shape is tampering.
    (rec['accountId'] === undefined ||
      (typeof rec['accountId'] === 'string' && rec['accountId'] !== ''))
  ) {
    return {
      kind: 'oauth',
      cred: {
        preset: rec['preset'],
        accessToken: rec['accessToken'],
        refreshToken: rec['refreshToken'],
        expiresAt: rec['expiresAt'],
        ...(rec['accountId'] !== undefined ? { accountId: rec['accountId'] } : {}),
      },
    };
  }
  throw new TamperedCredentialError();
}
