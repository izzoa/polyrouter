import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Agent API key primitives (invariant 7: HMAC + prefix, never a KDF). The
 * verification path is deliberately only HMAC-SHA256 + a constant-time compare
 * — asserted by construction in the unit tests, not merely by timing. */

const KEY_PREFIX = 'poly_';
const PAYLOAD_BYTES = 24;
const STORED_PREFIX_PAYLOAD_CHARS = 12;

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export interface MintedKey {
  key: string;
  prefix: string;
  hash: string;
}

export function hmacKey(key: string, secret: string): string {
  return createHmac('sha256', secret).update(key).digest('hex');
}

/** `poly_` + 32 base64url chars (24 random bytes). Stored prefix is `poly_`
 * plus the first 12 payload chars (~72 bits — effectively collision-free). */
export function mintAgentKey(secret: string): MintedKey {
  const payload = base64url(randomBytes(PAYLOAD_BYTES));
  const key = KEY_PREFIX + payload;
  const prefix = KEY_PREFIX + payload.slice(0, STORED_PREFIX_PAYLOAD_CHARS);
  return { key, prefix, hash: hmacKey(key, secret) };
}

/** The prefix a presented key would have been stored under (for lookup). */
export function prefixOf(key: string): string | null {
  if (!key.startsWith(KEY_PREFIX)) return null;
  const payload = key.slice(KEY_PREFIX.length);
  if (payload.length < STORED_PREFIX_PAYLOAD_CHARS) return null;
  return KEY_PREFIX + payload.slice(0, STORED_PREFIX_PAYLOAD_CHARS);
}

/** Constant-time comparison of the presented key's HMAC against the stored
 * hash. Only HMAC + timingSafeEqual — no slow hash on this hot path. */
export function verifyAgentKey(key: string, storedHash: string, secret: string): boolean {
  const candidate = Buffer.from(hmacKey(key, secret), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}
