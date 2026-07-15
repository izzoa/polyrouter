# Design: add-inference-proxy-core

## Context

Everything the proxy composes exists: #5 translate (`ProtocolAdapter`: client-wire ↔ IR, `streamParse`/`streamSerialize`), #6 provider adapters (`ProviderAdapter.chat`/`chatStream`: IR ↔ provider-wire over the SSRF-guarded transport; `ProviderError` + classifiers), #9 routing config (owned accessors + `parseRoutingTarget`), #3 `AgentApiKeyGuard`, #7 credential decryption. This is the Layer-0 wiring.

## Decision 1 — Boundary: a framework-agnostic `ProxyCore` in data-plane, Express glue in control-plane

Dependency direction is fixed (`control-plane → data-plane → shared`; data-plane must not import control-plane). The split puts the *reusable engine* in data-plane and only runtime-specific glue in control-plane, so the cloud extraction (§3.3) lifts the engine and rewrites just the pump:

- **`data-plane/src/routing/resolve.ts`** — pure `resolveRoute(config, parsed) → RouteDecision | RouteError` over an already-loaded config snapshot (no DB/Nest/clock).
- **`data-plane/src/proxy/core.ts`** — framework-agnostic orchestration operating on the IR + an injected #6 `ProviderAdapter` + the #5 client `ProtocolAdapter`: `runBuffered(...) → clientWire` and the commit-gated `openStream(...)` coordinator (below). Plus `data-plane/src/proxy/stream-error.ts` — a #10-local, protocol-correct **terminal-error SSE frame** emitter (see Decision 3); #5's adapters stay unmodified.
- **`control-plane/src/proxy/`** — the Nest layer: 3 `/v1` controllers, a `ProxyService` that loads the tenant config snapshot via `PERSISTENCE_PORT`, decrypts the credential (#7) + builds the #6 adapter, calls `ProxyCore`, and **pumps** the result to Express (write/drain/abort). A `/v1` exception filter shapes every error (incl. the guard's 401) into the client protocol envelope.

`ProxyModule` **`imports: [DatabaseModule, AuthModule]`** — `AuthModule` exports `AgentApiKeyGuard`, so the controllers' `@UseGuards(AgentApiKeyGuard)` resolves (otherwise Nest can't construct it and `@CurrentPrincipal` fails closed). `SessionGuard` already returns true for non-`/api`.

## Decision 2 — Route resolution (pure; sorts and selects internally)

