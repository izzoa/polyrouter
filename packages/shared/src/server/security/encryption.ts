import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Encrypt-at-rest primitives for provider credentials (#7) and notification
 * channel config (#15) — CLAUDE.md invariant 8. AES-256-GCM with a fresh IV
 * per call and a versioned envelope. Keys are 32-byte-hex strings supplied by
 * callers; key-material env vars belong to the consuming changes.
 *
 * SECURITY: every error thrown here uses a fixed message — never the
 * plaintext, the key, or envelope contents. Secrets must never reach logs. */

const PREFIX = 'poly-enc';
const VERSION = 'v1';
const IV_BYTES = 12;

function parseKey(keyHex: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) {
    throw new Error('secret-encryption: key must be 32 bytes of hex (openssl rand -hex 32)');
  }
  return Buffer.from(keyHex, 'hex');
}

export function encryptSecret(plaintext: string, keyHex: string): string {
  const key = parseKey(keyHex);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    PREFIX,
    VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export function decryptSecret(envelope: string, keyHex: string): string {
  const key = parseKey(keyHex);
  const parts = envelope.split(':');
  if (parts.length !== 5 || parts[0] !== PREFIX) {
    throw new Error('secret-encryption: malformed envelope');
  }
  if (parts[1] !== VERSION) {
    throw new Error('secret-encryption: unsupported envelope version');
  }
  const [, , ivB64, tagB64, ciphertextB64] = parts;
  try {
    const tag = Buffer.from(tagB64 ?? '', 'base64');
    // Pin the GCM tag to the full 16 bytes (A-40): Node accepts 4–16-byte tags, and
    // a truncated tag weakens forgery resistance. `encryptSecret` always emits 16, so
    // any other length is a malformed/tampered envelope — reject it (the catch below
    // rethrows the fixed, secret-free message).
    if (tag.length !== 16) throw new Error('bad auth tag length');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64 ?? '', 'base64'));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextB64 ?? '', 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('secret-encryption: decryption failed (wrong key or tampered data)');
  }
}
