# Proposal: add-provider-adapters

> Implements **TODOS.md #6 `add-provider-adapters`** — spec **§8** (provider abstraction: four kinds behind one adapter interface), **§3.2** (Redis-shared circuit breaker), **§7.4** (fallback triggers). CLAUDE.md invariants **2** (quirks live in adapters; adapters never define their own response shapes — they consume #5's `Normalized*` IR), **6** (every user-supplied server-fetched URL is SSRF-validated at connect time), **8** (credentials never logged), **10** (breaker state is atomic/shared across instances).

## Why

The proxy (#10) must call whatever provider a route resolves to, over whichever wire protocol that provider speaks, and skip a provider that is down or rate-limited without stalling the request. That "call a provider" seam is the provider adapter: it takes a protocol-agnostic `NormalizedRequest` (from #5), serializes it to the provider's protocol, POSTs it through the SSRF-guarded fetch (#4), and parses the reply back into the IR — plus a Redis-shared circuit breaker so all instances route around a failing provider fast (§3.2, invariant 10). Landing this now — before the proxy exists — means #10 composes routing + fallbacks over a clean, tested provider-call layer instead of embedding HTTP, protocol, and reliability concerns in the request handler.

## What Changes

- **A provider adapter interface** (`data-plane/src/providers/`) — `chat(request) → NormalizedResponse`, `chatStream(request) → AsyncIterable<NormalizedStreamEvent>`, `listModels() → ProviderModelInfo[]`, `testConnection() → ConnectionResult`. It **consumes #5's `Normalized*` IR and never defines its own response shape** (invariant 2); the OpenAI/Anthropic wire translation is delegated to #5's translate module, so provider quirks stay per-adapter.
- **OpenAI-compatible and Anthropic-compatible adapters** covering the four provider **kinds** (`api_key`, `subscription`, `custom`, `local`). Auth is per-protocol (`Authorization: Bearer` vs `x-api-key` + `anthropic-version`), with an `extraHeaders` seam for subscription/custom; credentials are passed in decrypted and **never logged**. `local` is gated on `MODE=selfhosted` — the factory rejects it under `MODE=cloud`. Free-marking of local/curated models is #8's catalog concern, not this layer's output.
- **All outbound provider HTTP is SSRF-guarded at connect time** using #4's exported `assertUrlSafe` + `createGuardedDispatcher` primitives (not the auto-closing `guardedFetch`, which awaits `dispatcher.close()` before an SSE body can drain — it would deadlock streaming). The dispatcher lifecycle is tied to the response body (closed on end/error/cancel); redirects are rejected; the loopback exception is enabled **only** for `kind:'local'` under `MODE=selfhosted`. #4's module is unmodified.
- **A Redis-shared, generation-versioned circuit breaker** with `closed → open → half-open → closed` states, shared across instances so a down/rate-limited provider is skipped fast (§3.2, invariant 10), degrading to a per-instance in-memory breaker if Redis is unavailable (never fully open, mirroring the auth rate limiter). Admission returns a token; completion is generation-conditional and store-affine so a stale completion can't impersonate the single half-open probe. `withBreaker`/`withBreakerStream` map the §7.4 triggers; a Lua transition (Redis server clock) keeps it atomic across instances.
- **A typed provider-error taxonomy** (`auth`, `rate_limit`, `unavailable`, `bad_request`, `unknown_model`) mapped from HTTP status/network faults, with **two** classifiers: `shouldFallback` (drives #10's chain) and `breakerImpact` (drives the provider breaker) — so a retired model (`unknown_model`) falls back without disabling a healthy provider.

## Capabilities

### New Capabilities

- `provider-adapters`: the adapter interface + OpenAI/Anthropic adapters (chat, stream, listModels, testConnection), the SSRF-guarded outbound HTTP seam, the provider-error taxonomy, and the Redis-shared circuit breaker with in-memory fallback.

## Impact

- **Code:** `packages/data-plane/src/providers/**` (adapter interface, `openai-adapter.ts`, `anthropic-adapter.ts`, `factory.ts`, `errors.ts`, `http.ts`, `breaker.ts`) + tests. Adds `@polyrouter/shared/server` (for the SSRF primitives `assertUrlSafe`/`createGuardedDispatcher`) as a data-plane import, `undici` as a data-plane dependency (the seam calls undici's own version-matched `fetch`), and `ioredis` as a dev-only type for the breaker's Redis seam. No schema, no endpoints (those are #7/#10). #4's SSRF module is not modified.
- **Downstream:** #7 (provider management) decrypts credentials and calls `testConnection()`/`listModels()` for catalog sync; #10 (proxy) resolves a route to a provider, calls the adapter through `withBreaker`, and walks the fallback chain on a trip. #8's pricing attaches to the `ProviderModelInfo` ids this returns.

## Non-goals

- **No provider CRUD / persistence / credential encryption at rest** — that is #7; this change accepts an already-decrypted credential and a provider config, and returns data, storing nothing.
- **No pricing / catalog rows** — `listModels()` returns raw `{ id, displayName? }`; mapping to `Model`/`ModelPrice` rows and prices is #7/#8.
- **No proxy endpoints, routing, or the mid-stream commit policy** — #10/#12 compose these adapters and the breaker; this change provides the call primitive and states the boundary.
- **No SSRF range logic** — reuses #4's guard verbatim; this change only wires every outbound call through it with the correct per-kind context.
