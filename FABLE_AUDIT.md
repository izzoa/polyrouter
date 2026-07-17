# FABLE_AUDIT — polyrouter top-to-bottom audit

> Generated 2026-07-16 against commit `8abd4b6` (clean tree) by a 19-surface multi-agent audit.
> Every file in `packages/` plus all root operational files was read by at least one auditor; every
> medium+ finding below survived adversarial verification (an independent skeptic agent attempted to
> refute it against the real code; high-severity findings got a second, spec-alignment verifier).
> Findings that were refuted are not in this document. **0 critical, 9 high, ~37 medium** confirmed
> findings, organized into 15 executable epics. Line numbers are anchored at commit `8abd4b6` and may
> drift — each finding also names its enclosing symbol.

---

## 0. How to execute this document (instructions for an AI agent)

1. **Work one epic at a time, in document order** (epics are sorted by priority band: P0 → P3).
   Do not interleave epics; each is scoped to be one coherent change.
2. **Follow the project's OpenSpec workflow (CLAUDE.md):** for each epic that changes behavior, open a
   change proposal first (`/opsx:propose <suggested-slug>` is given per epic), lift the epic's
   *Acceptance criteria* into the delta spec as WHEN/THEN scenarios, get the proposal approved, then
   implement `tasks.md` in order and archive. Docs-only and test-only epics may be batched into a
   single smaller change but still go through the flow — CLAUDE.md forbids silent edits.
3. **Definition of done for every epic** (from CLAUDE.md): all task checkboxes done; new/updated tests
   green; `npm run build` passes; lint clean; migration generated if the schema changed; changeset
   added if user-facing; spec deltas archived. Full verification gate:
   ```bash
   npm run build && npm run lint && \
   npm test -w packages/shared -w packages/data-plane -w packages/control-plane -w packages/frontend && \
   npm run test:e2e -w packages/control-plane   # needs docker-compose.dev.yml postgres+redis up
   ```
4. **Do not break what is verified sound.** Section 4 lists load-bearing design decisions the audit
   confirmed correct. If a task seems to require weakening one, stop and flag it — that is a spec
   conflict per CLAUDE.md, not a judgment call.
5. **Smallest correct fix wins.** Fix hints are directions, not designs. Never re-architect, swap
   pinned stack versions, or add cloud-tier features (data-plane split, embedding classifier,
   ClickHouse/Timescale) as part of remediation.
6. **Known flake:** `auth.e2e-spec` occasionally fails in the full e2e run but passes alone — re-run it
   in isolation before treating it as your regression (see Task E7.3, which addresses the cause).

**Severity:** `critical` = exploitable hole / invariant broken with real impact · `high` = spec-required
behavior wrong with realistic trigger · `medium` = robustness gap or mandated-but-missing test ·
`low/info` = backlog (Appendix A). **Effort:** XS < 1h · S = hours · M ≈ a day · L = multi-day.

---

## 1. Scope & method

- **Codebase:** all 4 workspaces (`shared`, `data-plane`, `control-plane`, `frontend`), all root
  operational files (Dockerfile, compose, install.sh, configs), README/spec/openspec corpus.
  231 source files; auditors read 521 files including every test suite and golden fixture.
- **Reference bar:** `spec.md` (§-cited throughout), the 12 CLAUDE.md non-negotiable invariants, and
  the 30 archived `openspec/specs/*/spec.md` capability contracts (authoritative WHEN/THEN).
- **Method:** 19 scoped principal-engineer audit agents + 1 ground-truth runner that actually executed
  the build/test suites → every medium+ finding adversarially verified by 1–2 independent skeptic
  agents (unanimous refutation kills a finding) → coverage diff of files-read vs. source tree
  (complete; only trivial configs/barrels unread, manually inspected).
- **Not audited:** runtime behavior under real provider traffic (no live provider calls were made);
  `node_modules` internals beyond dependency checks.

## 2. Ground truth — what actually passes today (empirical baseline)

| Check | Result | Detail |
|---|---|---|
| `npm run build` | ✅ pass | 4/4 turbo tasks (shared, data-plane, control-plane, frontend) |
| `npm run lint` | ✅ pass | eslint clean |
| `npm run format:check` | ⚠️ fail | 2 Drizzle-**generated** files only: `migrations/meta/_journal.json`, `meta/0007_snapshot.json` (→ Backlog A-1) |
| Unit: shared | ✅ pass | vitest 10 files, 62 tests |
| Unit: data-plane | ✅ pass | jest 27 suites (+1 env-gated skip → E7), 200 tests |
| Unit: control-plane | ✅ pass | jest 30 suites, 172 tests |
| Unit: frontend | ✅ pass | vitest 7 files, 82 tests |
| `npm run test:e2e -w packages/control-plane` | ✅ pass | 30 suites, 177 tests vs real Postgres 16 + Redis 7; auth flake did not occur |
| `npm audit --audit-level=moderate` | ⚠️ 5 moderate | 0 high/critical; all via `better-auth → drizzle-kit` (→ Backlog A-2) |

**The suite is green.** Every finding in this document is a latent defect, spec gap, or missing
regression guard — nothing below is currently breaking the build or tests, which is exactly why the
test-gap findings matter.

## 3. Surface health matrix

| # | Surface | Grade | One-line assessment |
|---|---|---|---|
| 1 | Foundation (boot/config/DI/monorepo) | minor-issues | Fail-fast config, strict TS, enforced boundaries — one high ingress defect (E1) |
| 2 | DB schema & tenant isolation | minor-issues | Exemplary central tenancy seam; one pagination-cursor bug (E3) |
| 3 | Auth (sessions, agent keys, rate limit) | minor-issues | Invariant-7-correct planes; IPv6 + case-sensitivity gaps (E9) |
| 4 | Provider adapters & circuit breaker | **needs-work** | Clean seam, correct taxonomy; breaker cannot re-close under streaming load (E4) |
| 5 | Provider management CRUD | minor-issues | Encrypted creds, SSRF-gated URLs; unbounded sync ingestion (E11) |
| 6 | SSRF guard & secret encryption | **solid** | Complete range set, real rebinding defense, textbook AES-256-GCM — nothing confirmed |
| 7 | Protocol translation (IR + goldens) | **needs-work** | Sound IR core; Anthropic stream serializer non-conformant, fields silently stripped (E2) |
| 8 | Proxy core (streaming/fallback/drain) | minor-issues | Commit boundary exactly per spec; edge defects in drain/timeouts (E1) |
| 9 | Routing engine (L0/L1/L3) | minor-issues | Precedence airtight, degradation genuinely never-stall; baseline saturation (E10) |
| 10 | Routing-config API | minor-issues | Central tenancy, atomic replaces; null-PATCH 500s, cascade-delete bricking (E10) |
| 11 | Pricing & cost recording | minor-issues | Invariant 4 holds end-to-end; catalog coverage + shutdown-flush gaps (E5) |
| 12 | Budgets & spend limits | minor-issues | Race-free by design (single-writer reconcile); silent degraded modes (E6) |
| 13 | Notifications | minor-issues | Invariant 11 proven end-to-end; test-send unthrottled, one SSRF test gap (E14) |
| 14 | Analytics API | **needs-work** | Owner-scoped, snapshot-only costs; keyset cursor skips rows (E3) |
| 15 | Frontend SPA | minor-issues | Spec-perfect key handling, zero XSS sinks; 401/setup-guide/copy defects (E12) |
| 16 | Observability (OTel + Prometheus) | minor-issues | Hygienic attributes, exactly-once cost metrics; useless histogram buckets (E15) |
| 17 | Packaging (Docker/compose/install) | minor-issues | Correct PID-1/drain/healthcheck; installer re-run trap (E13) |
| 18 | Test suite quality | minor-issues | All four mandated suites real & adversarial; invariant-12 and CI holes (E7) |
| 19 | Docs & OSS hygiene | minor-issues | Strong changeset/branding discipline; **no LICENSE**, no usage docs (E8) |

## 4. Verified sound — do not break

The audit confirmed these as correct and load-bearing. Treat them as constraints:

- **Tenancy seam** — `ownershipPredicate` in `packages/shared/src/server/tenancy.ts` is the single
  predicate site; raw `DRIZZLE`/`PG_POOL` are module-private symbols proven un-injectable by test;
  inserts force `owner` from the principal and strip forged owner fields. Never add a DB access that
  bypasses `PersistencePort`/`IdentityPort`.
- **Mid-stream commit rule (invariant 3)** — `openAttemptStream` commits on the first successful
  normalized event; post-commit failures emit a fixed sanitized terminal frame, never a model swap.
  Tested at the HTTP layer in three variants. E1/E2 tasks must preserve this boundary exactly.
- **SSRF connect-time pinning** — every production egress resolves → validates → connects to the
  validated IP with a post-connect re-check (`createGuardedDispatcher`); HARD ranges are
  never allowlistable. Keep new outbound paths on `guardedFetch`/`assertNetworkHostSafe`.
- **Append-only pricing catalog + per-row snapshots (invariant 4)** — one advisory-locked write path,
  monotonic `valid_from`; analytics/budgets sum stored `cost` at µ$ rounding and never join live
  prices. `usage.ts` correctly subtracts cached tokens (uncached-input convention) — keep it.
- **Budget counters are single-writer** — the scheduler is the only counter writer (monotonic SET-max
  Lua, period-id-embedded keys); the proxy check is a bounded read. Do **not** introduce per-request
  read-modify-write increments alongside it.
- **Breaker settles before yielding errors** — `withBreakerStream` settles the outcome *before*
  yielding the error event so consumers can't launder failures into neutral. E4 changes must keep this
  ordering, and client-abort neutrality (commit `8abd4b6`) must survive.
- **Auto-layer gating** — smart layers only refine `model === 'auto' && decisionLayer === 'default'`;
  baseline reads are synchronous over an in-process LRU (never await Redis on the hot path); settings
  reads are deadline-bounded. Invariant 1 depends on all three.
- **Notification isolation** — every producer path is `void`-fire-and-forget through a
  2s-deadline-bounded enqueue; delivery failures are sanitized fixed codes. Keep new producers on
  `NotificationService.emit`.
- **Boot fail-fast config registry** — all env vars register through `packages/shared/src/config/registry.ts`
  (names, never values, in errors). New config goes through it, not `process.env` reads.
- **Frontend key handling** — raw agent key exists only in transient store memory, shown once,
  cleared on dismiss/sign-out; no `innerHTML` anywhere. E12 fixes must not persist secrets.

## 5. Epic index

