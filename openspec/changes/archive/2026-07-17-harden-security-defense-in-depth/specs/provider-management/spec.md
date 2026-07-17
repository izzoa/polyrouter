## MODIFIED Requirements

### Requirement: Provider credentials are encrypted at rest and never disclosed

The system SHALL encrypt a provider credential at rest with the shared `encryptSecret` util under `PROVIDER_CREDENTIAL_KEY`, storing only the envelope in `encrypted_credentials`. The plaintext SHALL exist only in-memory for the request that supplies it and SHALL be decrypted only to construct a provider adapter for `test-connection`/`sync-models`. Decryption SHALL require the AES-256-GCM authentication tag to be the full **16 bytes** — a truncated or wrong-length tag (which would weaken forgery resistance, since GCM otherwise accepts 4–16-byte tags) SHALL be rejected as a tampered/malformed envelope with the fixed, secret-free failure message. No API response SHALL return the credential (plaintext or envelope) and no log line SHALL contain it (CLAUDE.md invariant 8); the safe provider shape SHALL expose a `hasCredential` boolean instead.

#### Scenario: The stored credential is an encrypted envelope, not plaintext

- **WHEN** a provider is created with a credential
- **THEN** the `encrypted_credentials` column holds a `poly-enc:` envelope, not the plaintext
- **AND** the create/get/list responses contain `hasCredential: true` but never the credential value

#### Scenario: A failing action never leaks the credential, even if the endpoint reflects it

- **WHEN** `test-connection` or `sync-models` fails — including a hostile endpoint that reflects the `Authorization`/`x-api-key` header in its error body (which #6's classifier may include up to 200 bytes of) **or in an `x-request-id` header** (which #6 surfaces as `ProviderError.requestId`)
- **THEN** the action result and every log line carry only a fixed public message keyed on `{ kind, status }` plus an **internally-generated `traceId`** — never the adapter's raw message, the thrown error, the adapter config, the upstream `requestId`, or the credential
- **AND** the credential is decrypted only in-memory to build the adapter

#### Scenario: A truncated GCM auth tag is rejected

- **WHEN** a stored envelope is tampered to carry an auth tag shorter than 16 bytes
- **THEN** decryption fails closed with the fixed secret-free message (the tag is pinned to the full length), never accepting the weaker short-tag verification
