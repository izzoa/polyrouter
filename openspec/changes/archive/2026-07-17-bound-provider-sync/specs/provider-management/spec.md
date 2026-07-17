## ADDED Requirements

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

## MODIFIED Requirements

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
