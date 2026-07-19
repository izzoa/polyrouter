import { describe, expect, it } from 'vitest';
import {
  POLYCRED_MARKER,
  TamperedCredentialError,
  parseCredentialEnvelope,
  serializeOauthCredential,
  serializePlainCredential,
} from '../src/server/security/credential-envelope';

describe('credential envelope (add-subscription-oauth)', () => {
  it('round-trips a plain credential (wrapped)', () => {
    const s = serializePlainCredential('sk-secret-123');
    expect(s.startsWith(POLYCRED_MARKER)).toBe(true);
    expect(parseCredentialEnvelope(s)).toEqual({ kind: 'plain', value: 'sk-secret-123' });
  });

  it('round-trips an OAuth credential', () => {
    const cred = {
      preset: 'claude',
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: 1_800_000_000_000,
    };
    expect(parseCredentialEnvelope(serializeOauthCredential(cred))).toEqual({
      kind: 'oauth',
      cred,
    });
  });

  it('reads a legacy raw string as plain (pre-existing rows unchanged)', () => {
    expect(parseCredentialEnvelope('sk-legacy')).toEqual({ kind: 'plain', value: 'sk-legacy' });
  });

  it('FORGERY: a pasted marker-lookalike wrapped as plain stays plain', () => {
    // A user pastes what looks like a typed oauth payload into a credential box.
    const pasted = `${POLYCRED_MARKER}{"v":1,"kind":"oauth","preset":"claude","accessToken":"x","refreshToken":"y","expiresAt":1}`;
    // Every plain write path WRAPS user input — so the stored envelope is plain,
    // and parsing returns the pasted string as an opaque value, never kind:'oauth'.
    const stored = serializePlainCredential(pasted);
    const parsed = parseCredentialEnvelope(stored);
    expect(parsed.kind).toBe('plain');
    expect(parsed.kind === 'plain' && parsed.value).toBe(pasted);
  });

  it('marker-prefixed but malformed is a typed tampered error, never silent plain', () => {
    for (const bad of [
      `${POLYCRED_MARKER}not-json`,
      `${POLYCRED_MARKER}{"v":2,"kind":"plain","value":"x"}`,
      `${POLYCRED_MARKER}{"v":1,"kind":"oauth","preset":"claude"}`,
      `${POLYCRED_MARKER}{"v":1,"kind":"oauth","preset":"claude","accessToken":"a","refreshToken":"r","expiresAt":"soon"}`,
      `${POLYCRED_MARKER}null`,
    ]) {
      expect(() => parseCredentialEnvelope(bad)).toThrow(TamperedCredentialError);
    }
  });
});