`resolveRoute(snapshot, parsed)` takes `{ tiers, entriesByTierId, rules, models, providers }` (raw — the accessors are **unordered**) + `{ modelField, headers }`. It **sorts a copy of `rules`** (`priority` desc, then `created_at`, then `id` — the #9 total order; the management-service sort is not on this path) and **selects a tier's primary by `position === 0`**, never array order. Returns `{ providerId, model, decisionLayer, routingReason }` or `{ error }`.

Phases:

1. **`model` field (an explicit selection terminates here).**
   - empty **or** `auto` (a reserved alias — smart pipeline is #13/#14) → **no explicit selection; fall through to phase 2** (so `auto` still honors a header/rule/default, and `auto` alone lands on `default`).
   - a **provider-qualified** `"<providerId>:<externalId>"` (providerId is a UUID, so the split is unambiguous) → that owned model (`explicit`), done.
   - a **bare external id**: exactly one owned model → it (`explicit`), done; more than one → **`ambiguous_model`** (never a UUID-order guess), done.
   - a **tier key** → that tier's primary (`explicit`), done. (Collision rule: a bare value that is *both* a model id and a tier key resolves to the **model** — explicit-model precedence, §6.1; use a header or rename to select the tier. Documented.)
   - any other **non-empty** value → **`unknown_model`**, done (never a silent fall-through to `default` that hides a typo).
2. **Custom header rule.** The highest-priority `header` rule whose `headers[header_name] === header_value` (exact, case-sensitive) → its `target` (via `parseRoutingTarget`): `tier:<key>` → that tier's primary; `model:<id>` → that owned model directly (`decisionLayer='header'`).
3. **Built-in `x-polyrouter-tier`.** If that header names an owned tier and no custom rule matched → that tier (`header`). (Ordered *before* default rules so the header still forces a tier when a default rule exists.)
4. **Default rule.** A `default`-match rule (if any) → its target (`decisionLayer='default'`).
5. **Seeded `default` tier** → its primary (`default`).

Phases 2–5 run only when phase 1 made no explicit selection (empty/`auto`).

Typed errors (never thrown — returned): `unknown_model` (non-empty unrecognized `model`, nothing else hit), `ambiguous_model`, `empty_tier` (resolved tier has no entries), `unresolved_target` (a rule target no longer resolves to an owned model/tier), `no_default` (no `default` tier — should not happen post-#3, handled defensively). These are the #9 runtime contract; Decision 4 maps them to protocol errors.

## Decision 3 — Commit-gated streaming coordinator (in data-plane)

`ProxyCore.openStream(providerAdapter, clientAdapter, nreq, signal)` encapsulates the invariant-3 boundary and returns **before** the client is committed:

```
Promise<{ kind: 'error'; error: ProxyError }              // pre-commit: nothing written
       | { kind: 'stream'; frames: AsyncGenerator<string> }>  // committed: first success in hand
```

It calls `providerAdapter.chatStream`, then **peeks the first event**. The gate is "first *successful* event", because the adapters can surface failure without throwing:
- the upstream `chatStream` throws (connection/non-2xx/immediate-429) → `{kind:'error'}`;
- the **first yielded event is an IR `error` event** (Anthropic's parser yields one rather than throwing) → `{kind:'error'}` (do **not** commit 200);
- otherwise → `{kind:'stream'}`, and `frames` re-emits the buffered first event then continues.

Inside `frames`, a later thrown error or yielded `error` event is **sanitized** (mapped to a fixed message — never the raw upstream body/id; Anthropic's serializer forwards raw error text and OpenAI's *drops* error events, so we do **not** route terminal errors through #5's `streamSerialize`) and written as a **protocol-correct terminal error frame** by `stream-error.ts` (OpenAI: a `data: {"error":…}` line + `[DONE]`; Anthropic: an `event: error` frame), then the stream ends — never a model swap (there is nothing to swap to; fallback is #12).

**Every pre-commit exit — thrown, first-event-is-error, or timeout — MUST `abort()` and `await iterator.return()`** before resolving `{kind:'error'}`: the upstream generator is paused right after yielding, so its `finally` (which releases the undici dispatcher) does not run on its own; skipping this leaks the connection.

**First-event hang is bounded by `ProxyCore` itself**, not the #6 adapter: #6 clears its first-byte timer when *headers* arrive and does not implement an inter-event timeout, so a 200 that emits no SSE would hang. `openStream` races the first `iterator.next()` against an abortable `firstEventTimeoutMs` timer (and applies the same bound between events); on expiry it aborts + returns the iterator and resolves `{kind:'error'}`. #6 stays unmodified.

**Known limitation (documented, deferred to #12):** OpenAI's parser synthesizes `message_stop` on EOF, so a *silently truncated* upstream stream can look like a clean end. Distinguishing truncation from clean completion needs the robustness/breaker layer (#12); #10 forwards faithfully and does not claim to detect it.

## Decision 4 — Express pump + protocol-shaped errors (control-plane)

Non-streaming: `ProxyCore.runBuffered` → client wire → JSON. Streaming: on `{kind:'error'}` throw a mapped `ProxyHttpError`; on `{kind:'stream'}` write `200` + SSE headers, then:

```
try {
  for await (const frame of frames) {
    if (res.writableEnded) break;
    if (!res.write(frame)) await raceDrainOrClose(res);   // drain vs res 'close'/'error' — never hang
  }
} finally { abort.abort(); await frames.return?.(); }        // always cancel the upstream iterator
```

Client disconnect is wired via **`res.on('close')` + `req.aborted`** (not `req.close`, unreliable after the body ends) → the `AbortController.signal` passed to `chatStream`, so a disconnect cancels the upstream socket promptly.

A **`/v1` exception filter** (registered globally, protocol-shaping only `/v1` paths) renders every failure that reaches the Nest layer — resolver typed errors, `ProviderError` (incl. `kind:'unknown_model'`), `no_default`, and the guard's `UnauthorizedException` — into the caller's envelope (OpenAI `{error:{message,type,code}}` / Anthropic `{type:'error',error:{type,message}}`), protocol chosen by route (`/v1/messages` → anthropic, else openai). Status map: auth→401 (guard) / upstream-auth→502, rate_limit→429, unavailable→503, bad_request→400, unknown/ambiguous model→404, empty/unresolved tier→400, no_default→500. Fixed messages only — never the upstream body/request-id/credential.

**Malformed JSON** fails inside `express.json()` (mounted before Nest routing), so a Nest filter never sees it; a small `/v1`-scoped Express error middleware maps a body-parse error to a protocol-shaped 400. "Every failure" is thus the Nest filter *plus* this middleware.

## Decision 5 — Dual credential header (Anthropic drop-in)

The OpenAI SDK sends `Authorization: Bearer <key>`; the **Anthropic SDK sends `x-api-key: <key>`**. For `/v1/messages` to be a real drop-in, `AgentApiKeyGuard` accepts **either** header (Bearer first, then `x-api-key`); if both are present with different values it's a 401. This is a small additive extension to #3's guard (it already owns bearer extraction), covered by a test asserting the actual Anthropic header shape authenticates. ("Disabled" keys are not a state — a key is revoked by deletion/rotation; the spec says revoked, not disabled.)

## Decision 6 — Bounded graceful drain (invariant 12)

`enableShutdownHooks` is already called in `main.ts`. An in-flight **stream registry** (each streaming request registers/deregisters). The drain runs in **`beforeApplicationShutdown`**, not `onApplicationShutdown`: Nest 11 runs `beforeApplicationShutdown` → disposes the HTTP server (`server.close()`, which itself awaits open connections) → `onApplicationShutdown`, so draining any later would race (or deadlock) HTTP disposal. On `beforeApplicationShutdown`: mark draining (new inference → protocol 503), await active streams up to a bounded deadline, then **abort any still-registered streams** so `server.close()` cannot wait indefinitely. Backpressure (Decision 4) + this registry make the invariant-12 claim honest; covered by a SIGTERM-with-active-stream e2e.

## Decision 7 — Testing without real providers

A local **stub upstream** (HTTP server speaking OpenAI + Anthropic wire incl. SSE, and an error/first-event-error/truncation mode) registered as a `local` provider on `127.0.0.1` (loopback allowed for `local` under `MODE=selfhosted`, so it passes #6's SSRF gate). E2e drives the proxy over HTTP with a seeded agent key: Bearer + `x-api-key` auth (valid/invalid); auto/explicit/qualified/tier/header/default routing; OpenAI↔Anthropic cross-protocol (plain + multi-turn-tool); non-streaming + streaming; first-event-error and mid-stream error → protocol terminal frame (no swap); empty-tier/unknown-model/ambiguous-model 4xx; a slow reader (bounded buffering); SIGTERM drain; tenant isolation. `resolveRoute` gets pure unit tests for every phase + typed error, incl. deliberately shuffled rules/entries.

## Risks / trade-offs

- **Silent-truncation detection deferred to #12** — documented; #10 forwards faithfully and keeps the commit boundary correct so #12 slots in.
- **Provider-qualified model form is `<providerId>:<externalId>`** (UUID prefix keeps the split unambiguous); a friendlier `providerName/…` form can come later. Bare ambiguous ids are a clear `ambiguous_model` error, never a silent pick.
- **No breaker/fallback in #10** — single-model direct call; #6 breaker + fallback chain wire in #12, which the commit boundary already accommodates.
- **Upstream response size is not byte-capped** — #6's buffered body reader and #5's SSE line framing grow with upstream output, so a malicious/broken *provider* could return an unbounded body/line and exhaust a worker. In self-host the operator owns their providers (low risk); a byte cap on the provider transport (the #8 `readCapped` pattern) is a **#6 hardening follow-up**, not folded into #10 (it lives in archived #5/#6). Ordinary complete frames are correctly backpressured; #10's per-event timeout also bounds an idle stall.
