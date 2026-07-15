import { createHmac } from 'node:crypto';
import { hmacKey, mintAgentKey, prefixOf, verifyAgentKey } from './agent-keys';

const secret = 'a'.repeat(64);

describe('agent-keys (agent-keys)', () => {
  it('mints poly_ keys with a 12-payload-char prefix and matching HMAC', () => {
    const { key, prefix, hash } = mintAgentKey(secret);
    expect(key).toMatch(/^poly_[A-Za-z0-9_-]{32}$/);
    expect(prefix).toBe(`poly_${key.slice(5, 17)}`);
    expect(prefixOf(key)).toBe(prefix);
    expect(hash).toBe(hmacKey(key, secret));
    expect(hash).not.toContain(key);
  });

  it('verifies a correct key and rejects tampered keys, wrong secrets, prefix mismatches', () => {
    const { key, hash } = mintAgentKey(secret);
    expect(verifyAgentKey(key, hash, secret)).toBe(true);
    expect(verifyAgentKey(`${key}x`, hash, secret)).toBe(false);
    expect(verifyAgentKey(key, hash, 'b'.repeat(64))).toBe(false);
    const other = mintAgentKey(secret);
    expect(verifyAgentKey(other.key, hash, secret)).toBe(false);
  });

  it('the stored hash and verification are exactly plain HMAC-SHA256 — no KDF (by construction)', () => {
    // Determinism: identical (key, secret) → identical hash on every call. A
    // per-call salted KDF (scrypt/bcrypt/pbkdf2 with random salt) could not be.
    const { key, hash } = mintAgentKey(secret);
    expect(hmacKey(key, secret)).toBe(hash);
    expect(hmacKey(key, secret)).toBe(hmacKey(key, secret));
    // The stored hash equals a plain HMAC-SHA256 computed independently.
    const expected = createHmac('sha256', secret).update(key).digest('hex');
    expect(hash).toBe(expected);
    // Verification is exactly "does HMAC(key) equal the stored hash" — for many
    // inputs it agrees with a raw HMAC equality (a KDF verify would not).
    for (let i = 0; i < 25; i++) {
      const k = mintAgentKey(secret);
      const rawEquality = createHmac('sha256', secret).update(k.key).digest('hex') === k.hash;
      expect(verifyAgentKey(k.key, k.hash, secret)).toBe(rawEquality);
      expect(verifyAgentKey(`${k.key}x`, k.hash, secret)).toBe(false);
    }
  });

  it('rejects non-poly and too-short keys at prefix extraction', () => {
    expect(prefixOf('sk-not-ours')).toBeNull();
    expect(prefixOf('poly_short')).toBeNull();
  });
});