| Epic | Priority | Title | Findings | Effort |
|---|---|---|---|---|
| [E1](#epic-e1) | **P0** | /v1 ingress & streaming lifecycle correctness | 4 | ~M |
| [E2](#epic-e2) | **P0** | Protocol translation fidelity & golden coverage | 10 | ~L |
| [E3](#epic-e3) | P1 | Analytics keyset pagination correctness | 2 | ~S |
| [E4](#epic-e4) | P1 | Circuit-breaker recovery & upstream timeouts | 3 | ~M |
| [E5](#epic-e5) | P1 | Cost-recording completeness & pricing coverage | 4 | ~M |
| [E6](#epic-e6) | P1 | Budget-enforcement operability | 3 | ~S/M |
| [E7](#epic-e7) | P1 | CI pipeline & invariant-12 test coverage | 3 | ~M |
| [E8](#epic-e8) | P1 | OSS launch readiness: LICENSE & operator docs | 5 | ~S/M |
| [E9](#epic-e9) | P2 | Auth plane & rate-limit hardening | 2 | ~S |
| [E10](#epic-e10) | P2 | Routing-config robustness & structural baseline | 3 | ~M |
| [E11](#epic-e11) | P2 | Provider-management input bounds | 1 | ~S |
| [E12](#epic-e12) | P2 | Dashboard correctness | 4 | ~M |
| [E13](#epic-e13) | P2 | Installer idempotency | 1 | ~S |
| [E14](#epic-e14) | P3 | Notifications hardening | 2 | ~S |
| [E15](#epic-e15) | P3 | Observability accuracy | 2 | ~S |

---

<a id="epic-e1"></a>
## EPIC E1 — /v1 ingress & streaming lifecycle correctness · **P0** · ✅ SHIPPED 2026-07-16 (`fix-proxy-ingress-and-drain`)

**Proposal slug:** `fix-proxy-ingress-and-drain` ·
**Spec refs:** spec.md §6.1, §15 (first criterion); `openspec/specs/inference-proxy`; CLAUDE.md invariants 3, 12
**Why:** These four defects sit on the request path every agent hits. The body cap breaks the
product's headline acceptance criterion ("an external agent configured only with base_url + api_key
gets working completions, no other changes"); the drain and timeout defects undermine invariant 12 and
the breaker's purpose for exactly the self-host workloads (long streams, slow local models) the
product targets.

### Task E1.1 — Raise the /v1 body limit and render body-parser errors in protocol shape ✅ `[high/S]`
- **Where:** `packages/control-plane/src/auth/mount.ts:31` (`mountAuth`); `packages/control-plane/src/proxy/proxy-exception.filter.ts`
- **Defect:** `main.ts` disables Nest's parser (`bodyParser:false`) and `mountAuth` installs
  `express.json()` with **no options** → body-parser's default **100kb** limit governs
  `POST /v1/chat/completions` and `/v1/messages`. Real agent conversations routinely exceed 100KB
  (spec §7.1's premise is huge harness system prompts), so the router 413s requests the provider would
  serve. The `PayloadTooLargeError` is raised in raw Express middleware, so Express's default handler
  renders it as **text/html** (including a stack trace when `NODE_ENV !== 'production'`) — it never
  reaches `ProxyExceptionFilter`, no protocol-shaped JSON error, no RequestLog row.
- **Fix:** In `mountAuth`, pass an explicit generous, configurable limit (e.g.
  `express.json({ limit })` from a new registered config var `PROXY_MAX_BODY_BYTES`, default ≥ 10mb),
  registered via the shared config registry. Add a small 4-arity Express error middleware after the
  parsers that maps body-parser errors (`entity.too.large` → 413, `entity.parse.failed` → 400) into
  the protocol envelope for `/v1/*` paths (reuse `renderProxyError`) and JSON for `/api/*`.
- **Acceptance criteria:**
  - WHEN a ~200KB valid request is POSTed to `/v1/chat/completions` THEN it routes normally (200 from stub upstream).
  - WHEN a body exceeds the configured limit THEN the response is 413 with an **OpenAI-shaped** error body on `/v1/chat/completions` and **Anthropic-shaped** (`{type:'error',error:{...}}`) on `/v1/messages` — never HTML, never a stack trace.
  - WHEN malformed JSON is POSTed THEN a 400 in the caller's protocol envelope is returned.
- **Verify:** new e2e cases in `packages/control-plane/test/proxy/inference-proxy.e2e-spec.ts`; `npm run test:e2e -w packages/control-plane`.

### Task E1.2 — Make the drain deadline able to terminate a write-blocked stream ✅ `[medium/S]`
- **Where:** `packages/control-plane/src/proxy/stream-drain.registry.ts:40` (`beforeApplicationShutdown`); `packages/control-plane/src/proxy/proxy-http.ts:86-111` (`pumpSse`/`drain`)
- **Defect:** At the drain deadline the registry only aborts the **upstream** controller. A pump parked
  in `await drain(res)` (client stopped reading, socket open) never resolves — `drain()` races only
  `'drain'|'close'|'error'`. The response never ends; `httpServer.close()` (no
  `forceCloseConnections`) waits forever → **`app.close()` hangs until SIGKILL**, severing all other
  streams and skipping the log-writer shutdown flush.
- **Fix:** Pass the pump's abort signal into `drain()` and add it to the race; in `pumpSse`'s
  `finally`, when `abort.signal.aborted && !res.writableEnded`, `res.end()` then `res.destroy()`.
- **Acceptance criteria:** WHEN a streaming client stops reading (full TCP window) and SIGTERM arrives
  THEN `app.close()` resolves within `streamDrainDeadlineMs` + margin and the process exits cleanly.
- **Verify:** integration test with a raw `net` client that reads nothing (see Task E7.2 which adds the harness); breaking the abort wiring must fail it.

### Task E1.3 — Stop the first-event timeout from masking hung-at-connect providers as breaker-neutral ✅ `[medium/S]`
- **Where:** `packages/data-plane/src/proxy/core.ts:307` (`nextWithTimeout`); `packages/data-plane/src/providers/http.ts:223-226`; `packages/data-plane/src/providers/breaker.ts:392,517`
- **Defect:** Core's 30s first-event timer starts before breaker admission/DNS and fires before the
  adapter's identical 30s first-byte timer. Its `abort.abort()` makes `openRequest` throw
  `CallCancelledError`, which `withBreakerStream` classifies **breaker-neutral** — so a provider that
  accepts TCP but never sends headers **never trips the breaker** on the streaming path: every request
  waits the full 30s before falling back, and no `provider_down` alert ever fires. (Buffered path trips
  correctly — the two paths are inconsistent.)
- **Fix (both halves):** give core's `firstEventTimeoutMs` a margin above the adapter's
  `firstByteTimeoutMs` so the adapter's typed, trip-eligible `ProviderError` always wins pre-headers;
  **and** in `withBreakerStream`, when an `isCallerAbort` predicate is supplied, let it own the
  neutrality decision (a `CallCancelledError` with `isCallerAbort() === false` must settle as a trip —
  note `outcomeForError` at breaker.ts:392 also maps `CallCancelledError` to neutral and needs the same
  guard). Client-abort neutrality (commit `8abd4b6`) must be preserved — extend
  `breaker-caller-abort.spec.ts` to pin both directions.
- **Acceptance criteria:** WHEN a provider accepts connections but never returns headers THEN five
  streamed requests open its breaker (subsequent requests skip it fast) while a genuine client abort
  during the same window remains breaker-neutral.
- **Verify:** unit test in `core.spec.ts`/`breaker-caller-abort.spec.ts` driving `openAttemptStream` with a never-yielding stream, `firstEventTimeoutMs=40`, shared `InMemoryBreakerStore`; assert transition to open. `npm test -w packages/data-plane`.

### Task E1.4 — Make the proxy timeouts configurable (slow local models falsely trip breakers) ✅ `[medium/S]`
- **Where:** `packages/control-plane/src/proxy/proxy.config.ts:34` (`loadProxyRuntime`)
- **Defect:** `firstByteTimeoutMs: 30_000` is hardcoded and reused as (a) the adapter headers/first-byte
  bound, (b) core's first-event bound, (c) the per-event inter-event bound. Local models (the primary
  self-host audience) commonly exceed 30s prefill → every streamed request 503s, five open the
  breaker, and a false `provider_down` alert fires. No operator knob exists.
- **Fix:** Register config vars via the shared registry (e.g. `PROXY_FIRST_EVENT_TIMEOUT_MS`,
  `PROXY_STREAM_EVENT_TIMEOUT_MS`, keeping current defaults), read them in `loadProxyRuntime`, and
  apply the E1.3 margin between the adapter and core bounds. Document in README env table (E8.4).
- **Acceptance criteria:** WHEN the operator sets the first-event timeout to 120000 THEN a stream whose
  first token arrives at 45s succeeds and the breaker stays closed; WHEN unset THEN behavior is unchanged.
- **Verify:** unit test on `loadProxyRuntime` env override; boot-failfast e2e still green (registry validation).

**Related backlog:** A-3 (client aborts inflate error-rate metrics/spike alerts), A-4 (buffered path
has no post-headers deadline — see also E4.3), A-5 (Anthropic-wire terminal error frame untested — folded into E2.6).

---

<a id="epic-e2"></a>
## EPIC E2 — Protocol translation fidelity & golden coverage · **P0** · ✅ SHIPPED 2026-07-17 (request + stream halves)

**Proposal slug:** `fix-translation-fidelity` (IR extensions need their own delta spec) ·
**Spec refs:** spec.md §6.3, §7.7, §15; `openspec/specs/protocol-translation`; CLAUDE.md invariant 2
**Why:** The translate module's core is sound (IR, usage math, purity, tool grouping), but the
Anthropic client-facing stream serializer — the entire streamed `/v1/messages` surface — is
protocol-non-conformant and untested, several high-value request fields are silently stripped
(one of which disables Anthropic prompt caching and inflates user spend ~10× on cached input), and
streamed usage is never requested from OpenAI upstreams so cost accuracy is degraded on the dominant
path. Execute E2.1–E2.5 as one change (they touch the same files); E2.6–E2.10 can follow.

### Task E2.1 — Emit conformant `message_delta` usage when serializing streams to Anthropic clients ✅ `[high/S]`
- **Where:** `packages/data-plane/src/proxy/translate/anthropic.ts:515` (`streamSerialize`)
- **Defect:** Anthropic's wire requires every `message_delta` to carry `usage.output_tokens`; SDKs
  validate this (Python raises, TS accumulator reads it unguarded). `streamSerialize` omits `usage`
  when the IR event has none (the normal case for an OpenAI upstream's finish chunk), and when a
  usage-only second delta does arrive it emits `stop_reason: null`, clobbering the already-delivered
  stop reason in SDK accumulators (`finalMessage.stop_reason === 'tool_use'` breaks).
- **Fix:** Accumulate partial usage + buffer stop info across the stream; emit a **single** conformant
  `message_delta` (`usage.output_tokens` = best known, wire-0 if unknown; buffered `stop_reason`,
  never null-after-set) immediately before `message_stop`.
- **Acceptance criteria:** WHEN an Anthropic-SDK client streams from an OpenAI-compatible provider THEN
  every emitted `message_delta` parses under the Anthropic SDK event schema and the accumulated final
  message has a non-null `stop_reason`.
- **Verify:** new stream test: `collect(ant.streamSerialize(oai.streamParse(<openai golden stream>)))`, assert every `message_delta` has numeric `usage.output_tokens`. `npm test -w packages/data-plane`.

### Task E2.2 — Set `stream_options.include_usage` on outbound OpenAI streamed requests ✅ `[high/XS]`
- **Where:** `packages/data-plane/src/proxy/translate/openai.ts:285` (`requestOut`)
- **Defect:** OpenAI upstreams send the terminal usage chunk only when the request opts in.
  `requestOut` never emits `stream_options`, so the `streamParse` machinery built to read it never
  fires: **100% of streamed requests against real OpenAI record `usage_estimated=true`** (chars/4)
  when exact numbers were available — violating request-logging's "SHALL prefer the provider usage".
- **Fix:** When `ir.stream === true`, emit `stream_options: { include_usage: true }` in `requestOut`
  (canon already drops the key, so golden round-trips stay green). Optionally add an `AdapterQuirk`
  to suppress it for legacy OpenAI-compatible servers that reject unknown fields.
- **Acceptance criteria:** WHEN a streamed request goes to an OpenAI-compatible provider that honors
  the flag THEN the RequestLog row records provider usage with `usage_estimated=false`.
- **Verify:** unit test on `requestOut` (stream vs non-stream); e2e against the stub upstream sending a usage chunk.

### Task E2.3 — Stop fusing adjacent text blocks without a separator ✅ `[high/S]`
- **Where:** `packages/data-plane/src/proxy/translate/anthropic.ts:270` (`requestOut`, system field); `packages/data-plane/src/proxy/translate/openai.ts:113` (`blocksToContent`), `:229` (system via `toolResultText`)
- **Defect:** Multi-block `system`/content arrays are joined with `''`, fusing the last word of one
  block with the first of the next — **silently rewriting prompts on the same-protocol
  Anthropic→Anthropic passthrough** (the reliable-core path; multi-block system is the standard
  prompt-caching layout). Both wires can represent block boundaries losslessly, so the loss is unforced.
- **Fix:** Anthropic out: emit `system` as a text-block array when the IR has >1 block. OpenAI out:
  emit a content-parts array (or multiple system messages) when >1 text block, instead of `join('')`.
  Add multi-block golden fixtures.
- **Acceptance criteria:** WHEN an Anthropic client sends `system: [blockA, blockB]` to an Anthropic
  provider THEN the upstream receives two blocks byte-identical to the input (canonical round-trip
  equivalence holds).
- **Verify:** new golden fixture (2-block system + 2-text-block user message); same-protocol round-trip test. `npm test -w packages/data-plane`.

### Task E2.4 — Preserve `cache_control` so Anthropic prompt caching works through the router ✅ `[high/M]`
- **Where:** `packages/data-plane/src/proxy/translate/anthropic.ts:197-202` (`requestIn`), `wire/anthropic.ts:6-9`
- **Defect:** `cache_control` markers are stripped from system/content/tools (wire types don't model
  the field). Any caching-reliant agent (the norm for coding agents) **loses prompt caching entirely**
  through polyrouter — input billed at full rate (~10× cache-read) with zero indication, and the
  RequestLog cache-token columns stay 0 despite the usage layer being built to record them.
- **Fix:** Model `cache_control` as an optional passthrough field on IR text/tool_use/tool_result
  blocks, system blocks, and tools; emit on the Anthropic wire out; document the drop crossing to
  OpenAI in `canon.ts` `DROP_KEYS`. Add a golden fixture with `cache_control`.
- **Acceptance criteria:** WHEN an Anthropic client sends `cache_control` on a system block routed to an
  Anthropic provider THEN the outbound body carries it unchanged and cache-read/write tokens appear in
  usage; WHEN routed to an OpenAI provider THEN the drop is documented, not accidental.
- **Verify:** golden round-trips byte-identically; e2e asserts outbound stub body contains `cache_control`.

### Task E2.5 — Carry `response_format` and reasoning controls instead of silently stripping them ✅ `[high/M]`
- **Where:** `packages/data-plane/src/proxy/translate/openai.ts:207/273` (`requestIn`/`requestOut`), `wire/openai.ts:43-57`
- **Defect:** The allowlist rebuild drops `response_format` (JSON mode / json_schema),
  `reasoning_effort`, Anthropic `thinking`, penalties, `logit_bias`. Same-protocol passthrough
  silently changes model behavior (client asked for guaranteed JSON, gets prose; reasoning modes can't
  be enabled through the router at all). spec §7.2 even names structured-output demand as a routing
  signal, but the field never survives `requestIn`.
- **Fix:** Add optional IR fields (`responseFormat`, `reasoningEffort`/`thinkingBudget`) carried
  opaquely on same-protocol out and mapped-or-documented-dropped cross-protocol. This extends the IR —
  write the OpenSpec delta accordingly. (Minimum acceptable alternative: reject unsupported fields
  with a clear 400 rather than silently stripping.)
- **Acceptance criteria:** WHEN an OpenAI client sends `response_format: {type:'json_schema',...}` to an
  OpenAI provider THEN the upstream request contains it verbatim; WHEN crossing to Anthropic THEN the
  behavior (map or documented drop) is explicit in canon + golden README.
- **Verify:** golden fixture with `response_format` round-trips OpenAI→OpenAI; cross fixture documents Anthropic-bound behavior.

### Task E2.6 — Cover the Anthropic stream serializer & in-band error events in the golden suite ✅ `[medium/M]`
- **Where:** `packages/data-plane/src/proxy/translate/stream.spec.ts`, `golden/`, `packages/control-plane/test/proxy/`
- **Defect:** `ant.streamSerialize` has no golden/cross-translation coverage (only a shape check in
  `cascade.spec.ts`); no fixture or test contains an in-band `error` stream event despite
  `golden/README.md` claiming coverage; no `/v1/messages` `stream:true` e2e exists anywhere; the
  Anthropic terminal error frame and error envelope are asserted nowhere. This blind spot is what let
  E2.1 ship.
- **Fix:** Add (a) cross-stream test OpenAI-golden-chunks → `oai.streamParse` → `ant.streamSerialize`
  with frame-level golden assertions; (b) an in-band error-event fixture per protocol through
  `streamParse` + core's terminal-frame handling (covers Backlog A-5); (c) an Anthropic malformed
  `tool_use` fixture; (d) a streamed `/v1/messages` e2e case incl. a 401 and mid-stream error asserting
  the Anthropic envelope.
- **Acceptance criteria:** the openspec golden matrix ("error events, both stream directions") is
  actually satisfied; breaking any Anthropic client-bound frame shape fails a test.
- **Verify:** `npm test -w packages/data-plane` + `npm run test:e2e -w packages/control-plane`.

### Task E2.7 — Do not fabricate `message_stop`/`[DONE]` when the upstream stream is truncated ✅ `[medium/S]`
- **Where:** `packages/data-plane/src/proxy/translate/openai.ts:457-460` (`streamParse`)
- **Defect:** `message_stop` is yielded whether the loop saw `data: [DONE]` or the source was simply
  exhausted (LB idle-timeout cutting a stream cleanly, or a server that never sends `[DONE]`). Core
  then marks `clean=true` → the client receives a full terminator and the RequestLog says
  `status=success` for a **truncated** answer — truncation laundered into success on wire and record.
- **Fix:** Track whether the protocol terminator was actually observed; on exhaustion without it,
  yield a normalized `error` event (`truncated`) so core emits its terminal error frame and records
  `status=error`.
- **Acceptance criteria:** WHEN an upstream SSE stream ends without `[DONE]`/finish chunk THEN the
  client receives a terminal error frame (not a clean stop) and the row records `status=error`.
- **Verify:** unit test feeding chunks without `[DONE]`; assert no `message_stop` and error outcome.

### Task E2.8 — Degrade gracefully on unknown content-block and content-part types ✅ `[medium/S]`
- **Where:** `packages/data-plane/src/proxy/translate/anthropic.ts:90` (`antBlockToIr`, no default case); `openai.ts:62` (`partsToBlocks` destructures `image_url` for any non-text part)
- **Defect:** An Anthropic-side `thinking`/`redacted_thinking`/`server_tool_use` block becomes
  `undefined` in the IR and explodes later with a `TypeError` surfaced as a misleading `unavailable`
  provider error (via `toProviderError` in core.ts) — **after the upstream already succeeded and
  billed tokens**. An OpenAI request with an `input_audio`/`file` part throws inside `requestIn`.
  Contradicts the module's never-throw-on-model-output principle.
- **Fix:** Add default cases: unknown response blocks degrade to skipped/empty text blocks (documented);
  unknown request parts are skipped (documented).
- **Acceptance criteria:** WHEN a provider returns a `thinking` block THEN the response serializes
  without throwing; WHEN a client sends an unknown content part THEN the request either succeeds
  (part skipped) or fails with a clear 400 — never a TypeError-driven 500/`unavailable`.
- **Verify:** unit tests for both directions. `npm test -w packages/data-plane`.

### Task E2.9 — Clamp `temperature` to Anthropic's 0–1 range on cross-translation ✅ `[medium/XS]`
- **Where:** `packages/data-plane/src/proxy/translate/anthropic.ts:286` (`requestOut`)
- **Defect:** OpenAI temperature ranges 0–2; verbatim copy makes Anthropic return 400
  `invalid_request_error` → classified `bad_request` → **fallback refused** → the whole request fails
  even when an OpenAI fallback member would succeed, defeating §7.4's chain promise for a legal
  OpenAI request. (top_p is 0–1 in both protocols — temperature only.)
- **Fix:** `min(temperature, 1)` in Anthropic `requestOut`; document the lossy mapping in the golden README.
- **Acceptance criteria:** WHEN an OpenAI client sends `temperature: 1.5` routed to an Anthropic model
  THEN the upstream receives `1` and the request serves.
- **Verify:** unit test on `requestOut`.

### Task E2.10 — Give `n > 1` an explicit policy (reject with a clear 400) ✅ `[medium/XS]`
- **Where:** proxy request path / `packages/data-plane/src/proxy/translate/openai.ts:152`
- **Defect:** The protocol-translation spec scopes the IR to n=1 and delegates n>1 policy to the proxy
  — but no layer ever decided: `n` is silently dropped and best-of-n clients get one choice with zero
  indication (code indexing `choices[1]` breaks).
- **Fix:** Reject `n > 1` with a clear OpenAI-shaped 400 ("n>1 is not supported") at the proxy request
  path; record the decision in the inference-proxy delta spec.
- **Acceptance criteria:** WHEN a client sends `n: 2` THEN the response is 400 with an explanatory
  protocol-shaped error; WHEN `n: 1`/absent THEN behavior is unchanged.
- **Verify:** e2e case on `/v1/chat/completions`.

**Related backlog:** A-6 (duplicate `tool_use_start` on repeated id/name fragments), A-7 (uninvited
trailing usage chunk to OpenAI clients), A-8 (user-message `[text, tool_result]` reordering),
A-9 (`message_start` fabricated `input_tokens: 0` cross-protocol — document in golden README).

---

<a id="epic-e3"></a>
## EPIC E3 — Analytics keyset pagination correctness · P1 · ✅ SHIPPED 2026-07-17 (`fix-analytics-keyset-cursor`)

**Proposal slug:** `fix-analytics-keyset-cursor` ·
**Spec refs:** `openspec/specs/analytics-api` ("walking all pages returns every in-range row exactly once"); `openspec/specs/dashboard-analytics`; spec.md §9
**Why:** Found independently by two auditors. Dashboard pagination silently drops rows — the rows are
counted in summaries but unreachable in the list, so the dashboard is silently inconsistent with itself.

### Task E3.1 — Carry full timestamp precision through the request-list cursor ✅ `[high/S]`
- **Where:** `packages/control-plane/src/database/analytics.queries.ts:53` (`encodeCursor`) and `:356-366` (cursor predicate); `packages/control-plane/src/analytics/analytics.service.ts:90-105` (`parseCursor`)
- **Defect:** `request_log.created_at` is `timestamptz` from `now()` (µs precision) and the LogWriter
  batches rows in one `INSERT` — **every row in a flush shares one identical µs timestamp**. The cursor
  round-trips through a JS `Date` (ms precision): `lt(createdAt, cursor)` and `eq(createdAt, cursor)`
  both compare `.123` against stored `.123456`, so neither matches — any page boundary landing inside
  a batch **silently skips the rest of the tie group**. The existing e2e can't catch it (seeds are
  ms-clean).
- **Fix (recommended):** select the raw timestamp text alongside each row
  (``sql`${requestLogs.createdAt}::text` ``), encode that string in the cursor, and bind it back as a
  string in the `lt`/`eq` comparisons (drizzle passes strings through; Postgres compares at full
  precision). Code-only; fixes historical rows; keeps the `(created_at, id)` index order.
  *Alternative:* migrate the column to `timestamptz(3)` — heavier (migration on the hottest table,
  rounds stored values) — only if the string-cursor approach proves awkward.
- **Acceptance criteria:** WHEN ≥3 rows are inserted in one `insertMany` batch (DB-default `created_at`)
  and the list is walked with `limit=1` THEN every row id appears exactly once across pages.
- **Verify:** Task E3.2's test fails before, passes after. `npm run test:e2e -w packages/control-plane -- analytics`.

### Task E3.2 — Add a µs-realistic pagination e2e (current seeds mask the bug) ✅ `[medium/XS]`
- **Where:** `packages/control-plane/test/analytics/analytics.e2e-spec.ts:29` (seeds)
- **Defect:** All seeds are explicit `.000`-millisecond ISO constants, so the "exactly once" spec
  scenario is asserted only against data that cannot trigger the failure — the fix in E3.1 could
  regress with the suite green.
- **Fix:** Add a pagination case inserting rows via `port.requestLogs.insertMany` **without**
  `created_at` (shared µs `now()`), plus one with explicit µs values (`...T11:30:00.123456Z`); walk
  pages, assert exactly-once coverage.
- **Verify:** run new test against unfixed code → must fail with skipped rows; then pass.

---

<a id="epic-e4"></a>
## EPIC E4 — Circuit-breaker recovery & upstream timeouts · P1 · ✅ SHIPPED 2026-07-17 (`fix-breaker-recovery`)

**Proposal slug:** `fix-breaker-recovery` ·
**Spec refs:** `openspec/specs/provider-adapters` (half-open probe, Redis server clock, idle timeout); CLAUDE.md invariants 1, 10
**Why:** The breaker opens correctly but can fail to ever close again under the product's dominant
workload (long streams), throttling a healthy provider indefinitely; two smaller defects undermine its
multi-instance correctness and its hang protection.

### Task E4.1 — Let a long-lived streaming probe close the breaker (lease renewal) ✅ `[high/M]`
- **Where:** `packages/data-plane/src/providers/breaker.ts:86-99` (`decide`, half-open reclaim), `:112` (stale-generation no-op), `:499-513` (`withBreakerStream` settles at stream end), Lua mirrors at `:225/:239`
- **Defect:** A streaming probe settles success only at stream end, but LLM streams routinely outlive
  `probeLeaseMs` (10s). The next admission reclaims the lease and **bumps the generation**, so the
  in-flight probe's eventual success is discarded as stale. Under steady long-stream traffic the
  breaker stays `half_open` forever: ~1 request per 10s reaches the recovered provider; everything
  else skips/fails.
- **Fix:** Renew the probe lease while the probe is alive: add a store op (one small Lua script)
  extending `probeExpiresAt` for the **current generation**, called from `withBreakerStream` on each
  yielded event when `token.isProbe`. (Keep the settle-before-yield ordering — see §4.) Apply
  identically to `InMemoryBreakerStore`.
- **Acceptance criteria:** WHEN the breaker is half-open and the admitted probe is a stream spanning
  several lease windows THEN its successful completion closes the breaker, and concurrent `decide`
  calls during the probe still return skip (single-probe preserved).
- **Verify:** new jest test with injected clock advancing between stream events past `probeLeaseMs`; `npm test -w packages/data-plane`; Lua parity in `breaker-redis.spec.ts` (runs once E7.1 lands).

### Task E4.2 — Use the Redis server clock in the breaker Lua scripts ✅ `[medium/S]`
- **Where:** `packages/data-plane/src/providers/breaker.ts:215` (`DECIDE_LUA`), `:233` (`COMPLETE_LUA`), `RedisBreakerStore.decide/complete`
- **Defect:** The capability spec mandates "a single Lua script … using the **Redis server clock**";
  both scripts take `now` as `ARGV[1]` from each instance's `Date.now()`. Clock skew between proxy
  instances corrupts cooldown/lease arithmetic fleet-wide (a 45s-ahead instance defeats the cooldown).
- **Fix:** Derive `now` inside both scripts from `redis.call('TIME')` (`sec*1000 + usec/1000`);
  `RedisBreakerStore` ignores the caller's `now` (keep it for `InMemoryBreakerStore`/tests — interface
  unchanged).
- **Acceptance criteria:** WHEN two store callers pass wildly different `now` values THEN
  cooldown/probe decisions are consistent (driven by server time).
- **Verify:** extend `breaker-redis.spec.ts`; `REDIS_URL=... npm test -w packages/data-plane -- breaker-redis`.

### Task E4.3 — Enforce a body/idle deadline on buffered upstream reads (make `idleTimeoutMs` real) ✅ `[medium/S]`
- **Where:** `packages/data-plane/src/providers/http-adapter.ts:104` (`chat`), `http.ts:219`, `adapter.ts:39`
- **Defect:** The first-byte timer disarms at headers; the buffered `res.json()` drain then has no
  adapter-level deadline — only undici's default 300s `bodyTimeout` backstops a stalled/trickling
  body, and `ProviderConfig.idleTimeoutMs` is declared but **read by no code** (dead config). A wedged
  provider holds requests ~5 minutes instead of the intended bound; the field silently lies.
- **Fix:** Keep the AbortController armed after headers; reset an idle timer (default =
  `firstByteTimeoutMs`) on each body chunk; abort → classify `unavailable` (trip-eligible,
  fallback-eligible). Wire `idleTimeoutMs` as the knob for both buffered and streaming inter-chunk
  gaps (coordinate with E1.4's config vars).
- **Acceptance criteria:** WHEN a provider sends headers then stalls the body THEN a buffered request
  fails with kind `unavailable` within the configured idle timeout and the breaker records the trip.
- **Verify:** jest test with a fake body stream that yields once then never resolves. `npm test -w packages/data-plane`.

**Related backlog:** A-10 (three breaker spec files import a nonexistent `./translate` module — one
assertion is vacuous; fix imports + add `tsc --noEmit` to CI), A-11 (production breaker wires no
`onError` — Redis-outage degradation invisible; pairs with E6.1's pattern), A-12 (Anthropic
`listModels` ignores pagination — catalogs truncate at the provider default page size).

---

<a id="epic-e5"></a>
## EPIC E5 — Cost-recording completeness & pricing coverage · P1 · ✅ SHIPPED 2026-07-17 (`fix-cost-recording-gaps`)

**Proposal slug:** `fix-cost-recording-gaps` ·
**Spec refs:** spec.md §7.5, §7.7, §8; `openspec/specs/{request-logging,pricing-catalog,cascade-routing}`; CLAUDE.md invariants 4, 12
**Why:** Invariant 4's machinery is correct, but rows can be silently lost at shutdown, one request
class writes no row at all, and several spec-§8 BYOK providers are structurally unpriceable — all of
which silently under-count the spend record that budgets and dashboards reconcile from.

### Task E5.1 — Make the shutdown flush actually drain the queue ✅ `[medium/S]`
- **Where:** `packages/control-plane/src/recording/log-writer.ts:149` (`flush` guard), `:132-135` (`onApplicationShutdown`)
- **Defect:** `flush()` early-returns when `this.flushing` is true, and timer flushes are un-awaited
  (`void this.flush()`). If any flush is in flight when SIGTERM lands (normal under steady traffic;
  the ~1.2s retry/backoff window widens the race), the shutdown flush **no-ops**: every draft enqueued
  after the in-flight splice — including the final rows from drained streams — is lost, **without
  incrementing `polyrouter_log_rows_dropped_total`** (violates request-logging "drops are never
  silent" + the observability spec).
- **Fix:** Retain the in-flight flush as a promise field; `flush()` awaits it then re-runs while either
  queue is non-empty; `onApplicationShutdown` loops until both queues drain (bounded by the existing
  retry policy).
- **Acceptance criteria:** WHEN a flush is mid-retry and shutdown begins THEN drafts enqueued after its
  splice are still written (or counted as dropped) before the process exits.
- **Verify:** unit test: deferred `insertMany`, call `flush()` (pending), enqueue another draft, call
  `onApplicationShutdown()`, resolve; assert a second `insertMany` carried the late draft.

### Task E5.2 — Record a RequestLog row when a client cancels during the cascade cheap leg ✅ `[medium/XS]`
- **Where:** `packages/control-plane/src/proxy/proxy.service.ts:369` (`cascadeCompletion`) and `:486` (`cascadeStream`)
- **Defect:** Both aborted branches `throw` without `recorder.record(...)`, while every non-cascade
  cancel path records `status='error'`. A cancelled cascade request **vanishes entirely** — invisible
  to the inspector and to spec-§7.5 completeness. (Note: the guard correctly distinguishes client
  abort from cheap-deadline timeout — only the client-disconnect branch is affected.)
- **Fix:** Before throwing, record one row exactly as the non-cascade cancel does (`status:'error'`,
  cheap meta at index 0, `escalated:false`, `outputChars:0`; do **not** call `notifyFailed` — client
  cancellations are not provider failures).
- **Acceptance criteria:** WHEN a client disconnects during the buffered cheap attempt THEN exactly one
  `request_log` row exists (`status='error'`) and no `request_attempt` rows / strong-tier calls.
- **Verify:** e2e in `cascade-routing.e2e-spec.ts`: destroy the client socket during the `oai-hang` cheap leg, flush the writer, assert the row.

### Task E5.3 — Map the missing spec-§8 BYOK host families (Qwen/MiniMax/Kimi/Z.ai) and extend the bundle ✅ `[medium/S]`
- **Where:** `packages/shared/src/server/pricing/resolve.ts:50-62` (`PROVIDER_FAMILY_HOSTS`), `:86-88`; `packages/control-plane/src/pricing/bundled-catalog.ts`
- **Defect:** No host mapping exists for dashscope (Qwen), MiniMax, Moonshot (Kimi), or Z.ai/Zhipu, so
  `deriveModelKey` returns null → the catalog is never consulted, a **manual override can never
  match**, and model-level prices are rejected for `api_key` kind (422) — those spec-§8 first-class
  BYOK providers record `cost=null` forever with no remediation short of re-creating the provider as
  `custom`. The bundled snapshot also ships no xai/cohere rows despite their hosts being mapped.
- **Fix:** Add the missing family hosts (aligned to LiteLLM `litellm_provider` values:
  `dashscope.aliyuncs.com`, `api.minimax.chat`, `api.moonshot.ai`/`.cn`, `open.bigmodel.cn`/`api.z.ai`)
  and representative bundled entries (at minimum xai/cohere) with a `BUNDLED_CATALOG_VERSION` bump.
- **Acceptance criteria:** WHEN a Qwen BYOK provider (`api_key`, dashscope base_url) serves `qwen-max`
  THEN `resolveForModel` returns a catalog snapshot (after seed or LiteLLM refresh) and the row records
  non-null cost; boot seed contains ≥1 row per §8 BYOK family.
- **Verify:** unit test on `resolveForModel` with dashscope URL; pricing-catalog e2e family assertion.

### Task E5.4 — Clear (or block) stale model-own prices when a provider's kind leaves custom/local ✅ `[medium/S]`
- **Where:** `packages/control-plane/src/providers/providers.service.ts:171-198` (`update`); `packages/shared/src/server/pricing/resolve.ts:98`
- **Defect:** Changing kind `custom → api_key` leaves user-set model prices in place; model-own price
  sits at the **top** of `resolveModelPrice` precedence, so a stale `$0` silently overrides the
  bundled catalog for a known provider from then on — and `updateModelPricing` then 422s any attempt
  to clear it (dead end). Historical rows are safe (snapshots); all *future* spend under-counts.
- **Fix:** In `ProvidersService.update`, when kind moves from custom/local to api_key/subscription,
  null out the provider's models' `inputPricePer1m`/`outputPricePer1m`/`isFree` in the same operation —
  or reject the kind change with 422 while user prices exist.
- **Acceptance criteria:** WHEN a custom provider with user-priced models is PATCHed to `api_key` THEN
  subsequent requests price from the catalog (`source ≠ 'model'`), and `GET /api/models` shows the
  prices cleared (or the PATCH is 422).
- **Verify:** e2e: create custom + price model + PATCH kind + assert price source.

**Related backlog:** A-13 (LiteLLM refresh skips `validate()` — one bad upstream entry aborts the whole
refresh; skip-and-log instead), A-14 (an orphaned cascade attempt FK-poisons its whole per-principal
attempt batch — fall back to per-row inserts), A-15 (cascade escalates on non-retryable `bad_request`
cheap failures — check `shouldFallback` before escalating), A-16 (weekly-spend reader sums raw float
instead of µ$ rounding — sub-cent inconsistency).

---

<a id="epic-e6"></a>
## EPIC E6 — Budget-enforcement operability · P1 · ✅ SHIPPED 2026-07-17 (`fix-budget-operability`)

**Proposal slug:** `fix-budget-operability` ·
**Spec refs:** spec.md §10; `openspec/specs/spend-limits`; CLAUDE.md invariant 10
**Why:** The enforcement design is race-free, but its degraded modes are invisible: under the default
fail-open, a broken enforcement path admits unlimited spend **with zero operator signal** — the spend-
limits design doc itself flagged the missing metric and it was never added.

### Task E6.1 — Log and count fail-open enforcement faults ✅ `[medium/S]`
- **Where:** `packages/control-plane/src/budgets/budget-service.ts:119-122` (`checkBlocked` bare catch); `packages/control-plane/src/observability/proxy-metrics.ts`
- **Defect:** Any enforcement fault (Redis fault/timeout, cold-cache DB failure, stale heartbeat,
  programming error) is swallowed → `null` (allow) with no Logger in the class and no budget metric in
  ProxyMetrics. A single instance with a broken budget connection skips enforcement for weeks,
  invisibly.
- **Fix:** In the catch: rate-limited/deduped `warn` naming the engaged fail mode + error class, and a
  counter (e.g. `polyrouter_budget_enforcement_faults_total{mode="open|closed"}`) via ProxyMetrics.
  Behavior (allow/deny) unchanged. Apply the same pattern to `spend-counter.ts:46`'s silent connect
  swallow.
- **Acceptance criteria:** WHEN the budget Redis connection fails under fail-open THEN the request is
  admitted AND a warn line + metric increment occur; `/metrics` exposes the fault counter.
- **Verify:** unit test in `budget-service.spec.ts` (failing mget + failOpen → logger/metric invoked).

### Task E6.2 — Add BullMQ retention to the budget-eval and weekly-summary schedulers ✅ `[medium/XS]`
- **Where:** `packages/control-plane/src/budgets/budget.scheduler.ts:209-213`; `packages/control-plane/src/producers/weekly-summary.scheduler.ts:129-133`
- **Defect:** Job templates pass no `removeOnComplete`/`removeOnFail`; BullMQ 5 keeps completed/failed
  jobs forever. The per-minute cron adds ~525k records/year to the same Redis holding spend counters
  and breaker state — until `maxmemory` eviction starts eating enforcement-critical keys. (The project
  already knows the fix: `notify.queue.ts` `BASE_JOB_OPTS`.)
- **Fix:** Mirror `BASE_JOB_OPTS` in both scheduler templates
  (`opts: { removeOnComplete: { age: 3600 }, removeOnFail: { age: 86400 } }`).
- **Acceptance criteria:** WHEN several occurrences run THEN `bull:budget-eval:completed` stays bounded.
- **Verify:** unit-assert template opts; optionally ZCARD after reconcile e2e.

### Task E6.3 — Give reconcile writes their own Redis timeout (not the 50ms hot-path bound) ✅ `[medium/S]`
- **Where:** `packages/control-plane/src/budgets/spend-counter.ts:40-44`; `budget.scheduler.ts:99/104/121`
- **Defect:** The scheduler's reconcile writes (Lua eval, markOnce, heartbeatSet) share the dedicated
  hot-path connection with `commandTimeout: 50ms`. Redis RTT near/above 50ms (managed Redis, AOF fsync
  stalls) makes every reconcile fail **before the heartbeat is stamped**; after `BUDGET_STALE_MS` all
  block budgets route through the fail mode — silently allowed by default (compounds E6.1) or
  spuriously 503'd under fail-closed.
- **Fix:** Give the scheduler its own connection (or reuse the worker-connection pattern) with a
  generous timeout (seconds); keep the 50ms fail-fast connection exclusively for the block-check read
  path and the fire-and-forget `markOnce` in `emitBlock`.
- **Acceptance criteria:** WHEN Redis commands take 100ms THEN `runBudgetOccurrence` completes and
  stamps the heartbeat while hot-path `read` still rejects within its 50ms bound.
- **Verify:** unit test with a delayed fake connection.

**Related backlog:** A-17 (no e2e asserts the Anthropic-shaped 402 or the cold-cache DB fail mode; no
`budget-cache.spec.ts` exists), A-18 (BUDGET_STALE_MS vs BUDGET_SCHED_CRON pair unvalidated — hourly
cron leaves enforcement "unavailable" 57 min/hour), A-19 (budget CRUD accepts foreign/garbage
`agentId`/`notifyChannelIds` — inert but silent).

---

<a id="epic-e7"></a>
## EPIC E7 — CI pipeline & invariant-12 test coverage · P1 · ✅ SHIPPED 2026-07-16 (`add-ci-and-drain-tests`)

**Proposal slug:** `add-ci-and-drain-tests` (test/infra-only change) ·
**Spec refs:** spec.md §15 (last bullet), §3.2; CLAUDE.md invariant 12 + Definition of done
**Why:** The Definition of done is enforced by convention only — no CI exists, so the one env-gated
suite pinning the breaker's Lua to the state machine **never runs**, and the two spec-mandated
streaming behaviors (drain, backpressure) have zero regression protection. This epic multiplies the
value of every other epic's verification.

### Task E7.1 — Add a GitHub Actions CI workflow ✅ `[medium/M]`
- **Where:** new `.github/workflows/ci.yml`
- **Defect:** No `.github/` at all. `breaker-redis.spec.ts` self-skips without `REDIS_URL` ("expected
  to run in CI") → invariant 10's Lua parity is never verified anywhere automated.
- **Fix:** Workflow on PR + push to main: `npm ci`, `npm run build`, `npm run lint`, per-package unit
  tests **with `REDIS_URL` set** (redis service container), plus a job with postgres:16 + redis:7
  services running `npm run test:e2e -w packages/control-plane`. Make the breaker-redis skip loud:
  fail when `process.env.CI` is set and `REDIS_URL` is missing. Add `tsc --noEmit` per package so
  spec-file import errors (Backlog A-10) surface.
- **Acceptance criteria:** CI run shows the `RedisBreakerStore against real Redis` suite **executed**;
  a PR breaking build/lint/tests cannot merge green.
- **Verify:** first CI run green; intentionally break an import in a spec file → CI fails.

### Task E7.2 — Add graceful-shutdown drain + slow-client backpressure + disconnect tests ✅ `[medium/M]`
- **Where:** `packages/control-plane/src/proxy/stream-drain.registry.ts` (no colocated spec), `proxy-http.ts:24/59/86`, `packages/control-plane/test/proxy/`
- **Defect:** Invariant 12 and two openspec inference-proxy scenarios ("in-flight streams drain on
  shutdown"; "a slow or disconnecting client backpressures the upstream") are implemented but asserted
  by **nothing** — supertest buffers whole responses so disconnect/backpressure never occur in the
  suite. E1.2's fix needs these tests to land safely.
- **Fix:** (a) unit spec for `StreamDrainRegistry` (register/complete lifecycle;
  `beforeApplicationShutdown` flips draining, waits for in-flight completions, aborts stragglers at
  the deadline); (b) e2e on a real listening port: during drain a new `/v1` request gets 503 while an
  in-flight stub stream runs to `[DONE]`; (c) raw-socket client aborts mid-stream → stub upstream sees
  teardown, breaker stays closed; (d) paused-socket client → write loop awaits drain (no unbounded
  buffering), and `app.close()` resolves within deadline+margin (pins E1.2).
- **Acceptance criteria:** removing `await drain(res)` or the registry gating fails a test.
- **Verify:** `npm run test:e2e -w packages/control-plane -- --testPathPattern proxy`.

### Task E7.3 — De-flake the e2e suite: remove `forceExit`, fix leaked handles ✅ `[low→medium/S]`
- **Where:** `packages/control-plane/jest-e2e.config.cjs:13`
- **Defect:** `forceExit: true` (comment admits BullMQ workers "keep the loop alive") guarantees
  leaked handles are never surfaced — the likely substrate of the known auth.e2e full-suite flake
  (shared DB truncation + wall-clock rate-limit TTLs + `--runInBand` interleaving).
- **Fix:** Run once with `--detectOpenHandles` and `forceExit` off; close each surfaced leak (await
  `worker.close()` before `app.close()` in queue-owning suites); give the auth rate-limit tests a
  unique key prefix or injected clock so wall-clock TTLs stop mattering; keep `forceExit` off.
- **Acceptance criteria:** full e2e passes repeatedly (≥5 consecutive runs) without `forceExit`.
- **Verify:** loop `npm run test:e2e -w packages/control-plane` 5×.

---

<a id="epic-e8"></a>
## EPIC E8 — OSS launch readiness: LICENSE & operator docs · P1 · ✅ SHIPPED 2026-07-17 (`docs-oss-launch`)

**Proposal slug:** `docs-oss-launch` (docs-only; still an OpenSpec change per CLAUDE.md sync rule) ·
**Spec refs:** spec.md §12, §15 (first criterion), §16; `openspec/specs/packaging` docs requirement
**Why:** The repo is a self-described open-source router with **no license grant** (legal blocker for
any adopter), no documentation of how to actually use the product, and a reference spec whose
config section contradicts the code by ~38 variables.

### Task E8.1 — Add the LICENSE file ✅ `[high/XS]`
- **Defect:** README:126 says "MIT licensed." and root package.json declares `"license": "MIT"`, but no
  LICENSE/COPYING exists anywhere — no actual grant; forks/adopters are technically infringing;
  spec.md line 21 lists "MIT-style license" as a project goal.
- **Fix:** Add standard MIT text as `/LICENSE` (correct holder + year); add `"license": "MIT"` to the
  four workspace package.json files.
- **Verify:** `test -f LICENSE && head -1 LICENSE | grep -qi 'MIT License'`.

### Task E8.2 — Add a "Connect an agent" section to the README ✅ `[medium/S]`
- **Defect:** README covers install + development only — zero mentions of `/v1/chat/completions`,
  `/v1/messages`, `/v1/models`, the `poly_` key prefix, `x-polyrouter-tier`, or model `auto`. The
  product's core pitch (spec §15 first criterion) is undiscoverable.
- **Fix:** Short section after Self-hosting: `base_url = <instance>/v1`, key from the dashboard
  (`poly_…`), `model` = explicit | `auto` | tier via `x-polyrouter-tier`, one curl example per
  protocol.
- **Verify:** `grep -q 'x-polyrouter-tier' README.md && grep -q '/v1/chat/completions' README.md`.

### Task E8.3 — Refresh spec.md §12 from the config registry (~38 missing vars) ✅ `[medium/S]`
- **Defect:** The registry defines 53 env vars; §12 lists ~15. Missing entirely: the required-in-prod
  `PROVIDER_CREDENTIAL_KEY`, all `BUDGET_*` (incl. security-relevant `BUDGET_FAIL_OPEN`),
  `OTEL_*`/`METRICS_ENABLED`, `PRICING_*`, `TRUSTED_PROXY_CIDRS`, `ROUTING_STRUCTURAL_*/CASCADE_*`,
  `NOTIFY_*`, `BETTER_AUTH_URL`, `DASHBOARD_ORIGIN`. CLAUDE.md makes spec.md the reference that "wins"
  — it currently loses to the code.
- **Fix:** Regenerate §12 grouped by namespace from the `registerConfig` call sites; mark
  required-in-production secrets; note loopback-dev fallbacks; fix the stale
  `ROUTING_AUTO_LAYERS=explicit,structural` example (code default is `structural`).
- **Verify:** `grep -q PROVIDER_CREDENTIAL_KEY spec.md && grep -q BUDGET_FAIL_OPEN spec.md`.

### Task E8.4 — Document operator-facing tunables in the README .env reference ✅ `[medium/S]`
- **Defect:** ~24 compose-passthrough vars are documented only in source comments. Three with sharp
  edges: `SMTP_*` (without it, password reset silently never sends), `BUDGET_FAIL_OPEN` (**default
  true** — block budgets admit requests during Redis faults; operators wanting hard caps must be told
  to flip it), `ROUTING_AUTO_LAYERS` (cascade — a spec §14.7 headline feature — is OFF until
  `structural,cascade` is set; the dashboard toggle just shows it greyed out).
- **Fix:** Extend the README .env table (or `docs/configuration.md`): `SMTP_*`, `BUDGET_FAIL_OPEN`
  (with the fail-open warning), `ROUTING_AUTO_LAYERS` + cascade enablement, `TRUSTED_PROXY_CIDRS`,
  `PRICING_REFRESH_URL`, `NOTIFY_APPRISE_EGRESS_CONFIRMED`, `POLYROUTER_SUBNET/IMAGE`, plus E1.4's new
  timeout vars.
- **Verify:** `grep -q SMTP_HOST README.md && grep -q BUDGET_FAIL_OPEN README.md`.

### Task E8.5 — Pass the missing registered env vars through docker-compose ✅ `[medium/XS]`
- **Where:** `docker-compose.yml:44-75` (`services.app.environment` allowlist)
- **Defect:** The explicit allowlist omits registered, code-honored vars — `NOTIFY_WEEKLY_ENABLED`/
  `NOTIFY_WEEKLY_CRON`, `NOTIFY_FAILURE_THRESHOLD`/`_WINDOW_MS`, `BUDGET_SCHED_ENABLED`,
  `BUDGET_REDIS_TIMEOUT_MS`, `BUDGET_CACHE_*`, `BUDGET_STALE_MS`, `PRICING_FETCH_TIMEOUT_MS`,
  `PRICING_MAX_BYTES`. Setting them in `.env` (the documented mechanism) **does nothing** in the
  packaged distribution — e.g. the spec-§10.1 weekly spend summary is unreachable, and compose edits
  are reverted by install.sh upgrades.
- **Fix:** Append the missing keys as bare pass-through entries in the optional block.
- **Verify:** with `NOTIFY_WEEKLY_ENABLED=true` in `.env`, `docker compose -p polyrouter-selfhost config` renders it on the app service.

**Related backlog:** A-20 (SECURITY.md + CONTRIBUTING.md absent), A-21 (root package.json lacks
`repository`; OWNER placeholder sweep before publication), A-22 (README expose/upgrade compose
commands fail for fetch-mode installs — add `-f src/docker-compose.yml --env-file ./.env` forms),
A-23 (changeset bump inconsistencies; README db:generate note), A-24 (archived tenant-isolation and
routing-config specs drift from code — small spec-sync change).

---

<a id="epic-e9"></a>
## EPIC E9 — Auth plane & rate-limit hardening · P2 · ✅ SHIPPED 2026-07-17 (`harden-auth-plane`)

**Proposal slug:** `harden-auth-plane` ·
**Spec refs:** `openspec/specs/{session-auth,agent-keys}`; CLAUDE.md invariants 5, 7
**Why:** Neither is a live data-exposure hole today (compensated by `@CurrentPrincipal` throwing), but
both weaken defenses the spec mandates and one is an auth-plane DoS.

### Task E9.1 — Make client-IP CIDR matching IPv6-aware ✅ `[medium/S]`
- **Where:** `packages/control-plane/src/auth/client-ip.ts:8` (`ipInCidr`); `auth.config.ts:27` (`TRUSTED_PROXY_CIDRS`, unvalidated)
- **Defect:** `ipInCidr` short-circuits false for any non-IPv4 peer or CIDR, so behind an
  IPv6-connecting proxy (dual-stack cloud ingress, pod-to-pod v6) `X-Forwarded-For` is discarded and
  `clientIp` returns the single proxy address for **every** request → all clients share one rate-limit
  bucket. 10 sign-in attempts/min then lock out **everyone** — an auth-plane DoS, and per-client
  brute-force isolation is lost. `TRUSTED_PROXY_CIDRS` also accepts an IPv6 CIDR silently (never matches).
- **Fix:** Extend `ipInCidr` to handle IPv6 and IPv4-mapped ranges (keep the `::ffff:` normalization);
  validate configured CIDRs at boot.
- **Acceptance criteria:** WHEN two clients arrive via an IPv6 proxy with a v6 `TRUSTED_PROXY_CIDRS`
  THEN each gets a distinct bucket from its `X-Forwarded-For` address.
- **Verify:** new `client-ip` unit test (none exists yet): `clientIp({peer:'fd00::1', xff:'2001:db8::5'}, ['fd00::/8'])` → `'2001:db8::5'`.

### Task E9.2 — Make the /api plane check case-insensitive ✅ `[medium/XS]`
- **Where:** `packages/control-plane/src/auth/session.guard.ts:48`; also `mount.ts`, `rate-limit.middleware.ts`
- **Defect:** Plane scoping is `req.path.startsWith('/api')` (case-sensitive), but Express routes
  case-insensitively (no override set) → `GET /API/agents` matches the controller but **skips the
  global SessionGuard**. Saved today only by `@CurrentPrincipal` throwing (500, not data leak), but the
  invariant rides on a fragile prefix: any future `/api` handler reading the principal optionally would
  serve unauthenticated. Auth-route throttling and Better Auth interception share the flaw.
- **Fix:** Normalize with `req.path.toLowerCase().startsWith('/api')` in all three sites (or enable
  case-sensitive routing on the Express adapter).
- **Acceptance criteria:** WHEN `GET /API/agents` is requested without a session THEN it returns 401,
  and `/API/auth/sign-in/email` is throttled/intercepted identically to lowercase.
- **Verify:** e2e uppercase-path cases.

---

<a id="epic-e10"></a>
## EPIC E10 — Routing-config robustness & structural baseline · P2 · ✅ SHIPPED 2026-07-17 (`fix-routing-config-edges`)

**Proposal slug:** `fix-routing-config-edges` ·
**Spec refs:** spec.md §7.1/§7.2/§7.4; `openspec/specs/{routing-config,structural-routing}`; CLAUDE.md invariants 1, 5
**Why:** Precedence and degradation are airtight; these are edge defects that produce 500s, brick a
usable tier, or silently disable shared learning. (The cascade client-cancel record gap is a recording
defect — it is Task E5.2, not here.)

### Task E10.1 — Reject explicit JSON nulls in rule create/PATCH (currently 500s) ✅ `[medium/XS]`
- **Where:** `packages/control-plane/src/routing-config/routing-config.service.ts:265` (`updateRule`); `routing-config.dto.ts` (`UpdateRuleDto`/`CreateRuleDto`)
- **Defect:** `@IsOptional()` skips validators for `null` (not just `undefined`), and the
  ValidationPipe doesn't strip nulls. So `{target:null}` → `parseRoutingTarget(null)` TypeError → 500;
  `{priority:null}`/`{matchType:null}` → Postgres NOT NULL violation → 500; `{headerName:null}` →
  silently rewrites the rule to match `x-polyrouter-tier`. The spec requires invalid PATCHes rejected
  with 4xx and constraint failures surfaced, not 500.
- **Fix:** Replace `@IsOptional()` with `@ValidateIf((_, v) => v !== undefined)` on
  target/priority/matchType/headerName (or normalize null→undefined before merge) on both DTOs; keep
  `headerValue` null-as-clear only if intended and make it explicit.
- **Acceptance criteria:** WHEN a rule PATCH/POST sends null for those fields THEN the response is 4xx
  and the stored rule is unchanged.
- **Verify:** e2e null-PATCH cases in `routing-config.e2e-spec.ts`.

### Task E10.2 — Stop a cascade-deleted position-0 model from bricking a tier with healthy fallbacks ✅ `[medium/S]`
- **Where:** `packages/data-plane/src/routing/resolve.ts:123` (`resolveTier`); provider/model delete transaction in `packages/control-plane/src/database/port.ts`
- **Defect:** `replaceForTier` writes contiguous positions, but provider deletion cascades
  `routing_entries` (blessed by the provider-mgmt spec) and nothing re-compacts. `resolveTier` requires
  `position === 0` exactly, so deleting the primary's provider makes a tier that still has healthy
  models at 1..N return `empty_tier` → every request 400s until manual re-save. Contradicts §7.4's
  chain promise, and the error name is misleading. (The hard-fail is unit-tested at `resolve.spec.ts:213`,
  so prefer fixing at the delete transaction to avoid relitigating the resolver's no-silent-promotion stance.)
- **Fix (cleaner S):** compact positions inside the provider/model delete transaction so the invariant
  the config layer owns (contiguous positions) survives the cascade.
- **Acceptance criteria:** WHEN the provider owning a tier's position-0 model is deleted THEN the
  surviving next model serves; a genuinely empty tier still reports `empty_tier`.
- **Verify:** e2e — 2-model cross-provider chain, delete the position-0 provider, POST to the tier, assert the survivor serves.

### Task E10.3 — Evict (or coarsen) the structural baseline fingerprint hash instead of saturating ✅ `[medium/M]`
- **Where:** `packages/control-plane/src/proxy/structural/structural-baseline.store.ts:37` (`EWMA_LUA`)
- **Defect:** The per-agent baseline hash caps at 32 fields and, when full, **rejects new fields while
  refreshing the whole-hash TTL** (no per-field eviction). Harnesses commonly interpolate dynamic
  values (timestamp, cwd, session id) into the system prompt → a new fingerprint per request → 32
  requests permanently fill the hash and the TTL never lapses, so the shared (cross-instance,
  restart-surviving) baseline can never learn legitimate boilerplate again — silently defeating §7.2's
  de-contamination goal. Each unique fingerprint also churns the process-wide 10k LRU, evicting other
  tenants' warm baselines. (Degrades safely → fails silently.)
- **Fix:** Either evict the stale field at cap (parallel per-agent ZSET of field→last-touch, ZPOPMIN +
  HDEL before HSET, still one atomic script) to protect agents with rotating stable fingerprints; **or**
  cap the canonical fingerprint to a structure-only digest (block types + length buckets) so trivial
  interpolations collapse to one fingerprint (this also fixes the fully-dynamic-prompt agent). Apply the
  same rule in the Lua and the local cache.
- **Acceptance criteria:** WHEN an agent produces 33+ distinct canonical systems THEN a later repeated
  fingerprint is still learned into Redis and cold-seeds on a second store instance.
- **Verify:** unit/e2e filling the hash then asserting a repeated fingerprint persists.

**Related backlog:** A-21 (cascade escalates on non-retryable `bad_request` cheap failures),
A-22 (seeded `oai-miderror` cascade fixture never asserted), A-23 (EWMA seeds full value from first
observation — outlier-sensitive), A-24 (routing-config archived spec contradicts code on `match_type`),
A-25 (no test for a rule target naming another tenant's model), A-44 (PATCH can't clear nullable fields).

---

<a id="epic-e11"></a>
## EPIC E11 — Provider-management input bounds · P2 · ✅ SHIPPED 2026-07-17 (`bound-provider-sync`)

**Proposal slug:** `bound-provider-sync` ·
**Spec refs:** CLAUDE.md invariant 6 (server-fetched user URLs); `openspec/specs/provider-management`
**Why:** A base_url only has to pass the SSRF *address* check — a hostile-but-public endpoint is
allowed by design (no allow-list), so the server willingly drains whatever it sends.

### Task E11.1 — Bound sync-models/test-connection response size and synced-model count/field length ✅ `[medium/S]`
- **Where:** `packages/data-plane/src/providers/http.ts:56` (`drainText`, unbounded); `packages/control-plane/src/providers/providers.service.ts:237` (`syncModels` loop)
- **Defect:** `drainText` accumulates the response body with no byte cap; `parseModelList` accepts an
  unbounded array with unbounded id/name lengths; `syncModels` upserts every entry with no count/length
  cap into unbounded text columns. A custom provider pointed at an endpoint returning a multi-GB or
  endless body exhausts control-plane memory (taking down the instance for all tenants); a 5M-entry
  response floods the models table.
- **Fix:** Enforce a max-bytes cap (~5–10MB) in `drainText`/`json()` on the non-streaming paths (throw
  `ProviderError('bad_request')` on overflow); cap the deduped model set (e.g. 2,000) and skip/truncate
  `externalModelId`/`displayName` beyond ~512 chars before upserting.
- **Acceptance criteria:** WHEN an endpoint returns a body over the cap THEN `listModels`/`testConnection`
  reject with a typed `ProviderError` and memory stays bounded; WHEN it returns 10k models THEN
  `syncModels` caps the count and rejects oversized ids without a partial DB flood.
- **Verify:** unit test streaming > cap bytes; service test with 10k models / 1MB id.

**Related backlog:** A-42 (`IsUrl` `require_tld` rejects `http://localhost:11434` — the canonical Ollama URL).

---

<a id="epic-e12"></a>
## EPIC E12 — Dashboard correctness · P2 · ✅ SHIPPED 2026-07-17 (`fix-dashboard-correctness`)

**Proposal slug:** `fix-dashboard-correctness` ·
**Spec refs:** `openspec/specs/{dashboard-core,dashboard-config,dashboard-prototype}`; spec.md §2, §9
**Why:** The SPA's key handling and XSS posture are exemplary; these four are correctness/UX defects
that lose a shown-once key, strand an expired session, wipe routing config, or copy a wrong endpoint.

### Task E12.1 — Route mid-session 401s back to the login gate ✅ `[medium/S]`
- **Where:** `packages/frontend/src/state/appState.ts:274` (`errMessage`); the only 401 branch is `bootstrap()` at `:1028`
- **Defect:** 401 is handled only during bootstrap. After `authView==='ready'`, loaders/mutations
  funnel through `errMessage` (status discarded) → a cloud user whose session expires is stuck in a
  shell where every action fails with an unexplained "Unauthorized" and the 15s poll paints a permanent
  red banner whose Retry can never succeed.
- **Fix:** In the shared error path, when `isApiError(e) && e.status===401 && state.authView==='ready'`,
  call `void bootstrap()` (re-probes `/api/me`, flips to `gate`); keep the toast for context.
- **Acceptance criteria:** WHEN a loader/mutation gets 401 after ready THEN `authView` becomes `gate`.
- **Verify:** Vitest — session-set store, force `ApiError(401)` on a loader, assert `authView==='gate'`.

### Task E12.2 — Stop `copy()` from toasting success when the clipboard write failed ✅ `[medium/XS]`
- **Where:** `packages/frontend/src/state/appState.ts:613` (`copy`)
- **Defect:** `copy()` fires `navigator.clipboard.writeText(txt).catch(()=>undefined)` and
  **unconditionally** toasts "Copied"/"Key copied". On a non-secure origin (self-host over plain http
  on a LAN IP — very common) `navigator.clipboard` is undefined; the user sees "Key copied", clicks
  Done (which wipes `kr`), and the shown-once key is gone — forcing a rotate. Affects the agents modal
  and the onboarding key reveal (`Setup.tsx:129`).
- **Fix:** Make `copy()` async; await `writeText`; on failure/missing API, toast a distinct
  "Copy failed — select the text manually" (don't claim success); keep the reveal modal open until a
  successful copy or explicit Done.
- **Acceptance criteria:** WHEN the clipboard API is absent or rejects THEN the toast is a failure
  message, not "Key copied".
- **Verify:** Vitest stubbing `navigator.clipboard` undefined and rejecting.

### Task E12.3 — Derive the displayed/copied endpoint from runtime origin, not a hardcoded dev URL ✅ `[medium/XS]`
- **Where:** `packages/frontend/src/data/catalog.ts:4` (`BASE_URL`); consumers `Topbar.tsx:35`, `Settings.tsx:64/69`, `Agents.tsx:35`, `Sidebar.tsx:127`, `appState.ts:239` (`snippetFor`)
- **Defect:** `BASE_URL = 'http://127.0.0.1:3001/v1'` is a build-time constant used by the endpoint
  chip, Settings "Endpoint", the Agents instructions, and the sidebar footer. The server-minted
  snippets correctly derive from `BETTER_AUTH_URL`, so any instance behind `APP_URL`/a non-default host
  **displays and copies a wrong endpoint that contradicts the snippet beside it**.
- **Fix:** Derive at runtime: `${globalThis.location.origin}/v1` (same-origin serving makes this correct
  in prod), or return the canonical base from `/api/me`/login-config; fix the `Sidebar.tsx:127` literal
  and the `snippetFor` fallback too.
- **Acceptance criteria:** WHEN the instance is served from a non-default origin THEN the displayed/copied
  endpoint matches that origin and the key-reveal snippet.
- **Verify:** run Vite dev at :3000 (or deploy with `APP_URL` set); confirm Settings endpoint matches origin.

### Task E12.4 — Stop the setup guide from wiping an existing default-tier chain ✅ `[medium/S]`
- **Where:** `packages/frontend/src/state/appState.ts:1688` (`obConnectProvider`)
- **Defect:** `obConnectProvider` unconditionally calls `replaceTierEntries(def.id, [first.id])` — an
  atomic full replace. The Setup guide card is permanently visible for every user, so someone who
  already configured `default = [primary, …fallbacks]` and later walks the guide to add a provider gets
  their whole chain replaced by a single model, no warning — silent routing-config loss.
- **Fix:** Read the default tier's entries first; only replace when empty, otherwise append/prepend
  (respecting the 5-cap) or show a confirm. The fresh-instance onboarding scenario stays satisfied.
- **Acceptance criteria:** WHEN the default tier already has entries THEN running the guide does not
  replace them with a single-element chain.
- **Verify:** Vitest — seed a 2-entry default, run `obConnectProvider`, assert existing modelIds preserved.

**Related backlog:** A-26 (onboarding step-2 retry mints duplicate providers), A-27 (create/add
mutations lack the double-submit guard budgets/channels have), A-28 (body-logging toggle is an inert
no-op), A-29 (Agents page shows placeholder dashes + stale copy though the data source now exists),
A-30 (hardcoded `v0.4.1`/fabricated instance info), A-31 (timeseries gaps interpolated — zero-fill).

---

<a id="epic-e13"></a>
## EPIC E13 — Installer idempotency · P2 · ✅ SHIPPED 2026-07-17 (`fix-installer-rerun`)

**Proposal slug:** `fix-installer-rerun` ·
**Spec refs:** `openspec/specs/packaging` (".env is NEVER overwritten or rotated"); CLAUDE.md invariant 12
**Why:** A plausible operator upgrade action silently rotates a live stack's secrets → outage.

### Task E13.1 — Detect a prior fetch-mode install so a re-run reuses the existing .env ✅ `[medium/XS]`
- **Where:** `install.sh:38` (locate-or-fetch branch)
- **Defect:** The prior-install check only recognizes a working tree
  (`docker-compose.yml && Dockerfile && package.json` at cwd). A fetch install creates
  `polyrouter/{src/,.env}` (compose is under `src/`), so re-running the one-liner from inside that dir
  falls into the fetch branch, nests `polyrouter/polyrouter/`, finds no `.env`, and **generates new
  secrets** — then boots compose under the same fixed project `polyrouter-selfhost` against the existing
  volumes. New `POSTGRES_PASSWORD` (init-only → app can't auth, crash-loop) and rotated
  `PROVIDER_CREDENTIAL_KEY` (orphans every stored credential). Defeats the spec's idempotency guarantee.
- **Fix:** In the locate step, also treat a prior fetch install at cwd as the root:
  `elif [ -f src/docker-compose.yml ] && [ -f .env ]; then SRC=src; ENV_FILE=./.env` (skip
  `mkdir`/`cd`), reusing the existing `.env` and refreshing `src/` instead of nesting.
- **Acceptance criteria:** WHEN `install.sh` is re-run from inside a fetch-installed `polyrouter/` THEN
  no nested `polyrouter/polyrouter/` is created and `.env` is byte-identical.
- **Verify:** manual — fetch-install, re-run from the install dir, assert `.env` unchanged and no nesting.

**Related backlog:** A-19 (README expose/upgrade compose commands omit `-f/--env-file` for fetch installs).

---

<a id="epic-e14"></a>
## EPIC E14 — Notifications hardening · P3 · ✅ SHIPPED 2026-07-17 (`harden-notifications`)

**Proposal slug:** `harden-notifications` ·
**Spec refs:** `openspec/specs/{notification-channels,notification-producers}`; CLAUDE.md invariants 6, 11
**Why:** The surface is strong; these two close a spec-mandated test gap and an abuse vector.

### Task E14.1 — Add a test for `deliverSmtp`'s connect-time SSRF refusal ✅ `[medium/S]`
- **Where:** `packages/control-plane/src/notifications/delivery/smtp.adapter.ts:19` (`deliverSmtp`) — no colocated spec
- **Defect:** The spec requires the SMTP host validated at connect time (connect to the pinned validated
  IP) with the scenario "a host resolving to a blocked address is refused, logged without
  host/recipient/token." Implemented, but **no test executes it** (`system-mailer.spec.ts` mocks the
  adapter; the channels e2e uses reachable loopback). A refactor dropping `assertNetworkHostSafe` or the
  IP pinning stays green while a cloud tenant could rebind DNS to `169.254.169.254`.
- **Fix:** Add `smtp.adapter.spec.ts`: call `deliverSmtp` with host `169.254.169.254` (literal, no DNS)
  in both modes, assert rejection with `smtp_host_blocked` before any socket; add a loopback-stub case
  pinning `host: ip` to lock the rebind defense.
- **Acceptance criteria:** removing the SSRF assertion or IP pinning fails the new test.
- **Verify:** `npm test -w packages/control-plane -- smtp.adapter`.

### Task E14.2 — Rate-limit the per-channel test-send endpoint ✅ `[medium/S]`
- **Where:** `packages/control-plane/src/notifications/channels.controller.ts:48` (`POST /:id/test`)
- **Defect:** The test-send route is session-guarded and tenant-scoped but **unthrottled**
  (`AuthRateLimitMiddleware` only matches Better Auth routes). Each call drives a real SMTP session or
  Apprise POST (15s timeout) + live DNS. An authenticated user (or stolen session) can loop it to spam
  arbitrary recipients through the configured SMTP, hammer the Apprise sidecar, or tie up connections.
- **Fix:** Apply the existing Redis window limiter (`auth/rate-limit.ts`) keyed per user (a few
  test-sends/minute) on the test route, or a short `markOnce` TTL per channel.
- **Acceptance criteria:** WHEN a user exceeds N test-sends/minute THEN further calls return 429.
- **Verify:** e2e loop asserting a 429 after the threshold.

**Related backlog:** A-32 (weekly-summary job single-attempt despite idempotent design), A-33 (validate
`APPRISE_API_URL` at boot with the send-time `assertUrlSafe` policy), A-34 (channel config update
doesn't clear `lastTestStatus`).

---

<a id="epic-e15"></a>
## EPIC E15 — Observability accuracy · P3 · ✅ SHIPPED 2026-07-17 (`fix-metrics-buckets`)

**Proposal slug:** `fix-metrics-buckets` ·
**Spec refs:** `openspec/specs/observability`; spec.md §3.2
**Why:** Attribute hygiene and exactly-once cost metrics are correct; the histogram buckets make the
latency metrics useless for the exact traffic the product routes. (The observability auditor also
reported the shutdown-flush defect — it is the same root cause as Task E5.1; fix once.)

### Task E15.1 — Set explicit LLM-scale buckets on the duration histograms ✅ `[medium/XS]`
- **Where:** `packages/control-plane/src/observability/proxy-metrics.ts:36` (`requestDuration`), `:60` (`upstreamDuration`)
- **Defect:** Both histograms are built with no `buckets`, so prom-client's defaults apply (max finite
  bucket **10s**). Streamed LLM completions run 10s–minutes → every such observation lands in `+Inf`, so
  `histogram_quantile` reports ~10s for all real traffic and per-provider latency comparison above 10s
  is impossible — defeating the metric's purpose.
- **Fix:** Pass explicit buckets, e.g. `[0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600]`, to both.
- **Acceptance criteria:** WHEN a 90s request is observed THEN it lands in a finite bucket (`le="120"`),
  not only `+Inf`.
- **Verify:** `proxy-metrics.spec.ts` asserts `le="60"`/`le="300"` lines and a >10s observation increments a finite bucket.

### Task E15.2 — Cover the enabled tracing path & unreachable-collector scenario ✅ `[medium/S]`
- **Where:** `packages/control-plane/src/observability/tracing.ts:23` (`initTracing`)
- **Defect:** The openspec scenario "an unreachable collector does not affect requests" has no test, and
  `initTracing`/`shutdownTracing` (the `OTEL_ENABLED` gate, OTLP exporter, BatchSpanProcessor) are never
  executed by any test (every suite registers its own in-memory provider). A regression in the
  production tracing switch ships undetected.
- **Fix:** Add a spec that sets `OTEL_ENABLED=true` with `OTEL_EXPORTER_OTLP_ENDPOINT` at a closed local
  port, calls `initTracing`, drives a request, asserts outcome+latency unaffected and `shutdownTracing()`
  resolves; assert `initTracing` is a no-op when `OTEL_ENABLED` is unset.
- **Acceptance criteria:** the new spec fails if `initTracing` throws, blocks, or fails to register/flush.
- **Verify:** `npm run test:e2e -w packages/control-plane -- --testPathPattern observability`.

**Related backlog:** A-35 (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` per-signal var unregistered),
A-36 (breaker-state/upstream gauges labeled by provider display name → stale series on rename),
A-37 (`upstream_duration` has no outcome label → client-abort durations pollute latency).

---

## Appendix A — Backlog (low/info; no epic)

These are polish, defense-in-depth, or documentation nits — real but individually below the bar for a
change proposal. Batch opportunistically when touching the neighboring code.

| ID | Area | Item | File |
|---|---|---|---|
| A-1 | build | `format:check` fails on 2 Drizzle-generated JSON files — add to `.prettierignore` | `migrations/meta/*` |
| A-2 | deps | 5 moderate `npm audit` advisories via `better-auth → drizzle-kit` — bump when upstream allows | root |
| A-3 | proxy | Client aborts recorded `status='error'` + fire `notifyFailed` → inflate error rate / spike alerts | `proxy.service.ts:246` |
| A-4 | proxy | Buffered upstream call has no post-headers deadline beyond undici's 300s (see E4.3) | `core.ts:95` |
| A-5 | proxy | Anthropic-wire terminal error frame/envelope untested (folded into E2.6) | `stream-error.ts:19` |
| A-6 | translate | Duplicate `tool_use_start` on repeated id/name argument fragments | `openai.ts:420` |
| A-7 | translate | Uninvited trailing usage chunk sent to OpenAI clients that didn't opt in | `openai.ts:536` |
| A-8 | translate | User-message `[text, tool_result]` order inverted (text emitted after) | `anthropic.ts:170` |
| A-9 | translate | `message_start` fabricates `input_tokens:0` cross-protocol — document in golden README | `anthropic.ts:450` |
| A-10 | breaker | Production breaker wires no `onError` → Redis-outage degradation silent | `proxy.module.ts:92` |
| A-11 | breaker | 3 breaker spec files import a nonexistent `./translate` + phantom export (E7.1 `tsc` catches) | `breaker-*.spec.ts` |
| A-12 | adapters | Anthropic `listModels` ignores pagination → catalogs truncate at page size | `anthropic-adapter.ts:23` |
| A-13 | pricing | LiteLLM refresh skips `validate()` → one negative price aborts the whole refresh | `pricing.service.ts:205` |
| A-14 | recording | Orphaned cascade attempt FK-poisons its per-principal batch (drops valid rows) | `log-writer.ts:267` |
| A-15 | analytics | `weekly-spend.reader` sums raw float, diverges sub-µ$ from µ$-rounded readers | `weekly-spend.reader.ts` |
| A-16 | budgets | `BUDGET_STALE_MS` vs cron interval unvalidated (hourly cron → ~57min unavailable) | `budgets.config.ts` |
| A-17 | budgets | No test for Anthropic-shaped budget rejection or cold-cache DB fail mode; no `budget-cache.spec.ts` | `test/budgets/` |
| A-18 | docs | Add `SECURITY.md` (disclosure route) + `CONTRIBUTING.md` | root |
| A-19 ✅ | docs | README expose/upgrade compose commands omit `-f/--env-file` for fetch installs → fixed in E13 (`fix-installer-rerun`) | `README.md:45` |
| A-20 | docs | Sub-package `package.json` lack `license`; root lacks `repository` | `packages/*/package.json` |
| A-21 | routing | Cascade escalates on non-retryable `bad_request` cheap failure | `proxy.service.ts:370` |
| A-22 | routing | Seeded `oai-miderror` cascade fixture never asserted (post-commit terminal error) | `cascade-routing.e2e-spec.ts:223` |
| A-23 | routing | EWMA seeds full value from first observation — single-outlier sensitive | `structural-baseline.store.ts:111` |
| A-24 | routing | Archived routing-config spec contradicts code on `match_type` (missing auto_high/low) | `openspec/specs/routing-config/spec.md:83` |
| A-25 | routing | No test asserts a rule target naming another tenant's model is rejected | `test/routing/routing-config.e2e-spec.ts:190` |
| A-26 | frontend | Onboarding step-2 retry mints a duplicate provider each attempt | `appState.ts:1654` |
| A-27 | frontend | create/add mutations lack the single-flight guard budgets/channels have | `appState.ts:1135` |
| A-28 | frontend | Body-logging toggle is an inert client-only no-op (resets on reload) | `Settings.tsx:101` |
| A-29 | frontend | Agents page shows placeholder dashes + stale "arrives with analytics" copy | `Agents.tsx:108` |
| A-30 | frontend | Hardcoded `v0.4.1 · postgres 16 · redis 7` / fabricated instance info | `appState.ts`,`Settings.tsx` |
| A-31 | frontend | Timeseries gaps interpolated by uPlot — zero-fill client-side | `data/analytics.ts` |
| A-32 | notify | Weekly-summary job runs single-attempt despite idempotent occurrence design | `weekly-summary.scheduler.ts:130` |
| A-33 | notify | Validate `APPRISE_API_URL` at boot with send-time `assertUrlSafe` policy | `notify.config.ts:100` |
| A-34 | notify | Channel config update doesn't clear `lastTestStatus` — stale "success" | `channels.service.ts` |
| A-35 | observ | `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` per-signal var unregistered | `observability.config.ts` |
| A-36 | observ | breaker-state/upstream gauges labeled by provider display name → stale series on rename | `proxy-metrics.ts` |
| A-37 | observ | `upstream_duration` has no outcome label → client-abort durations pollute latency | `proxy-metrics.ts` |
| A-38 | db | Money columns are `double precision` (mitigated by µ$ rounding) — `numeric` would remove the class | `schema.ts` |
| A-39 | db | Boot migrations take no advisory lock (documented single-replica constraint) | `migrations-runner.ts` |
| A-40 | security | GCM auth tag length not pinned to 16 bytes on decrypt (defense-in-depth) | `encryption.ts:49` |
| A-41 | security | Allowlist HARD-overlap guard checks only CIDR network address; skipped on notification host path | `ssrf.ts:183` |
| A-42 ✅ | provider-mgmt | `IsUrl` `require_tld` rejects `http://localhost:11434` (Ollama) with a misleading 400 → fixed in E11 (`bound-provider-sync`) | `providers.dto.ts:19` |
| A-43 | foundation | Redis client attaches no `error` listener → noisy `[ioredis] Unhandled error` on outage | `redis.module.ts` |
| A-44 | routing-config | PATCH can't clear nullable fields (`@IsString` rejects null on displayName/description) | `routing-config.dto.ts` |
| A-45 | dx | Duplicated comparators/formulas (`ruleOrder`, effective-auto-layers) risk drift — share one impl | `routing-config.service.ts:224`, `auto-layers.service.ts:51` |

## Appendix B — Coverage & confidence

- **Files read:** 521 (union across auditors) covering all 231 source files. Unread files were manually
  inspected and are trivial: `data-plane.module.ts` (empty placeholder module), `drizzle.config.ts`
  (dev-only migration-generation config), `recording/index.ts` (re-export barrel), `styles.css`,
  `frontend/src/test/fakeClient.ts` (test double), `nest-cli.json`. None warrant findings.
- **Verification:** every medium+ finding faced ≥1 adversarial refutation agent reading the cited code;
  critical/high faced a second spec-alignment lens. No finding survived as *contested* (all confirmed
  findings had unanimous verifier agreement); refuted findings were dropped, not softened into this
  document.
- **Corrections applied:** where a verifier sharpened a claim (e.g. E1.1 renders as HTML/413 not 500;
  E5.4's historical-snapshot safety; E4.3's undici-300s backstop bounding the "unbounded" hang), the
  epic text reflects the corrected understanding, not the auditor's first draft.
- **Residual risk:** the completeness-critic agent failed on a transient API error, so the automated
  gap-audit round did not run; the file-level coverage diff above was performed manually in its place
  and found no unaudited substantive surface. Dynamic/load behavior (real provider streaming, soak)
  was not exercised — Task E7.2 is the recommended first step to close that.

---
*End of FABLE_AUDIT. 15 epics · 46 confirmed findings (0 critical, 9 high, ~37 medium) · 45 backlog items.*
