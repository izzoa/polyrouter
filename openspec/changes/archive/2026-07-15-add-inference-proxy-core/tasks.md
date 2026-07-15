# Tasks: add-inference-proxy-core

> Build order: pure resolver (data-plane) → ProxyCore + stream coordinator (data-plane) → guard x-api-key → proxy config/module → error mapping + exception filter → ProxyService (buffered) → streaming pump + backpressure + drain → controllers + /v1/models → tests. No schema migration. Reuses #5 translate, #6 adapters, #9 accessors, #3 guard, #7 decryption. #5's adapters stay unmodified (the terminal-error emitter is #10-local); #3's guard gains an additive `x-api-key` path.

## 1. Routing resolver (data-plane, pure)

- [x] 1.1 Add `data-plane/src/routing/resolve.ts`: `RouteDecision`/`RouteError` + `resolveRoute(snapshot, parsed) → RouteDecision | { error }`, pure (no DB/Nest/clock) over `{ tiers, entriesByTierId, rules, models, providers }` + `{ modelField, headers }`. **Sort a copy of `rules`** (priority desc, created_at, id) and select a tier primary by `position === 0`. Phases: (1) `model` field — an *explicit* selection terminates: `"<providerId>:<ext>"`→that model, unambiguous bare ext id→that model, tier key→that tier (a bare value that is both a model id and a tier key → the **model**); `auto` **or empty** makes no selection and **continues to phase 2**; any other non-empty value → `unknown_model` (no silent default). (2) matching custom `header` rule → `tier:`primary / `model:`direct (via `parseRoutingTarget`); (3) built-in `x-polyrouter-tier`→owned tier (before default rules); (4) `default` rule→target; (5) seeded `default` tier. Typed errors `unknown_model`/`ambiguous_model`/`empty_tier`/`unresolved_target`/`no_default`; emit `decisionLayer`(`explicit`|`header`|`default`)+`routingReason`. Export via `data-plane/src/routing/index.ts` + package index.
- [x] 1.2 Add `data-plane/src/routing/resolve.spec.ts`: every phase, `position===0` selection with **shuffled** entries, rule ordering with **shuffled** rules, **`auto`+header forces the header tier**, **`auto` alone → default**, **a typo model → `unknown_model` (not default)**, built-in-header-beats-default-rule, model-target rule, model/tier-name collision → model, and each typed error (empty tier, unresolved target, unknown model, ambiguous bare id, missing default). Pure.

## 2. ProxyCore + stream coordinator (data-plane)

