# Proposal: fix-proxy-ingress-and-drain

Implements **FABLE_AUDIT.md Epic E1** (post-baseline hardening; the P0 audit epic).
**Spec refs:** spec.md §6.1, §7.4, §15 (first acceptance criterion); `openspec/specs/{inference-proxy,provider-adapters,app-config}`; CLAUDE.md invariants 1, 3, 12.

## Why

Four defects sit on the `/v1` request path every agent hits:

1. **The 100kb body cap breaks drop-in compatibility.** `main.ts` creates the app with
   `bodyParser: false` and `mountAuth` installs `express.json()` with **no options**, so body-parser's
   default 100kb limit governs `POST /v1/chat/completions` and `/v1/messages`. Coding-agent
   conversations routinely exceed 100KB (spec §7.1's premise is huge harness system prompts), so the
   router 413s requests the provider would serve. The `PayloadTooLargeError` (and any malformed-JSON
   `SyntaxError`) is raised in raw Express middleware ahead of Nest, so Express's finalhandler renders
   it as **text/html** — bypassing `ProxyExceptionFilter`, producing no protocol-shaped error and no
   RequestLog row. This breaks spec §15's first acceptance criterion ("an external agent configured
   only with base_url + api_key … gets working completions, no other changes").
2. **The drain deadline can't terminate a write-blocked stream.** At the deadline
   `StreamDrainRegistry` aborts only the *upstream* controller. A pump parked in `await drain(res)`
   (client stopped reading, socket still open) never resolves — `drain()` races only
   `'drain'|'close'|'error'`, not the abort. The response never ends and `httpServer.close()` (no
   `forceCloseConnections`) waits forever, so **`app.close()` hangs until SIGKILL**, severing every
   other in-flight stream and skipping the log-writer shutdown flush (invariant 12). The E7 change
   built the test harness for this exact case but deliberately left the fix to this epic.
3. **A hung-at-connect provider never trips the breaker on the streaming path.** Core's first-event
   timer (30s) starts before the adapter's identical first-byte timer and fires first; its
   `abort.abort()` makes `openRequest` throw `CallCancelledError` (the `ctx.signal.aborted` branch runs
   before the `timedOut` check), which `withBreakerStream` classifies **breaker-neutral**. So a
   provider that accepts TCP but never sends headers is never skipped: every streamed request waits the
   full timeout before falling back and no `provider_down` alert fires. The buffered path trips
   correctly — the two paths are inconsistent (provider-adapters spec requires a system-imposed
   pre-first-byte timeout to be a tripping `unavailable`, distinct from breaker-neutral caller cancel).
4. **The 30s timeout is hardcoded, so slow local models falsely trip breakers.** `loadProxyRuntime`
   hardcodes `firstByteTimeoutMs: 30_000`, reused as the adapter first-byte bound, core's first-event
   bound, and the per-event inter-event bound. Local models (the primary self-host audience) commonly
   exceed 30s prefill, so every streamed request 503s, five open the breaker, and a false
   `provider_down` alert fires — with no operator knob to change it (invariant 1: explicit routing is
   the reliable core, and it must not be sabotaged by an un-tunable timeout).

## What Changes

- **Body ingest (E1.1):** `mountAuth` passes an explicit, configurable body limit
  (`PROXY_MAX_BODY_BYTES`, default 10mb) to `express.json()`/`express.urlencoded()`. A small
  `/v1`-scoped 4-arity Express error middleware, mounted after the parsers, maps body-parser errors
  (`entity.too.large` → 413, `entity.parse.failed` → 400) into the caller's protocol envelope via the
  existing `renderProxyError`/`protocolForPath`, so oversized/malformed bodies get an OpenAI- or
  Anthropic-shaped JSON error, never HTML or a stack trace. `/api/*` body-parser errors keep Nest's
  default JSON handling.
- **Shutdown drain (E1.2):** `drain()` also resolves on the pump's abort signal; `pumpSse`'s `finally`
  ends and destroys a still-open response when the drain deadline aborted it, so `app.close()` always
  resolves within `streamDrainDeadlineMs` + margin.
- **Breaker on system-imposed timeout (E1.3):** core's `firstEventTimeoutMs` is given a margin above
  the adapter's `firstByteTimeoutMs` so the adapter's typed, trip-eligible
  `ProviderError('unavailable', …)` wins pre-headers; and `withBreakerStream`/`outcomeForError` honor
  an explicit `isCallerAbort` predicate so a `CallCancelledError` with `isCallerAbort() === false`
  settles as a **trip**, not neutral. Genuine client-abort neutrality (commit `8abd4b6`) is preserved
  and pinned in both directions.
- **Configurable timeouts (E1.4):** register `PROXY_FIRST_EVENT_TIMEOUT_MS` (the operator knob,
  default 30s) and an internal `PROXY_EVENT_TIMEOUT_MARGIN_MS` (default 500ms) through the shared
  config registry; `loadProxyRuntime` sets the adapter first-byte bound to the knob and core's single
  first/inter-event bound to knob + margin. One knob scales the streaming timeouts together; no new
  data-plane core option is needed.

## Capabilities

### New Capabilities

*None.*

### Modified Capabilities

- `inference-proxy`: the `/v1` body-parse error requirement gains an oversized-body (413) case and an
  explicit configurable body limit; the shutdown-drain requirement gains the guarantee that the
  deadline terminates a write-blocked stream so shutdown completes.
- `provider-adapters`: the per-call-timeout requirement is sharpened so a **system-imposed** first-byte
  / first-event timeout is a tripping `unavailable` on the streaming path too (only genuine caller
  cancellation is breaker-neutral); the timeout bound becomes configurable.

The new env vars (`PROXY_MAX_BODY_BYTES`, `PROXY_FIRST_EVENT_TIMEOUT_MS`, `PROXY_EVENT_TIMEOUT_MARGIN_MS`)
are registered under the **existing** app-config contract ("capabilities register their own
configuration"), so `app-config` needs no requirement change — their behavior is specified by the two
deltas above and their fail-fast validation by the unchanged boot contract.

## Impact

- **Modified (production):** `packages/control-plane/src/auth/mount.ts` (body limit + error middleware),
  `packages/control-plane/src/proxy/proxy-http.ts` (drain-abort wiring),
  `packages/control-plane/src/proxy/proxy.config.ts` (+ its config registration; timeout knobs),
  `packages/data-plane/src/proxy/core.ts` (first-event margin),
  `packages/data-plane/src/providers/breaker.ts` (`isCallerAbort` guard in `outcomeForError`/settle),
  and the `proxy.service.ts` wiring that passes the new bounds. `proxy-errors.ts` may gain a
  `requestTooLarge` helper.
- **Modified (tests):** extend `stream-lifecycle.e2e-spec.ts` (write-blocked drain, now asserting
  `app.close()` completes), `inference-proxy.e2e-spec.ts` (large body 200, oversized 413, malformed
  400, both protocols), `breaker-caller-abort.spec.ts` + `core.spec.ts` (hung-at-connect trips;
  client-abort stays neutral), and a `loadProxyRuntime` env-override unit test.
- **Schema/migration:** none.
- **Changeset:** **required** — user-facing (new env vars; oversized/malformed `/v1` bodies now return
  a protocol-shaped 4xx instead of an HTML 413; large bodies now succeed).
- **Dependencies:** none added (`express`/body-parser already present via
  `@nestjs/platform-express`; consider declaring `express` explicitly per Backlog A of the audit — out
  of scope here).

## Non-goals

- **The buffered-path post-headers idle deadline** (audit A-4 / E4.3) — the `idleTimeoutMs` semantics
  belong to epic E4's breaker change; this change only touches the streaming first-event path and the
  buffered path's existing behavior is unchanged.
- **Excluding caller-aborts from error-rate metrics / spike alerts** (audit A-3) — a separate concern.
- **The Anthropic-wire terminal error frame test** (audit A-5) — folded into E2.
- **README env-table documentation** for the new vars is E8.4's scope; this change registers and
  validates them (boot fail-fast covers correctness) but does not rewrite the README.
- No change to the mid-stream commit boundary (invariant 3) or to how genuine client disconnects are
  classified — both must be preserved exactly.
