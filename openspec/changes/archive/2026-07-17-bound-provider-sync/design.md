## Context

The SSRF guard validates the *address* a provider `base_url` resolves to, but by design there is no
allow-list — a custom/local provider may point at any public endpoint (spec §8). The server then trusts
that endpoint's *response*. Three concrete gaps (E11 + A-42) let a hostile or misconfigured endpoint
harm the instance, or block a legitimate one.

## Goals / Non-Goals

- **Goals:** bound peak memory on every buffered (non-streaming) provider drain; bound the number and
  field-length of models a single sync writes; let the canonical local-model URL (`http://localhost:11434`)
  pass shape validation without weakening the SSRF address gate.
- **Non-Goals:** capping streaming SSE bodies (already incremental/bounded); a per-provider configurable
  byte knob (fixed safety rail is enough); changing the SSRF address policy; pruning stale models.

## Decisions

### D1 — The byte cap lives in `drainText`, the single buffered-drain choke point

Every non-streaming read funnels through `drainText`: both `bindDispatcherToBody.{text,json}` and the
E4.3 idle-guarded `guardBufferedBodyIdle.{text,json}` call it, and the adapter's `chat` (non-stream),
`listModels`, and error-body reads all resolve through the idle-guarded wrapper. Streaming uses
`readSseChunks` (a separate incremental reader), so capping `drainText` precisely targets buffered
reads and leaves SSE alone. `drainText(stream, maxBytes = DEFAULT_MAX_RESPONSE_BYTES)` takes the cap as
a defaulted parameter; the adapter threads an optional `ProviderConfig.maxResponseBytes` (default
`DEFAULT_MAX_RESPONSE_BYTES`) through `openRequest` → `guardBufferedBodyIdle` so the effective bound is
overridable (mainly so a test can drive overflow with a tiny cap instead of a real 10 MiB body). The
inner `bindDispatcherToBody` drain keeps the constant default as a backstop.

Implementation: accumulate `bytes += value.length` (a `Uint8Array`'s length is its byte count) and, the
moment it would exceed the cap, **cancel the reader** (closing the guarded dispatcher — no leaked
connection) and throw *before* decoding/appending the overflowing chunk. Peak `out` memory ≈ `maxBytes`
+ one ~64 KiB transport chunk. Default `DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024` mirrors the `/v1`
ingress `PROXY_MAX_BODY_BYTES` default; a normal model list or completion JSON is orders of magnitude
smaller.

### D2 — Overflow is `ProviderError('bad_request')`, not `unavailable`

An over-sized *response* is the peer's fault, not a transient outage. `bad_request` has exactly the two
properties we want for a response-size DoS: `shouldFallback('bad_request') === false` (don't amplify by
re-draining a giant body from the fallback) and `breakerImpact('bad_request') === false` (a one-off
flood must not disable an otherwise-healthy provider). For `sync-models`/`test-connection` it surfaces as
a typed, credential-free `ActionResult` error; for `chat` it surfaces to the caller in their protocol
envelope. The message carries only the byte cap — never any body content or credential (invariant 8).

### D3 — Model caps: skip oversized ids, truncate display names, cap the count

Two independent bounds, layered:

- **`parseModelList` (data-plane, parse-time):** stop after `MAX_PARSED_MODELS` (5,000) entries so a
  <10 MiB body packed with tiny entries can't build an unbounded in-memory array. (The D1 byte cap
  already bounds total body size; this bounds entry *count* within it.)
- **`syncModels` (control-plane, write-time):** after dedupe, take at most `MAX_SYNCED_MODELS` (2,000);
  **skip** any entry whose `externalModelId` exceeds `MAX_MODEL_ID_LEN` (512) — truncating an id would
  fabricate a wrong id and two distinct long ids could collide on the same `(provider_id, external_model_id)`
  key, overwriting each other — and **truncate** `displayName` to `MAX_MODEL_NAME_LEN` (512) since a
  display name is cosmetic. The reported `synced` count reflects only rows actually upserted.

Write-time caps are the DoS-relevant ones (they bound DB rows); the parse cap is defense-in-depth.

### D4 — A-42: relax `require_tld`, not the SSRF gate

`validator.js`'s `isURL` defaults `require_tld: true`, which rejects single-label hosts like `localhost`.
Setting `require_tld: false` on the provider `base_url` `@IsUrl` options accepts `http://localhost:11434`
at the DTO **shape** layer only. This adds no exposure: the service's `assertUrlSafe` gate still resolves
the host and blocks private/loopback/link-local/metadata ranges, and loopback is admitted **only** for a
`local` provider under `MODE=selfhosted`. A non-self-host deployment still rejects `localhost` — at the
address gate, where the decision belongs — not at a blunt shape check that also blocks legitimate use.

## Risks / Trade-offs

- **A buffered `chat` response over 10 MiB now errors** instead of being returned. That is ~2.5M tokens
  of JSON in a single non-streaming completion — pathological; the memory-safety bound is worth it, and
  agents wanting large outputs stream (uncapped, incremental).
- **`bad_request` on overflow means no fallback.** Intended (D2) — falling back would re-drain another
  potentially-giant body. A genuinely flaky provider surfaces through the normal `unavailable` paths.

## Migration Plan

None — no schema change. New constants + validator option + guard logic only; effective immediately on
deploy, including for existing providers.

## Open Questions

- Should the byte cap be a documented env knob (`PROVIDER_MAX_RESPONSE_BYTES`)? Deferred: the internal
  `ProviderConfig.maxResponseBytes` seam exists (used by tests), but `buildAdapterConfig` does not read
  an env var — a fixed 10 MiB rail matches the ingress bound and needs no per-deploy tuning yet.
