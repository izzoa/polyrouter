# Design: fix-proxy-ingress-and-drain

## Context

Four independent defects on the `/v1` hot path, each verified against the code:

- **Body cap:** `main.ts:31` creates the app `bodyParser: false`; `mount.ts:31-32` installs
  `express.json()` / `express.urlencoded({ extended: true })` with no options. body-parser's default
  limit is 100kb. Errors from these parsers are raw Express middleware errors — Nest's
  `ProxyExceptionFilter` (a Nest exception filter) never sees them, so they hit Express's finalhandler
  (text/html, + stack trace when `NODE_ENV !== 'production'`).
- **Drain hang:** `stream-drain.registry.ts:40` aborts the upstream `AbortController` at the deadline;
  `proxy-http.ts:99-111` `drain()` resolves only on `res` `'drain'|'close'|'error'`. A paused-but-open
  client leaves the pump awaiting `drain(res)` forever. `main.ts` calls `app.listen` with no
  `forceCloseConnections`, so `httpServer.close()` waits on the open socket.
- **Breaker miss:** `core.ts:228` `nextWithTimeout(iterator, firstEventTimeoutMs, abort)` starts its
  timer before the adapter's; on timeout it calls `abort.abort()`. `http.ts:222-226` — `openRequest`'s
  catch checks `ctx.signal.aborted` *before* `timedOut`, so a core-initiated abort throws
  `CallCancelledError`, not the typed `ProviderError('unavailable', 'provider first-byte timeout')`.
  `breaker.ts:517` `neutral = isCancellation(err) || isCallerAbort?.() === true` and `breaker.ts:392`
  `outcomeForError` both map `CallCancelledError → neutral`.
- **Hardcoded timeout:** `proxy.config.ts:34` `firstByteTimeoutMs: 30_000`; `proxy.service.ts:266/499`
  pass it as `firstEventTimeoutMs`, and `:902` as the adapter first-byte bound.

Constraints: pinned stack; strict TS; every `/v1` failure must stay in the caller's protocol envelope
(inference-proxy spec); the mid-stream commit boundary (invariant 3) and client-abort neutrality
(commit `8abd4b6`, breaker-caller-abort.spec.ts) must be preserved exactly.

## Goals / Non-Goals

**Goals:** oversized/valid large bodies succeed; oversized/malformed bodies return a protocol-shaped
4xx; `app.close()` always completes within the drain deadline + margin; a hung-at-connect provider
trips the breaker on the streaming path; all three timeout bounds are operator-configurable.

**Non-Goals:** buffered-path idle deadline (E4), metrics/alert disposition of caller-aborts (A-3),
README env docs (E8.4), any change to commit-boundary or genuine-client-abort semantics.

## Decisions

1. **Body parsing is extracted into a testable helper, `/v1` gets the large limit, `/api` keeps the
   default.**
   - Extract `mountBodyParsing(expressApp, maxBodyBytes)` (in `mount.ts` or a small sibling module),
     called from `mountAuth` after the auth handlers. It mounts a **path-routed** parser: for
     `req.path` under `/v1`, `express.json({ limit: maxBodyBytes })` /
     `express.urlencoded({ extended: true, limit: maxBodyBytes })`; otherwise the existing
     default-limit parsers. This confines the raised limit (default `PROXY_MAX_BODY_BYTES` =
     `10 * 1024 * 1024` bytes) to the authenticated proxy surface and leaves `/api` (incl. the
     pre-guard, unauthenticated body window) at body-parser's default — no new memory/CPU amplification
     on `/api` (clink finding 2). body-parser accepts a byte count; pass the number.
   - A 4-arity `(err, req, res, next)` error middleware mounted **immediately after** the parsers:
     - non-`/v1` path → `next(err)` (Nest/Express default handling for `/api`, unchanged).
     - `/v1` path → map by `err.type`: `entity.too.large` → 413 `request_too_large`,
       `entity.parse.failed` / `SyntaxError` → 400 `invalid request body`; render with
       `renderProxyError(new ProxyError(status, msg, 'invalid_request_error', code),
       protocolForPath(req.path))`. If `res.headersSent`, just `res.end()`.
   - *Why in the Express chain, not the Nest filter:* body-parser errors fire in Express middleware
     before Nest routing, so a Nest filter structurally cannot catch them — the E7 review confirmed
     this. Extracting `mountBodyParsing` makes the exact production chain unit-testable against a bare
     Express app (no Nest/auth deps), which is how the body-error cases are verified (clink finding 3).
   - *Alternative rejected:* raising only the limit without the error middleware — still renders HTML
     for a genuinely-oversized body (over the new limit) and for malformed JSON.
   - A `requestTooLarge()` helper is added to `proxy-errors.ts` for the fixed message/type/code.
   - The resolved `maxBodyBytes` is read from the proxy config already loaded at boot and passed into
     `mountAuth`/`mountBodyParsing` as a value (not re-loaded inside the middleware), so there is no
     config-load ordering hazard.