- [x] 2.1 Add `data-plane/src/proxy/core.ts`: `runBuffered(providerAdapter, clientAdapter, nreq) → clientWire` (IR `chat` → `responseOut`) and `openStream(providerAdapter, clientAdapter, nreq, signal, firstEventTimeoutMs) → Promise<{kind:'error';error} | {kind:'stream';frames}>` — call `chatStream`, race the first `iterator.next()` against an abortable `firstEventTimeoutMs` (since #6 clears its first-byte timer at headers and implements no idle timeout, a 200 with no SSE must not hang here), and gate on the first *successful* event (a thrown error, a timeout, OR an `error` event yielded first → `{kind:'error'}` pre-commit; else `{kind:'stream'}` re-emitting the buffered first event then continuing). **Every pre-commit exit MUST `abort()` + `await iterator.return()`** (the paused generator's `finally`/dispatcher-release won't run otherwise). A later thrown/`error`-yielded failure is **sanitized** and written as a protocol-correct terminal frame — not routed through #5's `streamSerialize`.
- [x] 2.2 Add `data-plane/src/proxy/stream-error.ts`: `terminalErrorFrame(protocol, fixedMessage) → string` (OpenAI `data: {"error":…}` + `[DONE]`; Anthropic `event: error` frame). Export ProxyCore + types via the package index. Unit-test the coordinator with a fake adapter: first-event-error, mid-stream error, clean completion.

## 3. Guard: accept `x-api-key` (Anthropic drop-in)

- [x] 3.1 Extend `control-plane/src/auth/agent-key.guard.ts`: extract the key from `Authorization: Bearer` **or** `x-api-key`; two conflicting credential headers → 401. Keep HMAC + prefix + coalesced `last_used_at`. Unit-test both header shapes + the conflict case.

## 4. Proxy config & module

- [x] 4.1 Add `control-plane/src/proxy/proxy.config.ts` (or reuse `loadProvidersConfig`+`resolveCredentialKey`): `PROXY_RUNTIME` `{ key, mode, defaultMaxOutputTokens, firstByteTimeoutMs, idleTimeoutMs, streamDrainDeadlineMs }` via `useFactory`; provide `createProviderAdapter` as an overridable token for tests.
- [x] 4.2 Add `control-plane/src/proxy/proxy.module.ts` (**`imports: [DatabaseModule, AuthModule]`** — AuthModule exports the guard; controllers + `ProxyService` + `ProxyExceptionFilter` + drain registry + tokens) and register `ProxyModule` in `app.module.ts`.

## 5. Error mapping + `/v1` exception filter

- [x] 5.1 Add `control-plane/src/proxy/proxy-errors.ts`: internal reason → `{ status, protocolBody }` in the caller's envelope. Exhaustive: resolver `unknown_model`/`ambiguous_model`→404, `empty_tier`/`unresolved_target`→400, `no_default`→500; #6 `ProviderError` auth→502, rate_limit→429, unavailable→503, bad_request→400, unknown_model→404. Fixed messages only.
- [x] 5.2 Add `control-plane/src/proxy/proxy-exception.filter.ts` (registered globally, protocol-shaping only `/v1` paths): render every thrown failure — incl. the guard's `UnauthorizedException` (401) — in the client protocol envelope (protocol by route: `/v1/messages`→anthropic, else openai). Add a `/v1`-scoped Express body-parse error handler for **malformed JSON** (which fails in `express.json()` before the Nest filter) → protocol-shaped 400. Unit-test both protocols + the 401 + malformed-JSON paths.

## 6. ProxyService — resolve, build, call, pump

- [x] 6.1 Add `control-plane/src/proxy/proxy.service.ts` (injects `PERSISTENCE_PORT`, `PROXY_RUNTIME`, adapter factory, drain registry). `handle(...)`: client `requestIn`→IR (400 on malformed); load the owned config snapshot; `resolveRoute`→route or typed error; load the provider row, **re-gate `base_url`** (SSRF), decrypt credential (#7), build the #6 adapter with the timeouts; retarget IR `model`→resolved external id.
- [x] 6.2 Non-streaming → `ProxyCore.runBuffered` → wire JSON. Streaming → `ProxyCore.openStream`; on `{kind:'error'}` throw the mapped error (pre-commit); on `{kind:'stream'}` write 200 + SSE headers, then pump `frames` with `res.write`/drain **raced against `res` `close`/`error`** (never hang), wire `res.on('close')`+`req.aborted`→`AbortController` (cancel upstream on disconnect), and in `finally` abort + `frames.return()`. Register/deregister the stream in the drain registry.

## 7. Controllers, `/v1/models` & graceful drain

- [x] 7.1 Add `chat-completions.controller.ts` (`POST /v1/chat/completions`, protocol `openai`) and `messages.controller.ts` (`POST /v1/messages`, `anthropic`), both `@UseGuards(AgentApiKeyGuard)` + `@CurrentPrincipal`; branch streaming vs buffered on the body's `stream`. Add `models.controller.ts` (`GET /v1/models`): OpenAI-list-shaped — tier keys + `auto` + every model's `providerId:ext` id + each **unambiguous** bare external id (so no listed id resolves to `ambiguous_model`); tenant-scoped.
- [x] 7.2 Graceful drain (invariant 12): a drain registry whose `beforeApplicationShutdown` (NOT `onApplicationShutdown` — it runs after HTTP disposal) marks draining (new inference → protocol 503), awaits active streams to a bounded deadline, then **aborts** any stragglers so `server.close()` can't hang. `enableShutdownHooks` already runs in `main.ts`.

## 8. Tests

- [x] 8.1 Add a local **stub upstream** helper (HTTP server speaking OpenAI + Anthropic wire incl. SSE, with error / first-event-error / mid-stream-error modes) registered as a `local` provider on `127.0.0.1` (loopback allowed for `local` under `MODE=selfhosted`).
- [x] 8.2 Add `test/proxy/inference-proxy.e2e-spec.ts` (real Postgres, stub upstream, seeded agent key): auth via Bearer **and** `x-api-key` (valid 200 / invalid 401, both protocol-shaped); `auto`/explicit/provider-qualified/tier/header/default routing (non-streaming + streaming); OpenAI↔Anthropic cross-protocol plain + multi-turn-tool; first-event-error → clean HTTP error; mid-stream error → sanitized terminal frame (no swap); empty-tier/unknown-model/ambiguous-model → protocol 4xx; a slow reader (bounded buffering, no hang); a client disconnect aborts upstream; SIGTERM with an active stream drains; tenant isolation (A's key can't reach B's models).

## 9. Definition of done

- [x] 9.1 `npm test -w packages/data-plane` (resolver + core), `npm test -w packages/control-plane`, and `npm run test:e2e -w packages/control-plane` (proxy e2e) green; `npm run build` passes; lint clean; strict TS, no `any` escapes.
- [x] 9.2 Add a changeset (`@polyrouter/data-plane` + `@polyrouter/control-plane` minor; note the #3 guard extension).
- [x] 9.3 Confirm non-goals hold (no fallback chain / breaker wiring, no RequestLog, no auto pipeline, no schema migration; silent-truncation detection deferred to #12; `auto`→default tier; invariants 1/3/5/12 upheld). #5 translate adapters unmodified; #6/#7/#9 unmodified; #3 guard changed only additively (x-api-key). Update spec/deltas; leave archive-ready.
