# provider-management Specification

## Purpose
TBD - created by archiving change add-provider-management. Update Purpose after archive.
## Requirements
### Requirement: Tenant-scoped provider CRUD

The system SHALL expose a session-authenticated `api/providers` surface — `list`, `create`, `get`, `update`, `delete`, plus the `test-connection` and `sync-models` actions — scoped to the current principal through the shared persistence port (CLAUDE.md invariant 5). Every by-id access SHALL be ownership-scoped; another tenant's provider SHALL be indistinguishable from a nonexistent one. `create` SHALL accept `name`, `kind` (`api_key`|`subscription`|`custom`|`local`), `protocol` (`openai_compatible`|`anthropic_compatible`), a `base_url`, and an optional credential; the global `ValidationPipe` SHALL reject unknown or malformed fields.

#### Scenario: Cross-tenant access fails closed

- **WHEN** tenant A requests, updates, or deletes a provider owned by tenant B (by id)
- **THEN** the response is `404` (indistinguishable from a nonexistent id) and B's provider is unchanged
- **AND** `list` returns only the requesting principal's providers

#### Scenario: Create validates the enums and rejects unknown fields

- **WHEN** a create request has an invalid `kind`/`protocol`, or an extra unexpected field
- **THEN** it is rejected with a `422`/`400` validation error before any row is written

### Requirement: Provider credentials are encrypted at rest and never disclosed

The system SHALL encrypt a provider credential at rest with the shared `encryptSecret` util under `PROVIDER_CREDENTIAL_KEY`, storing only the envelope in `encrypted_credentials`. The plaintext SHALL exist only in-memory for the request that supplies it and SHALL be decrypted only to construct a provider adapter for `test-connection`/`sync-models`. No API response SHALL return the credential (plaintext or envelope) and no log line SHALL contain it (CLAUDE.md invariant 8); the safe provider shape SHALL expose a `hasCredential` boolean instead.

#### Scenario: The stored credential is an encrypted envelope, not plaintext

- **WHEN** a provider is created with a credential
- **THEN** the `encrypted_credentials` column holds a `poly-enc:` envelope, not the plaintext
- **AND** the create/get/list responses contain `hasCredential: true` but never the credential value

#### Scenario: A failing action never leaks the credential, even if the endpoint reflects it