2. **Drain terminates a write-blocked stream — but only destroys the socket when the abort came from
   OUTSIDE the normal completion path (clink finding 1).**
   - `pumpSse`'s `finally` calls `abort.abort()` **unconditionally**, so a check of
     `abort.signal.aborted` after it is always true and cannot distinguish a deadline/disconnect abort
     from normal completion. The fix snapshots the externally-triggered state **before** self-cancel:
     ```ts
     const externallyAborted = abort.signal.aborted; // deadline drain OR client 'close' fired
     res.off('close', onClose);
     deps.registry.deregister(abort);
     abort.abort();
     await frames.return?.(undefined);
     if (externallyAborted && !res.destroyed) res.destroy();   // release a wedged/severed socket
     else if (!res.writableEnded) res.end();                   // normal completion ends cleanly
     ```
     A normally-completed stream has `externallyAborted === false`, so it takes the `res.end()` branch
     exactly as today — no truncation, no reset. Only a deadline-aborted (write-blocked) or
     client-`close` stream is destroyed.
   - `drain(res, signal)` also races `signal`'s `'abort'` (resolving immediately if already aborted) so
     the write loop can't park past the deadline; the shared `done()` callback MUST remove its
     `'abort'` listener too (alongside `'drain'`/`'close'`/`'error'`) so repeated backpressure cycles
     don't accumulate listeners on the signal.
   - *Why not `forceCloseConnections: true` on `app.listen`:* that is a blunt global that also severs
     healthy keep-alive `/api` connections on shutdown; destroying only the drained stream's socket is
     targeted and matches the existing per-stream ownership.
   - The deadline-severed client receives truncation rather than a terminal error frame (the pump
     breaks out before writing); that is the documented deadline behavior and is unchanged.

3. **Breaker trips on system-imposed timeout via BOTH a timer margin and an `isCallerAbort` guard.**
   - *Margin (primary):* `firstEventTimeoutMs = firstByteTimeoutMs + PROXY_EVENT_TIMEOUT_MARGIN_MS`
     (small, e.g. 500ms) so the adapter's own timer fires first and `openRequest` throws the typed
     `ProviderError('unavailable', 'provider first-byte timeout')` (trip-eligible via
     `breakerImpact('unavailable')`). This fixes the common hung-at-connect case cleanly with no
     breaker-classifier change.
   - *Guard (backstop):* `withBreakerStream` already receives an `isCallerAbort` predicate bound to the
     pure client signal. Make the neutrality decision authoritative: when `isCallerAbort` is supplied,
     `neutral = isCallerAbort()` (a `CallCancelledError` with `isCallerAbort() === false` is a
     system-imposed abort → trip). `outcomeForError` also maps `CallCancelledError → neutral`, so the
     settle path must not fall back into it for a system abort — thread the same predicate (or settle
     the outcome explicitly before delegating). Genuine client abort (`isCallerAbort() === true`) stays
     neutral. The buffered `withBreaker` path is unchanged (it already trips via its own timer).
   - *Why both:* the margin fixes the realistic case; the guard makes the invariant hold even if a
     future timing change lets core's timer win, and it is what the provider-adapters spec's sharpened
     scenario asserts. `breaker-caller-abort.spec.ts` is extended to pin: system-abort (predicate
     false) trips; client-abort (predicate true) neutral.

4. **One operator timeout knob + an internal margin — no new core API (clink finding 5).**
   - Core today exposes only `firstEventTimeoutMs` (`core.ts:33`) and reuses it for the first event
     (`:228`) and every inter-event wait (`:328`, `:351`). Rather than add a separate inter-event core
     option (a data-plane API change with fixture churn), keep the single core bound and derive it.
   - Register on the proxy namespace: `PROXY_MAX_BODY_BYTES` (default 10485760),
     `PROXY_FIRST_EVENT_TIMEOUT_MS` (default 30000 — the operator knob, governs the **adapter**
     first-byte bound), `PROXY_EVENT_TIMEOUT_MARGIN_MS` (default 500 — internal). `ProxyRuntime` gains
     `maxBodyBytes`, keeps `firstByteTimeoutMs` (= `PROXY_FIRST_EVENT_TIMEOUT_MS`) as the adapter
     bound, and adds `firstEventTimeoutMs` (= `firstByteTimeoutMs + margin`) used as core's single
     first/inter-event bound.
   - `proxy.service.ts` passes `firstEventTimeoutMs` (the +margin value) as core's `firstEventTimeoutMs`
     and keeps `firstByteTimeoutMs` as the adapter bound. So raising `PROXY_FIRST_EVENT_TIMEOUT_MS`
     scales the adapter bound and (via the fixed margin) core's first/inter-event bound together — one
     knob, satisfying E1.4's acceptance without a core-API change. Boot fail-fast validates the vars.

## Risks / Trade-offs

- [Destroying the socket in `finally` could truncate a normally-completed stream] → the guard is
  `externallyAborted` (snapshotted **before** the unconditional `abort.abort()`), NOT the
  post-abort `abort.signal.aborted`; a normally-completed stream has `externallyAborted === false` and
  takes the `res.end()` branch exactly as today. The existing green stream tests (which assert full
  bodies + `[DONE]`) are the regression guard, plus the E1.2 write-blocked case.
- [The margin makes streamed first-event timeouts fire slightly later than buffered] → intended: the
  adapter's typed timeout must win pre-headers; the ~500ms delta is immaterial against a 30s bound and
  is configurable.
- [`isCallerAbort` threading through `outcomeForError`] → keep the change local to `withBreakerStream`'s
  catch/settle; do not alter `withBreaker` (buffered) classification. Pin both directions in tests so a
  regression on either the trip or the neutral side fails.
- [Body limit as bytes vs a string like '10mb'] → register as an integer byte count (validated
  `z.coerce.number().int().positive()`), pass the number to body-parser; avoids unit-parsing ambiguity.

## Migration Plan

No schema/data. Defaults preserve current behavior except the body limit (100kb → 10mb) and the
protocol-shaped rendering of body errors — both strictly widen what works / improve error shape.
Rollback = revert the commit. A changeset documents the new env vars and the error-shape change.

## Open Questions

None blocking. (Whether to also declare `express` as a direct control-plane dependency — audit
foundation note — is deferred to avoid scope creep.)
