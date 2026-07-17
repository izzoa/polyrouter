## Why

A provider `base_url` only has to pass the SSRF **address** check — a hostile-but-public endpoint is
allowed by design (no allow-list, spec §8), so the server willingly drains whatever that endpoint
sends back. Two unbounded paths turn that into a self-inflicted DoS, and one over-strict URL check
blocks the canonical local-model setup (FABLE_AUDIT E11 + backlog A-42):

- **Unbounded buffered drain.** `drainText` (data-plane `providers/http.ts`) accumulates a
  non-streaming response body into a string with no byte cap. A custom/local provider pointed at an
  endpoint that returns a multi-GB or endless body exhausts control-plane memory on `sync-models`,
  `test-connection`, or a non-streaming `chat` — taking down the single-container instance for **all**
  tenants. (Streaming reads are already incremental and bounded; this is only the buffered path.)
- **Unbounded model ingestion.** `parseModelList` accepts an arbitrarily long array with
  arbitrarily long ids/names, and `syncModels` upserts every entry into unbounded text columns. A
  response with millions of entries floods the `models` table (a partial DB write, one row at a time).
- **A-42: the canonical Ollama URL is rejected.** The provider DTO's `@IsUrl` defaults
  `require_tld: true`, so `http://localhost:11434` — the documented local-model base URL — fails
  shape validation before the SSRF gate (which is the real guard) ever runs.

## What Changes

- **E11.1a — Byte-bound the buffered drain.** `drainText` takes a max-bytes cap (default 10 MiB,
  matching the `/v1` ingress bound) and, on overflow, cancels the reader and throws a typed
  `ProviderError('bad_request')` — so `chat`/`listModels`/`testConnection` reject with a typed error
  and peak memory stays bounded. `bad_request` is deliberate: an over-sized **response** is the peer's
  fault, and this kind neither trips the breaker (a one-off flood shouldn't disable a healthy provider)
  nor falls back (which would just re-drain a second giant body). Streaming SSE is untouched.
- **E11.1b — Bound model ingestion.** `parseModelList` stops after a generous parse cap; `syncModels`
  caps the deduped set to a max count, **skips** entries whose external id exceeds the length bound
  (a truncated id is a *wrong* id that could collide on upsert), and **truncates** an over-long display
  name — all before the upsert loop, so a pathological list can't flood the table.
- **A-42 — Accept a TLD-less host.** Set `require_tld: false` on the provider `base_url` `@IsUrl`
  options so `http://localhost:11434` passes URL-shape validation. Address safety is unchanged: the
  service's SSRF gate still resolves and blocks private/loopback/metadata ranges (loopback allowed only
  for `local` + `MODE=selfhosted`).

## Capabilities

### Modified Capabilities

- `provider-management`: every buffered provider response drain is byte-bounded (typed rejection on
  overflow, memory stays bounded); `sync-models` caps the model count and per-field lengths before
  upserting; `base_url` shape validation accepts a TLD-less host so the canonical local-model URL is
  addable (address safety still SSRF-gated).

## Impact

- **Code:** `packages/data-plane/src/providers/http.ts` (`drainText` byte cap),
  `packages/data-plane/src/providers/adapter.ts` (`DEFAULT_MAX_RESPONSE_BYTES`, `MAX_PARSED_MODELS`),
  `packages/data-plane/src/providers/http-adapter.ts` (`parseModelList` parse cap),
  `packages/control-plane/src/providers/providers.service.ts` (`syncModels` count/field caps),
  `packages/control-plane/src/providers/providers.dto.ts` (`require_tld: false`).
- **Tests:** data-plane unit — a buffered body over the cap rejects `bad_request` and a streaming body
  is unaffected; `parseModelList` truncates a giant array. control-plane service — a 10k-model / oversized-id
  sync caps the count and skips the oversized id without a partial flood; DTO e2e — `http://localhost:11434`
  is accepted (create) and still SSRF-gated at the address layer. **No migration** (no schema change).
  Changeset: user-facing (local providers now addable; sync/test are memory-safe).
- Backlog A-42 resolved here. A configurable per-provider byte knob is deferred (the fixed safety rail suffices).
