import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../src/server';

const key = randomBytes(32).toString('hex');
const otherKey = randomBytes(32).toString('hex');
const plaintext = 'sk-super-secret-provider-credential-12345';

describe('secret encryption (secret-encryption)', () => {
  it('round-trips and the envelope never contains the plaintext', () => {
    const envelope = encryptSecret(plaintext, key);
    expect(envelope.startsWith('poly-enc:v1:')).toBe(true);
    expect(envelope).not.toContain(plaintext);
    expect(decryptSecret(envelope, key)).toBe(plaintext);
  });

  it('produces unique ciphertexts for the same plaintext (fresh IV)', () => {
    expect(encryptSecret(plaintext, key)).not.toBe(encryptSecret(plaintext, key));
  });

  it('fails closed on tampering', () => {
    const envelope = encryptSecret(plaintext, key);
    const parts = envelope.split(':');
    const body = Buffer.from(parts[4]!, 'base64');
    body[0] = (body[0]! + 1) % 256;
    parts[4] = body.toString('base64');
    expect(() => decryptSecret(parts.join(':'), key)).toThrow(/decryption failed/);
  });

  it('fails closed with the wrong key', () => {
    const envelope = encryptSecret(plaintext, key);
    expect(() => decryptSecret(envelope, otherKey)).toThrow(/decryption failed/);
  });

  it('rejects malformed envelopes and bad keys', () => {
    expect(() => decryptSecret('not-an-envelope', key)).toThrow(/malformed envelope/);
    expect(() => decryptSecret('poly-enc:v9:a:b:c', key)).toThrow(/unsupported envelope version/);
    expect(() => encryptSecret(plaintext, 'short-key')).toThrow(/32 bytes of hex/);
  });

  it('never leaks plaintext, key, or envelope body through errors', () => {
    const envelope = encryptSecret(plaintext, key);
    const envelopeBody = envelope.split(':').slice(2).join(':');
    const failures: Array<() => void> = [
      () => decryptSecret(envelope, otherKey),
      () => decryptSecret(envelope.slice(0, -4), key),
      () => encryptSecret(plaintext, 'bad'),
      () => decryptSecret('poly-enc:v9:a:b:c', key),
    ];
    for (const fail of failures) {
      try {
        fail();
        expect.unreachable('should have thrown');
      } catch (error) {
        const text = `${(error as Error).message}\n${(error as Error).stack ?? ''}`;
        expect(text).not.toContain(plaintext);
        expect(text).not.toContain(key);
        expect(text).not.toContain(otherKey);
        expect(text).not.toContain(envelopeBody);
      }
    }
  });
});
