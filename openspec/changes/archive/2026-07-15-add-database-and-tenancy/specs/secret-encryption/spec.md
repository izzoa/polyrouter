# secret-encryption — delta

## ADDED Requirements

### Requirement: Authenticated encryption for credentials at rest
`@polyrouter/shared/server` SHALL provide `encryptSecret(plaintext, key)` and `decryptSecret(envelope, key)` using AES-256-GCM with a fresh random IV per call and a versioned envelope format (`poly-enc:v1:<iv>:<tag>:<ciphertext>`), for provider credentials (#7) and notification-channel config (#15) per CLAUDE.md invariant 8. Keys are 32-byte-hex values supplied by callers; key-material env vars belong to the consuming changes.

#### Scenario: Round trip
- **WHEN** a plaintext is encrypted and the envelope decrypted with the same key
- **THEN** the original plaintext is returned, and the envelope never equals or contains the plaintext

#### Scenario: Unique ciphertexts
- **WHEN** the same plaintext is encrypted twice with the same key
- **THEN** the envelopes differ (fresh IV per call)

#### Scenario: Tampering and wrong keys fail closed
- **WHEN** the envelope is modified or decryption uses a different key
- **THEN** decryption throws (GCM auth failure) instead of returning corrupted plaintext

### Requirement: Failures never leak secret material
Errors thrown by the encryption utility (bad key format, malformed envelope, auth failure) SHALL name the operation and reason only — never the plaintext, the key, or ciphertext contents (secrets must never reach logs, invariant 8).

#### Scenario: Error text is clean
- **WHEN** decryption fails for any reason with a known plaintext and key in scope
- **THEN** the thrown message and stack contain neither the plaintext, the key, nor the envelope body