- **WHEN** `test-connection` or `sync-models` fails — including a hostile endpoint that reflects the `Authorization`/`x-api-key` header in its error body (which #6's classifier may include up to 200 bytes of) **or in an `x-request-id` header** (which #6 surfaces as `ProviderError.requestId`)
- **THEN** the action result and every log line carry only a fixed public message keyed on `{ kind, status }` plus an **internally-generated `traceId`** — never the adapter's raw message, the thrown error, the adapter config, the upstream `requestId`, or the credential
- **AND** the credential is decrypted only in-memory to build the adapter

### Requirement: PROVIDER_CREDENTIAL_KEY is required outside a loopback self-host dev instance

The system SHALL register a `PROVIDER_CREDENTIAL_KEY` (32-byte hex) config and resolve it with the same gating as the auth secrets: a fixed dev-fallback key SHALL be permitted only on a loopback-bound, non-production, self-hosted instance; a network-reachable or production instance SHALL require a real key. The key value SHALL never appear in a thrown error message.

#### Scenario: Production requires a real key

- **WHEN** the instance is production or network-reachable and `PROVIDER_CREDENTIAL_KEY` is unset
- **THEN** boot/first-use fails with a clear error that does not echo any key material
- **AND** a loopback-bound non-production self-hosted instance may use the dev fallback

### Requirement: Every server-fetched base_url is SSRF-validated without an allow-list

The system SHALL validate a provider's `base_url` with the shared `assertUrlSafe` guard — using a `GuardContext` derived from the provider `kind` and the runtime `MODE` — on `create`, on `update`, and before each `test-connection`/`sync-models` action. A `base_url` that resolves to a private, loopback, link-local, or metadata address SHALL be rejected (a `422`), except the `local` + `MODE=selfhosted` loopback exception. The `base_url` SHALL be a free field validated only for SSRF safety and URL shape — there SHALL be no closed provider allow-list (spec §8). URL-**shape** validation SHALL accept a TLD-less host (e.g. `http://localhost:11434`, the canonical local-model endpoint), because address safety is enforced by the SSRF gate — not by a blunt shape check that would also reject a legitimate loopback host. `kind:'local'` under `MODE=cloud` SHALL be rejected.

#### Scenario: A private/metadata base_url is rejected

- **WHEN** a provider is created (or updated) with a `base_url` resolving to a private or metadata address, for a non-local kind or under `MODE=cloud`
- **THEN** the request is rejected with a `422` SSRF validation error and no provider row is written/changed

#### Scenario: A local loopback base_url is accepted only in self-host

- **WHEN** a `local` provider with a loopback `base_url` is created under `MODE=selfhosted`
- **THEN** it is accepted
- **AND** the same `local` kind under `MODE=cloud` is rejected

#### Scenario: The canonical TLD-less local URL passes shape validation

- **WHEN** a `local` provider is created with `base_url: http://localhost:11434` under `MODE=selfhosted`
- **THEN** URL-shape validation does not reject it for lacking a TLD, and it is accepted (loopback allowed for `local` + self-host)
- **AND** the same TLD-less private address for a non-local kind (or under `MODE=cloud`) is still rejected by the SSRF address gate (`422`)

#### Scenario: An arbitrary public custom endpoint is allowed

- **WHEN** a `custom` provider is created with an arbitrary public **HTTPS** `base_url` not on any known list
- **THEN** it is accepted (no allow-list restriction), subject only to the SSRF address check
- **AND** a remote plaintext `http://` endpoint is rejected by the guard (remote http is not permitted; loopback http is the local exception)

#### Scenario: A base_url with embedded credentials or a query/fragment is rejected

- **WHEN** a provider is created or updated with a `base_url` containing userinfo (`https://user:token@host`) or a query/fragment
- **THEN** it is rejected with a `422` (userinfo would place a credential in the plaintext `base_url` column and every response; a query/fragment breaks the adapter's path joining)
- **AND** the persisted `base_url` for an accepted provider is the normalized URL

### Requirement: test-connection validates cheaply and records health

`test-connection` SHALL construct a #6 provider adapter from the (decrypted) provider config and call its cheap `testConnection()`, mapping the typed result to the provider's `status` (`ok` on success, `error` on a typed failure) and returning a credential-free result. A credential SHALL be required for `api_key`/`subscription`/`custom` (a missing one is a clear `422` before any adapter call); only `local` may omit it (an empty auth header is ignored by local servers). It SHALL not persist prompt/response bodies.

#### Scenario: A successful test sets status ok; a failure sets error

- **WHEN** `test-connection` runs against a reachable, authenticated provider
- **THEN** the provider `status` becomes `ok` and the result indicates success
- **AND** an auth/unavailable failure sets `status` to `error` and returns a typed, credential-free failure

#### Scenario: An auth-requiring provider without a credential is a clear error

- **WHEN** `test-connection`/`sync-models` runs on an `api_key`/`subscription`/`custom` provider that has no stored credential
- **THEN** it fails with a clear `422` before any adapter/network call
- **AND** a `local` provider may run the action with no credential

### Requirement: sync-models upserts the catalog by external id without prices

`sync-models` SHALL construct the adapter, call `listModels()`, deduplicate the results by id, and upsert `Model` rows for the provider **atomically** via a principal-scoped `ModelAccessor.upsertForProvider` (`INSERT … ON CONFLICT (provider_id, external_model_id) DO UPDATE`, ownership checked in-statement) — writing **ids, display names, and `last_synced_at` only, with no prices or capability flags** (those are #8). Before upserting, `sync-models` SHALL bound ingestion so a pathological response cannot flood the `models` table: it SHALL upsert at most a fixed maximum number of models (`MAX_SYNCED_MODELS`), SHALL **skip** any entry whose external id exceeds the id-length bound (`MAX_MODEL_ID_LEN`) — a truncated id would be a *wrong* id and two distinct long ids could collide on the `(provider_id, external_model_id)` key — and SHALL **truncate** an over-long display name to the name-length bound (`MAX_MODEL_NAME_LEN`). The reported synced count SHALL reflect only rows actually upserted. Concurrent syncs or duplicate ids SHALL NOT cause a unique-constraint failure or a partial write. Models absent from the latest sync SHALL be left in place (not pruned), and the synced count SHALL be reported. Cross-tenant parenting SHALL fail closed inside the statement.

#### Scenario: Syncing creates and updates model rows without prices

- **WHEN** `sync-models` runs and the adapter returns a set of model ids
- **THEN** new `Model` rows are created and existing ones get a fresh `last_synced_at`, with `input_price_per_1m`/`output_price_per_1m` left null (for #8)
- **AND** a model previously synced but absent this time is left in place, not deleted

#### Scenario: Concurrent syncs and duplicate ids do not violate the unique constraint

- **WHEN** two syncs run concurrently, or one adapter response repeats an id
- **THEN** the atomic upsert converges without a `UNIQUE(provider_id, external_model_id)` violation or a partial write
- **AND** the same external id under a *different* provider remains a distinct row

#### Scenario: A tenant cannot sync models under another tenant's provider

- **WHEN** a sync is attempted for a provider id the principal does not own
- **THEN** it fails closed (`404`) and writes no model rows

#### Scenario: An oversized model list is count- and field-capped, not a partial flood

- **WHEN** `sync-models` receives a response with far more models than the cap (e.g. 10,000), including an entry with an over-long external id
- **THEN** at most `MAX_SYNCED_MODELS` rows are upserted, the over-long-id entry is skipped, over-long display names are truncated, and the reported synced count matches the rows actually written

### Requirement: Update validates the effective merged config and preserves the credential

An `update` SHALL validate the *resulting* provider, not the patch alone: the service SHALL fetch the owned row, compute `nextKind`/`nextBaseUrl` from the patch merged over the stored values, and SSRF-gate that tuple before persisting, so a partial patch cannot produce an invalid unusable row. The credential SHALL be re-encrypted only when the `credential` field is present in the patch; an omitted credential SHALL preserve the existing envelope, and an explicit empty credential SHALL clear it. When the update moves the provider's kind **from** `custom`/`local` **to** `api_key`/`subscription`, the service SHALL clear that provider's models' user-set unit prices (`input_price_per_1m`, `output_price_per_1m`, `is_free`), owner-scoped, so `GET /api/models` does not display a price the resolver will not use. This clear is for display consistency only: correctness is guaranteed centrally by the pricing resolver, which honors a model-own price ONLY for a `custom`/`local` provider (see pricing-catalog), so a stale or concurrently-restored model price on an `api_key`/`subscription` provider can never override the catalog cost regardless of the clear's timing. Historical `request_log` snapshots are unaffected (invariant 4).

#### Scenario: A kind change without a new base_url is validated against the merged tuple

- **WHEN** a `local` provider with a loopback `base_url` is updated to `kind: "custom"` without supplying a new `base_url`
- **THEN** validation runs against `(custom, <stored loopback base_url>)` and rejects it (loopback is not allowed for `custom`)
- **AND** updating only a `local` provider's `base_url` validates against the still-`local` kind

#### Scenario: An omitted credential is preserved; an empty one clears it

- **WHEN** an update omits the `credential` field
- **THEN** the stored `encrypted_credentials` envelope is unchanged (`hasCredential` unchanged)
- **AND** an update with an explicit empty credential clears it (`hasCredential:false`)

#### Scenario: A kind change away from custom/local clears stale model prices

- **WHEN** a `custom` provider with user-priced models is updated to `kind: "api_key"`
- **THEN** those models' `input_price_per_1m`/`output_price_per_1m`/`is_free` are cleared in the same operation, so a subsequent request prices from the catalog (`source` ≠ `model`) and `GET /api/models` shows the prices cleared
- **AND** a change that stays within `custom`/`local` leaves user prices untouched

### Requirement: Deleting a provider cascades to its models and routing entries

Deleting a provider SHALL remove its `Model` rows and any `routing_entries` that referenced those models (the schema's `ON DELETE CASCADE`), because a deleted provider's models are no longer routable. This destructive cascade SHALL be explicit and covered by a test rather than an accidental side effect. Deleting a provider or model SHALL, in the same transaction, **re-compact** every affected tier's surviving `routing_entries` to contiguous positions starting at 0, so the config-layer invariant (position 0 is the primary, positions are gapless) survives the cascade — a tier that still has healthy models after its position-0 model's provider is deleted MUST remain routable (its next surviving model becomes the primary), not report `empty_tier`. A tier left with no surviving models is genuinely empty (and reports `empty_tier` at proxy time, per routing-config).

#### Scenario: Delete removes the provider's models and their routing entries

- **WHEN** a provider with synced models (some assigned to a tier) is deleted by its owner
- **THEN** the provider, its `Model` rows, and the `routing_entries` referencing those models are all removed
- **AND** a cross-tenant delete of another tenant's provider fails closed (`404`) and removes nothing

#### Scenario: Deleting a tier's position-0 provider leaves the tier routable

- **WHEN** a tier has a cross-provider chain (model A at position 0, model B at position 1) and the provider owning model A is deleted
- **THEN** the cascade removes A's entry and re-compacts the tier so model B is at position 0, and a subsequent request routed to that tier serves from B (not `empty_tier`)
- **AND** deleting the provider of the tier's only model leaves the tier genuinely empty

### Requirement: Models list/filter API

The system SHALL expose a session-authenticated `api/models` surface listing the current principal's models (owned through their providers), filterable by provider, `is_free`, and capability flags, for the dashboard and routing UI. It SHALL not expose provider credentials.

#### Scenario: Models are listed and filterable, scoped to the tenant

- **WHEN** the principal lists models, optionally filtering by `providerId` or `isFree`
- **THEN** only the principal's models (via owned providers) are returned, matching the filter
- **AND** no provider credential appears in the response

### Requirement: Buffered provider responses are byte-bounded

Every **non-streaming** (buffered) read of a provider response body — `chat` (non-stream), `listModels`,
`test-connection`, and any error-body drain — SHALL be bounded by a fixed maximum byte count
(`DEFAULT_MAX_RESPONSE_BYTES`, 10 MiB, matching the `/v1` ingress bound). When a response body exceeds the
cap, the drain SHALL cancel the underlying reader (closing the guarded dispatcher — no leaked connection)
and reject with a typed `ProviderError('bad_request')` **before** accumulating past the cap, so peak
memory stays bounded regardless of what a hostile-but-address-safe endpoint returns. `bad_request` is
deliberate: it neither trips the provider breaker (a one-off flood must not disable an otherwise-healthy
provider) nor triggers a fallback (which would re-drain a second giant body). Streaming SSE reads are
consumed incrementally and are NOT subject to this buffered cap. The error message SHALL carry only the
byte cap — never response content or any credential.

#### Scenario: A buffered response over the cap is rejected with bounded memory

- **WHEN** a provider endpoint returns a non-streaming body larger than the cap during `chat`, `listModels`, or `test-connection`
- **THEN** the drain cancels the reader and rejects with a typed `ProviderError('bad_request')`, peak memory stays bounded near the cap, and no partial result is returned
- **AND** the provider breaker is not tripped and no fallback is attempted for that response

#### Scenario: A normal-sized and a streaming response are unaffected

- **WHEN** a provider returns a normal-sized buffered body, or a long streaming SSE body consumed incrementally
- **THEN** the buffered body drains normally under the cap, and the streaming body is not subject to the buffered cap (it is bounded incrementally by the stream reader)

