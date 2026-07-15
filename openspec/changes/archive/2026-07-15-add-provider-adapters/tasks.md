# Tasks: add-provider-adapters

> Build order: error taxonomy → guarded HTTP seam (stream-safe dispatcher lifecycle) → adapters (fake-client + local-server contract tests) → SSRF/credential tests → circuit breaker (pure transition → InMemory+tokens → Lua on real Redis) → factory. Tests land with the code they cover.

## 1. Module scaffold & shared types

- [x] 1.1 Create `packages/data-plane/src/providers/` + `providers/index.ts`; add `undici` to data-plane `dependencies` (the seam calls undici's own version-matched `fetch`) and `ioredis` to `devDependencies` (breaker Redis type); confirm `@polyrouter/shared/server` (SSRF primitives) and `@polyrouter/data-plane` translate resolve from here.
- [x] 1.2 Define `providers/adapter.ts`: `ProviderAdapter` (`chat(request, ctx?)`, `chatStream(request, ctx?)`, `listModels`, `testConnection`), `ProviderConfig` (`protocol`, `baseUrl`, `credential`, `kind`, `mode`, `defaultMaxOutputTokens?`, `firstByteTimeoutMs?`, `idleTimeoutMs?`, `quirks?`, `extraHeaders?`), `CallContext { signal?, traceId? }`, `ProviderKind`, `ProviderModelInfo { id, displayName? }`, `ConnectionResult`. The IR comes from `@polyrouter/data-plane`; no provider response shape is defined here.

## 2. Provider-error taxonomy (+ tests)

- [x] 2.1 Implement `providers/errors.ts`: `ProviderError` base + `kind` (`auth|rate_limit|unavailable|bad_request|unknown_model`), `ProviderCircuitOpenError`; `classifyResponse(status, bodyText)` (refine 404 → `unknown_model` only on a model-not-found body, else `unavailable`), `classifyNetworkError(err)` (408/reset/timeout → `unavailable`), and `classifyStreamError(rawType)` (map a normalized `error` event's type → `kind`); `shouldFallback(kind)` and `breakerImpact(kind)` (unknown_model & bad_request DON'T trip). Carry a sanitized upstream request id in metadata, never the credential.
- [x] 2.2 Add `errors.spec.ts`: 429→rate_limit; 400/422→bad_request; 5xx/408/network/timeout→unavailable; 401/403→auth; model-not-found 404→unknown_model, path-404→unavailable; assert `shouldFallback` and `breakerImpact` truth tables (esp. unknown_model falls back but no breaker trip; bad_request neither).

## 3. Stream-safe guarded HTTP seam (+ SSRF & decoder tests)

- [x] 3.1 Implement `providers/http.ts`: `type HttpClient`; `createGuardedHttpClient({ mode, providerKind, resolve? })` using #4's `assertUrlSafe` + `createGuardedDispatcher` + undici's own `fetch` (NOT `guardedFetch`, which closes its dispatcher before an SSE body drains); reject any 3xx as a typed error; **exactly-once dispatcher ownership** — every pre-return failure path (rejected 3xx with its body cancelled, `assertUrlSafe`/connect rejection, fetch throw) closes/destroys the dispatcher, and once a body is returned the wrapper closes it on end/error/cancel (immediately if bodyless). Add `readSseChunks(response)` using ONE persistent `TextDecoder({stream:true})` + final flush; `joinUrl(base, path)` trimming one trailing slash; a first-byte timeout that is **disarmed after the first byte/event** (never an overall stream deadline) + caller-signal composition.
- [x] 3.2 Add `ssrf.spec.ts`: a resolver returning **public at validation time and private at connect time** is refused (proving connect-time/rebinding wiring, not just name-time); `local`+`selfhosted` permits loopback while `cloud`/non-local refuses; a rejected 3xx and a fetch rejection both close the dispatcher (no connection leak). Add `decoder.spec.ts`: a multibyte char split across chunk boundaries decodes byte-correct; a real SSE stream (local `http` server) delivers the first event before the upstream ends, cancellation closes the connection, and "headers arrive then no event within firstByteTimeout" aborts while a slow-but-progressing long stream is not aborted.

## 4. OpenAI-compatible adapter (+ tests)

- [x] 4.1 Implement `providers/openai-adapter.ts` on #5's `openaiAdapter`: `chat` (`POST {base}/chat/completions`, JSON body + `Content-Type`, `Authorization: Bearer`, JSON-decode → `responseIn`), `listModels` (`GET {base}/models` → `{id,displayName}[]`), `testConnection` (cheap listModels, typed failures), first-byte timeout + `CallContext`.
- [x] 4.2 Implement OpenAI `chatStream`: `stream:true` + `Accept: text/event-stream`, `readSseChunks` → #5 `streamParse`; pre-first-event non-2xx → typed error.
- [x] 4.3 Add `openai-adapter.spec.ts` (injected fake `HttpClient` + a local-server contract case): request is JSON to the right path with bearer header; response parses to the IR; streamed text concatenates; 401 → `auth`.

## 5. Anthropic-compatible adapter (+ tests)

- [x] 5.1 Implement `providers/anthropic-adapter.ts` on `createAnthropicAdapter(quirks, { defaultMaxOutputTokens })`: `chat` (`POST {base}/v1/messages`, `x-api-key` + `anthropic-version`), `listModels` (`GET {base}/v1/models`), `testConnection`, timeout.
- [x] 5.2 Implement Anthropic `chatStream` (event-stream body → `streamParse`).
- [x] 5.3 Add `anthropic-adapter.spec.ts`: `x-api-key`+`anthropic-version` headers, `/v1/messages` path, missing `maxOutputTokens` uses the configured default, response parses to the IR, streamed events concatenate, 429 → `rate_limit`, `extraHeaders` merged.

## 6. Credential safety (+ test)

- [x] 6.1 Ensure the credential appears only in the auth header built at call time. Add `no-secret-leak.spec.ts`: a failing chat and a failing `testConnection` (injected `HttpClient`/logger) never surface the credential in the error, its metadata, or a captured log.

## 7. Circuit breaker (+ tests)

- [x] 7.1 Implement `providers/breaker.ts` pure `transition(state, event, now, cfg) → { next, decision }` with `generation` + `probeHeld` + `probeLeaseMs`, where **admitting a probe (including reclaiming an expired lease) increments `generation`**. Add `breaker-transition.spec.ts`: closed→open (threshold), open→half_open (cooldown, single probe), half_open→closed (probe success), half_open→open (probe failure), probe-lease expiry, a stale-generation completion is ignored, and the lease-reclaim race (probe A expires → B admitted → A completes → no effect).
- [x] 7.2 Implement `BreakerStore` + `InMemoryBreakerStore` (Map, injected `now`) and `CircuitBreaker`: `before(providerId) → Admission { decision, token{store,generation,isProbe} }`, `complete(token, outcome: success|trip|neutral)` (generation-conditional, store-affine), per-instance in-memory fallback + `onError`; `withBreaker(breaker, providerId, fn)` and `withBreakerStream(breaker, providerId, genFn)` mapping resolved/non-tripping→success, tripping→trip, caller-abort→neutral, **a clean EOF without a terminal stop reason→trip (`unavailable`, truncation), and an observed normalized `error` event→`classifyStreamError`→`breakerImpact`**. Add `breaker.spec.ts`: two `CircuitBreaker`s sharing ONE `InMemoryBreakerStore` (simulated single Redis) show cross-instance open/half-open/close; store-error degrades to per-instance and never fails open; `withBreaker` trips only on tripping errors; a bad_request probe closes; a stale completion is ignored; a truncated OpenAI stream and a truncated Anthropic stream both trip; a streamed model/`invalid_request` error does not trip while an overloaded stream error does.
- [x] 7.3 Implement `RedisBreakerStore` (`BreakerRedis.eval`) executing the same transition in one atomic Lua script using Redis `TIME`, keyed `cb:{providerId}` with a TTL. Add `breaker-redis.spec.ts` (gated on `REDIS_URL`, clear skip message locally): a parity vector suite replays event sequences through both the TS `transition` and the Lua and asserts identical decisions; a concurrent `Promise.all` of `before()` admits exactly one half-open probe. Run it against the repo's docker-compose Redis during implementation, and add a CI job that provisions Redis and sets `REDIS_URL` so this suite is **mandatory in CI** (not silently skipped).

## 8. Factory & wiring

- [x] 8.1 Implement `providers/factory.ts` `createProviderAdapter(config, deps?)`: select by `protocol`, reject `kind:'local' && mode!=='selfhosted'`, default `deps.httpClient` to `createGuardedHttpClient(config)`, pass `quirks`/`defaultMaxOutputTokens`/`extraHeaders`. Export the public surface from `providers/index.ts`; re-export from `packages/data-plane/src/index.ts`.
- [x] 8.2 Add `factory.spec.ts`: protocol selection both ways; `local`+`cloud` rejected; the default httpClient is guarded (a private-resolving `resolve` refusal).

## 9. Definition of done

- [x] 9.1 `npm test -w packages/data-plane` green (errors, ssrf, decoder, adapters, no-secret-leak, breaker transition/in-memory, factory; the Redis-gated parity/concurrency test run against docker-compose Redis during implementation); `npm run build` passes; lint clean; strict TS, no `any` escapes.
- [x] 9.2 Add a changeset (`@polyrouter/data-plane` minor) describing the provider adapters + stream-safe guarded transport + circuit breaker.
- [x] 9.3 Confirm non-goals hold (no CRUD/persistence/encryption, no pricing/`is_free`, no proxy/routing; #4 unmodified); update spec/deltas as needed and leave the change archive-ready.
