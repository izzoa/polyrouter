# TODOS — polyrouter build plan (OpenSpec change breakdown)

**App name: `polyrouter`** — an open-source, self-hostable LLM router/gateway. Full reference spec: [`spec.md`](./spec.md). Operating rules: [`CLAUDE.md`](./CLAUDE.md).

This file decomposes the spec into **individually proposable OpenSpec changes**. Each entry is one capability ≈ one change, listed in dependency order (per spec §14 / CLAUDE.md build order). Tables owned by a capability land **with that capability's change** (own migration), not up front.

## Per-change workflow (repeat for every entry below)

1. **Propose** — `/opsx:propose <change-name>` (generates `proposal.md`, `design.md`, `tasks.md`, spec deltas under `openspec/changes/<change-name>/`).
2. **Verify proposal** — review `proposal.md` + `tasks.md` + deltas against the matching `spec.md` sections and the CLAUDE.md invariants; DoD scenarios must map to the spec §15 acceptance criteria listed in the entry.
3. **Clink (codex review)** — run a codex review via the unison `clink` tool over the proposal artifacts; fold in findings before implementation.
4. **Apply** — `/opsx:apply` and work `tasks.md` in order. Stop and flag (never reinterpret) any task that contradicts the spec or an invariant.
5. **Verify implementation** — DoD below: tests green (`npm test`, e2e suites where relevant), `npm run build` passes, lint clean, migration generated if schema changed, changeset added if user-facing. Optionally clink the implementation diff with codex before archiving.
6. **Archive** — `/opsx:archive` (merges deltas into `openspec/specs/`).

## Naming conventions (spec §16: do not reproduce Manifest branding)

Where the spec shows manifest-branded examples, use polyrouter equivalents **consistently**:

| Spec example | polyrouter value |
|---|---|
| API key format `mnfst_…` | `poly_…` |
| Routing header `x-manifest-tier` | `x-polyrouter-tier` |
| Product/brand strings | `polyrouter` |

Env var names, endpoint paths (`/v1/chat/completions`, `/v1/messages`, `/api`), and everything else in the spec are generic and stay as written.

## Status board

| # | Change | Phase | Depends on | Size | Status |
|---|---|---|---|---|---|
| 1 | `add-monorepo-foundation` | A | — | M | ✅ archived 2026-07-14 |
| P | `add-dashboard-prototype` *(out-of-band: user-directed UI port from Claude Design)* | F′ | 1 | L | ✅ archived 2026-07-14 |
| 2 | `add-database-and-tenancy` | A | 1 | M | ✅ archived 2026-07-15 |
| 3 | `add-auth-and-identity` | A | 2 | L | ✅ archived 2026-07-15 |
| 4 | `add-ssrf-url-guard` | B | 1 | M | ✅ archived 2026-07-15 |
| 5 | `add-protocol-translation` | B | 1 | XL | ✅ archived 2026-07-15 |
| 6 | `add-provider-adapters` | B | 2, 4, 5 | XL | ✅ archived 2026-07-15 |
| 7 | `add-provider-management` | B | 3, 4, 6 | L | ✅ archived 2026-07-15 |
| 8 | `add-pricing-catalog` | B | 7 | M | ✅ archived 2026-07-15 |
| 9 | `add-routing-config` | C | 3, 7 | S | ✅ archived 2026-07-15 |
| 10 | `add-inference-proxy-core` | C | 3, 5, 6, 9 | L | ✅ archived 2026-07-15 |
| 11 | `add-request-logging` | C | 8, 10 | M | ✅ archived 2026-07-15 |
| 12 | `add-fallbacks-and-stream-safety` | C | 10, 11 | M | ✅ archived 2026-07-15 |
| — | **⛔ REVIEW GATE — human review of the shippable core** | C | 10–12 | — | ☐ |
| 13 | `add-structural-routing` | D | 11 | M | ✅ archived 2026-07-15 |
| 14 | `add-cascade-routing` | D | 12, 13 | M | ✅ archived 2026-07-15 |
| 15a | `add-notification-channels` | E | 3, 4, 6 | M | ✅ archived 2026-07-15 |
| 15b | `add-notification-producers` | E | 15a, 6, 11 | M | ✅ archived 2026-07-16 |
| 16 | `add-spend-limits` | E | 11, 15 | M | ✅ archived 2026-07-16 |
| 17 | `add-analytics-api` | F | 11 | S | ✅ archived 2026-07-16 |
| 18 | `add-dashboard-core` | F | 3, 7, 8, 9, 10 | L | ✅ archived 2026-07-16 |
| 19 | `add-dashboard-analytics` | F | 17, 18 | M | ✅ archived 2026-07-16 |
| 20 | `add-dashboard-config` | F | 9, 14, 15, 16, 18 | M | ✅ archived 2026-07-16 |
| 21 | `add-observability` | G | 12 | S | ✅ archived 2026-07-16 |
| 22 | `add-packaging` | G | 12, 15, 18 (full value: 13–21) | M | ✅ archived 2026-07-16 |
| — | Deferred (org/workspaces + cloud tier) | — | flagged only | — | ☐ |

### Post-baseline hardening (from `FABLE_AUDIT.md`)

Changes proposed against the full-audit epics after the 22-entry baseline shipped. Same per-change workflow.

| Epic | Change | Size | Status |
|---|---|---|---|
| E7 | `add-ci-and-drain-tests` | M | ✅ archived 2026-07-16 |
| E1 | `fix-proxy-ingress-and-drain` | M | ✅ archived 2026-07-16 |
| E2 (req) | `fix-translation-request-fidelity` | M | ✅ archived 2026-07-17 |
| E2 (stream) | `fix-translation-stream-fidelity` | M | ✅ archived 2026-07-17 |
| E3 | `fix-analytics-keyset-cursor` | S | ✅ archived 2026-07-17 |
| E4 | `fix-breaker-recovery` | M | ✅ archived 2026-07-17 |
| E5 | `fix-cost-recording-gaps` | M | ✅ archived 2026-07-17 |

- **E5 — ✅ Done (archived 2026-07-17):** shipped as `fix-cost-recording-gaps` — four cost-recording completeness fixes. (E5.1) The `LogWriter` shutdown flush no-oped when it raced an in-flight flush, silently losing late drafts (drained-stream final rows) without counting them; now `flush()` coalesces onto the in-flight promise, a shutdown `drain()` loops until both queues empty, `flushOnce` snapshots both queues up front (no child-before-parent FK drop), and each individual DB op (per-draft price lookup + each insert) is bounded by `opTimeoutMs` so a hung DB can't block the drain — while a large healthy batch is never falsely dropped (clink round 3 moved the bound from per-group to per-op). (E5.2) A client disconnect during the cascade cheap leg recorded NOTHING (request vanished); both branches now record one `status=error` cascade row (no attempt rows, no notifyFailed) before throwing. (E5.3) The §8 BYOK families (Qwen/Kimi/MiniMax/GLM) had no host→family mapping → `cost=null` forever; added the LiteLLM-verified mappings for the **USD international endpoints only** (China-domestic CNY endpoints deliberately left unmapped → unknown, never a ~7×-wrong cost — clink caught `dashscope.aliyuncs.com`/`open.bigmodel.cn`/`api.minimaxi.com` as CNY), extended the bundled catalog with real per-token rows + xai/cohere, bumped `BUNDLED_CATALOG_VERSION`. (E5.4) A stale user price silently overrode the catalog after a `custom→api_key` kind change; the fix pivoted (clink round 2) from transactional clearing to a **central resolver gate** — `resolveModelPrice` honors a model-own price ONLY for custom/local, so a stale/raced price on a known provider can never yield a wrong cost (no locking needed); the kind change also clears the now-ignored prices for GET consistency. Three codex clink rounds (2 proposal + 1 diff): round 1 caught the regional-pricing conflation + E5.4 atomicity + E5.1 unbounded-hang; round 2 caught the concurrent-restore TOCTOU (→ resolver-gate pivot) + minimax host; round 3 caught the CNY minimaxi.com host + per-group-vs-per-op timeout granularity. Modified specs: request-logging, cascade-routing, pricing-catalog, provider-management. Verified: build/lint/typecheck green; shared 64 + data-plane 244 + control-plane 195 unit; e2e 192/192.

- **E4 — ✅ Done (archived 2026-07-17):** shipped as `fix-breaker-recovery` — three circuit-breaker/upstream-timeout fixes. (E4.1) A half-open probe settled success only at stream end, but LLM streams outlive the 10s probe lease → the next admission reclaimed the lease + bumped the generation, discarding the in-flight probe's success as stale, so a recovered provider stayed throttled to ~1 req/cooldown forever. `withBreakerStream` now renews the probe lease on stream activity (fire-and-forget, throttled to ~once per third of a lease, doubly-contained so a renewal fault can't stall/fail the stream) via a new `renew` store op (pure `applyRenew` + `RENEW_LUA`); an expiry guard (`now < probeExpiresAt`) keeps the silent-probe/reclaimed-lease semantics exact, and `Math.max` makes a renewal monotonic (never shortens a lease — clock-step safe). (E4.2) The breaker Lua now derives `now` from the **Redis server clock** (`redis.call('TIME')`), so inter-instance wall-clock skew can't corrupt cooldown/lease arithmetic; `RedisBreakerStore` stops forwarding `now`, `InMemoryBreakerStore` keeps its injected clock (interface unchanged). (E4.3) `ProviderConfig.idleTimeoutMs` was dead config — a buffered read stalling after headers was bounded only by undici's ~300s default; now every non-streaming read (`chat`+`listModels`) has an inter-chunk idle deadline that aborts + fails **`unavailable`** (trip/fallback-eligible), with a new `PROXY_IDLE_TIMEOUT_MS` knob (streaming stays on core's per-event timeout — no second timer). Three codex clink rounds: round 1 caught two E4.1 design bugs (half-lease throttle couldn't meet the "gap ≤ lease" contract → honest bound + fire-and-forget; renewal could revive an expired probe → expiry guard) and the listModels coverage gap; round 2 caught a fire-and-forget unhandled-rejection path (throwing `onError`) → double containment; round 3 (diff) caught the backward-clock-step renewal stall → monotonic scheduling + `Math.max`. Modified spec: provider-adapters (breaker requirement + timeout requirement). Revert-proof regression tests for E4.1 (without renewal the probe never closes) + real-Redis server-clock/renewal parity (reworked off injected time onto real sleeps). Verified: build/lint/typecheck green; data-plane 244 unit (redis parity executed) + control-plane 192 unit + e2e 188/188.

- **E3 — ✅ Done (archived 2026-07-17):** shipped as `fix-analytics-keyset-cursor`. The analytics request-listing keyset cursor round-tripped `created_at` through a millisecond JS `Date`, but the column is µs-precision `now()` and the LogWriter batches a flush in one `INSERT` — so every row in a batch shares one identical µs timestamp, and a page boundary inside that tie group silently skipped the rest (the rows still counted in summaries → dashboard inconsistent with itself). The cursor now carries a DateStyle-independent `to_char` UTC/µs string and the next-page predicate binds it back as `::timestamptz`, comparing at full stored precision; `parseCursor` validates the exact grammar (clean 422, never a cast 500). Code-only — no migration, fixes historical rows. A µs-realistic e2e (3 rows sharing one µs timestamp, walked one per page) is a proven regression test: it drops 2 of 3 rows without the fix, passes with it. One codex clink round (diff) folded the DateStyle-portability hardening. Verified: build/lint/typecheck green; control-plane 190 unit + e2e 188/188.

- **E2 stream half — ✅ Done (archived 2026-07-17):** shipped as `fix-translation-stream-fidelity`, completing epic E2. The Anthropic client stream serializer now emits ONE conformant `message_delta` (numeric `usage.output_tokens`, non-null `stop_reason`) before `message_stop` instead of a per-event delta that null-clobbered the stop reason and crashed Anthropic SDKs (E2.1); streamed OpenAI requests set `stream_options.include_usage` so cost is exact (E2.2); both parsers emit a normalized `error` on truncation instead of a fake clean stop, and a `message_stop`/`[DONE]` with no stop reason ever seen is an IR error (not laundered to success) (E2.7); unknown streamed blocks (`thinking`/`thinking_delta`) are skipped with **dense index remapping** so surviving content isn't dropped by SDK consumers, unknown non-streamed blocks/parts are skipped, and an in-band OpenAI `{error}` frame becomes a normalized error event instead of a `TypeError` (E2.8); the golden suite + a streamed `/v1/messages` e2e now cover the serializer, in-band errors, truncation, and a malformed streamed tool call (E2.6). Three codex clink rounds across both E2 halves; round 2 on the stream diff caught the sparse-index SDK bug and the core-invisible incomplete-stream error. Purity + commit boundary preserved; data-plane 227 unit + e2e 187/187.

- **E2 request half — ✅ Done (archived 2026-07-17):** shipped as `fix-translation-request-fidelity`. E2 (protocol translation fidelity) was split into a request half and a stream half (the audit + the proposal review both recommended it). This change: the IR gains opaque `cacheControl` (text/tool_use/tool_result blocks, tools, system), `responseFormat` (OpenAI), and a **source-protocol-tagged** `reasoning` control (so it's emitted only back to the owning protocol, dropped-not-mismapped crossing over). `requestIn`/`requestOut` on both adapters carry these; multi-block content/system is serialized as block/parts **arrays** (no more `join('')` fusion — E2.3, the structural prerequisite for per-block cache_control); Anthropic `requestOut` clamps `temperature` to `[0,1]` (E2.9); the proxy rejects OpenAI `n>1` with a protocol-shaped 400 before normalization (E2.10). Scope-excluded (documented): cache_control on image/nested-tool-result/request-level positions, and a semantic cross-protocol reasoning map. Two codex clink rounds folded (reasoning-provenance tagging, n>1-before-catch, systemOut skip-non-text, canon drop docs). Purity preserved; all 74 pre-existing translate round-trips + `purity.spec` stay green; +9 request-fidelity unit tests. Verified: build/lint/typecheck green; data-plane 215 + e2e 184/184. **Remaining E2 (stream half):** E2.1 conformant `message_delta` usage, E2.2 `stream_options.include_usage`, E2.6 golden stream/error coverage + `/v1/messages` e2e, E2.7 truncation-as-error (both parsers), E2.8 unknown block/part degradation incl. streaming `thinking_delta`.

- **E1 — ✅ Done (archived 2026-07-16):** shipped as `fix-proxy-ingress-and-drain` — the P0 audit epic, four `/v1` request-path fixes. (1) `/v1` body limit is now `PROXY_MAX_BODY_BYTES` (default 10 MiB, `/v1`-scoped so `/api` keeps the default) with oversized→**413**/malformed→**400** rendered in the caller's OpenAI/Anthropic envelope via a body-parser error middleware (they fire before Nest, so the exception filter can't see them) — was a 100kb HTML 413 that broke §15's drop-in criterion. (2) Shutdown drain now races the abort signal and destroys a write-blocked socket, so `app.close()` no longer hangs forever when a client stops reading (was severing all other streams + skipping the log flush; invariant 12). (3) A hung-at-connect provider now **trips** the streaming breaker: core's first/inter-event bound sits a margin above the adapter first-byte bound so the adapter's typed `unavailable` wins, and `withBreakerStream` only treats a cancellation as neutral when the caller-abort predicate says the client actually left (a system timeout trips; genuine client-disconnect neutrality from 8abd4b6 preserved). (4) `PROXY_FIRST_EVENT_TIMEOUT_MS` makes the time-to-first-token bound configurable for slow local models. Modified specs: inference-proxy (errors + drain), provider-adapters (per-call timeout). Both E1.2/E1.3 fixes carry stash-revert-proven regression tests; +adapter→core timing test, +bare-Express body-parse test. Verified: build/lint/typecheck green; data-plane 206 + control-plane 190 unit; e2e 183/183.

- **E7 — ✅ Done (archived 2026-07-16):** shipped as `add-ci-and-drain-tests` — the project's first CI pipeline (`.github/workflows/ci.yml`: a `quality` job running build/lint/**typecheck**/unit with a redis service, and an `e2e` job over postgres:16 + redis:7) plus the new **`ci-pipeline`** capability spec. Adds per-package `tsc --noEmit` typecheck (**including test files** — turbo `typecheck` task + `env:["CI","REDIS_URL"]` on `test` so strict-mode turbo forwards them), which surfaced and fixed ~18 latent test-file type errors incl. three breaker specs importing a nonexistent `./translate` and a phantom `ProviderCircuitOpenError` export (that had silently made a circuit-open assertion vacuous). The `REDIS_URL`-gated breaker parity suite now **fails loudly in CI** instead of silently skipping. New invariant-12 coverage (previously zero): a `StreamDrainRegistry` unit spec + a `stream-lifecycle` e2e that drives a real listening server through shutdown-drain (503 refusal + in-flight completion + deadline abort), mid-stream client disconnect (breaker-neutral, threshold-1 recording breaker), and slow-client backpressure. Removed `forceExit` from the e2e runner and fixed the leak it masked — a `NotificationsModule` compile-reject test that orphaned eagerly-connected Redis sockets — relocating that boot-time-SSRF coverage to a spawned-process test. **Test/CI-only: no production `src/` changes, no migration, no changeset.** Verified: build/lint/typecheck green; data-plane 202 unit (parity suite executed); e2e 182/182 green ×3 consecutive, exiting unaided.

---

## Phase A — Foundations

### 1. `add-monorepo-foundation`
- **Goal:** Turborepo + npm workspaces monorepo that builds, lints, and tests empty-but-wired packages, with fail-fast config loading.
- **Spec:** §3.1, §4, §12, §14.1.
- **Scope:** `packages/{shared,control-plane,data-plane,frontend}` per §4 (data-plane as a NestJS module boundary from day one); TypeScript strict everywhere; shared built to CJS + ESM; NestJS 11 skeleton with global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`); SolidJS + Vite skeleton; **extensible env/config-schema framework** (§12) — boot fails fast on missing/invalid registered vars; #1 registers its own (`PORT`, `BIND_ADDRESS` **defaulting to `127.0.0.1`** per §12, `NODE_ENV`, `MODE`), and each later change registers the vars it introduces; health endpoint; dev topology (Vite `:3000` proxying `/api` + `/v1` to `:3001`, CORS dev-only); scripts: `npm run dev`, `npm run build`, `npm start`, per-package `npm test`; ESLint/Prettier; Jest/Supertest (backend), Vitest (frontend/shared); changesets tooling.
- **Out of scope:** DB schema, Redis usage, auth, any endpoint beyond health; env vars owned by later capabilities.
- **DoD:** `npm run build` green from clean checkout; `npm run dev` serves SPA shell + API health; boot with a missing required env var exits non-zero with a clear message; strict TS, no `any` escapes.

### 2. `add-database-and-tenancy`
- **Goal:** Drizzle + Postgres schema for the identity/config core, migrations on boot, Redis wiring, and the **central tenant-scoping guard** + secret-encryption utility.
- **Spec:** §5, §11.1, §12; invariants 5, 8.
- **Scope:** Drizzle schemas for **User, Organization, Agent, Provider, Model, Tier (seed `default`), RoutingEntry, RoutingRule** (Organization is schema-only for now — the feature is deferred, see Deferred section); migrations generated + run on boot; Redis client/module (registers `DATABASE_URL`/`REDIS_URL` in the #1 config schema); **shared ownership-scoped repository/guard — no by-id fetch path without `WHERE owner = current_principal`**, with a `Principal` union (user implemented; org variant reserved and failing loudly until the deferred org change, per §11.1); shared encrypt-at-rest utility (used later by providers §8 and notification channels §10.1); cross-tenant/IDOR e2e test harness pattern established. **Feature-owned tables land with their owners:** ModelPrice → #8, RequestLog → #11, NotificationChannel → #15, Limit → #16 (each ships its own migration).
- **Out of scope:** business endpoints; auth flows (guard consumes a principal interface stubbed until #3); the feature-owned tables above.
- **DoD:** migrations idempotent on boot; tenant-isolation test proves a scoped repo cannot return another principal's row by id; encryption util round-trips and never logs plaintext.

### 3. `add-auth-and-identity`
- **Goal:** Both credential planes: Better Auth sessions for the dashboard, HMAC agent API keys for the proxy.
- **Spec:** §2.1, §5 (User/Agent), §6.2 (Agents CRUD), §11, §11.3, §12; invariant 7.
- **Scope:** Better Auth email/password + Google/GitHub/Discord OAuth; session guard on `/api` (planes separate — `/v1` is agent-key-only); **first user = admin with advisory-lock race guard + boot reconciliation** for the post-commit hook window; `MODE=selfhosted` localhost auto-login (loopback socket + Host + same-origin, hardened) + dev-only `SEED_DATA`; atomic Redis rate limiting on register/login/password-reset (fail-open self-host, fail-closed cloud); Agent CRUD (create mints `poly_…` key shown once, rotate, delete, coalesced `last_used_at`), stored as **HMAC-SHA256 hash + prefix for O(1) lookup — never bcrypt**; Bearer-key proxy guard resolving prefix → HMAC compare → Agent; per-harness connection snippet data from `shared`. Better Auth's drizzle adapter is built inside the #2 database module (no new raw handle).
- **Out of scope:** the proxy endpoints themselves (#10); dashboard UI (#18); org/team membership (deferred); **password-reset email delivery (deferred to #15)**.
- **Note:** this bundles the two credential planes CLAUDE.md's build order groups together; the planes are internally separable — if the review unit proves too large at proposal time, split into `add-session-auth` and `add-agent-keys` (agent keys depending on session auth).
- **DoD (§15):** API keys fast-verified (HMAC + prefix, no-KDF proven deterministically); concurrent first-signup race yields exactly one admin; auth endpoints throttle; session passwords use a slow memory-hard KDF (Better Auth's scrypt — satisfies §3.2.3's argon2/bcrypt intent); cross-tenant tests cover Agents.

## Phase B — Translation & providers

### 4. `add-ssrf-url-guard`
- **Goal:** One shared outbound-URL validation module used by every server-side fetch of a user-supplied (or env-supplied) URL.
- **Spec:** §11.2, §8 (custom providers), §10.1 (Apprise/webhooks, `APPRISE_API_URL`); invariant 6.
- **Scope:** validate HTTP(S) URLs — `assertUrlSafe` (name-time) blocks private/loopback/link-local/metadata/CGNAT/mapped/NAT64 ranges (IPv4+IPv6), requires https for remote; **`guardedFetch` re-validates every redirect hop and the actual connected socket IP** (DNS-rebinding + literal-IP + redirect defense — node agents don't protect `fetch`, so this ships an undici connector); **loopback exception derived inside the guard from structured `context: { mode, providerKind }`** (selfhosted + local only); address-bounded allowlist (`{host, cidr}`, metadata always blocked); covers `APPRISE_API_URL` and HTTP(S) webhook targets the same as user URLs. Non-HTTP Apprise schemes (`discord://`…) are #15's scheme-specific extraction + egress control.
- **DoD (§15):** SSRF-rejection suite — `169.254.169.254`, `localhost`, RFC1918, IPv6 equivalents, mapped/NAT64, decimal/octal/hex encodings, userinfo tricks, redirect-to-private, and a **socket-path rebinding** case (name-time public, connect-time private, via a real local listener) all rejected; loopback accepted only under selfhosted/local context. (Size S→M after codex round 1 — the guarded-fetch transport.)

### 5. `add-protocol-translation`
- **Goal:** The OpenAI ⟷ Anthropic normalization module behind the **`Normalized*` IR it owns** — **the hardest part; budget the most time here** (§6.3).
- **Spec:** §6.3; invariant 2. *Depends only on #1 — parallelizable with #2–#4.*
- **Scope:** `data-plane/src/proxy/translate/` module, one in/out adapter per protocol, proxy core stays protocol-agnostic; **defines and exports the single `Normalized*` IR** (request/response/stream-event types) that #6's provider adapters and #10's proxy consume — nothing else defines a normalized shape; system prompt placement, tool_calls (stringified JSON args) ⟷ tool_use/tool_result blocks incl. **multi-turn tool round-trips**, streaming event reassembly (chat.completion.chunk ⟷ message_start/content_block_*/message_stop), finish_reason ⟷ stop_reason both ways, multimodal image shapes, usage fields incl. Anthropic cache-read/write tokens preserved for cost; provider deviations handled as per-adapter quirks.
- **DoD (§15):** **golden-file contract suite** — recorded fixtures across the matrix (plain, multi-turn tool-call round-trip, streamed, multimodal, error) round-trip in both directions; suite runs in `npm run test:e2e -w packages/control-plane`.

### 6. `add-provider-adapters`
- **Goal:** The provider adapter interface with OpenAI-compatible and Anthropic-compatible adapters and a Redis circuit breaker.
- **Spec:** §8, §3.2 (breaker); invariant 2 (quirks live in adapters), invariant 6.
- **Scope:** adapter interface `chat(request) → NormalizedResponse` / `listModels()` / `testConnection()` — **consumes #5's `Normalized*` IR; adapters never define their own response shapes**; OpenAI-compatible + Anthropic-compatible adapters (cover the four kinds: api_key, subscription, custom, local — local gated on `MODE=selfhosted`, marked free); cheap `testConnection()`; **Redis-shared circuit breaker** so all instances skip a down/rate-limited provider; **all adapter outbound HTTP for custom/local providers goes through #4's connect-time resolved-IP validation** (rebinding defended at fetch time, not just CRUD time); credentials passed in, never logged.
- **Out of scope:** CRUD endpoints (#7), pricing (#8).
- **DoD:** adapter unit tests incl. breaker open/half-open/close across two simulated instances via one Redis; a hostname that turns private at fetch time is refused; no secret ever appears in logs (test asserts).

### 7. `add-provider-management`
- **Goal:** Provider CRUD + model catalog sync, with encryption and SSRF enforced.
- **Spec:** §2.2, §6.2, §8; invariants 5, 6, 8.
- **Scope:** Provider CRUD (list/create/test-connection/sync-models/delete) with credentials **encrypted at rest** (#2 util); custom base_urls validated by #4 (never a closed provider allow-list); Model rows synced from `listModels()`; provider health/status surface; Models list/filter API.
- **DoD (§15):** adding a custom provider with a private/metadata-resolving base_url is rejected (except self-host loopback); cross-tenant tests cover Providers/Models; credentials unreadable in DB dumps and absent from logs.

### 8. `add-pricing-catalog`
- **Goal:** Bundled, versioned pricing/capability table and effective-dated price versioning — the foundation for immutable cost.
- **Spec:** §7.7, §5 (Model, ModelPrice), §8 (free models); invariant 4.
- **Scope:** **`ModelPrice` table (model_id, prices, valid_from) + migration lands here**; bundled pricing JSON (seeded from a maintained source, e.g. LiteLLM/models.dev) shipping with the app; seed on boot; periodic refresh + manual override API; user-entered prices for custom models, local = free; **bundled curated free-models list** (e.g. OpenRouter free tiers) marked `is_free` so tiers can route simple traffic to $0 models (§8); capability flags (context window, tools/vision/reasoning, cache-token prices).
- **DoD:** price lookup returns the price in effect at a given timestamp; refresh creates a new effective-dated row, never mutates history; catalog covers the §8 BYOK provider list and includes the curated free set.

## Phase C — Inference proxy (Layer 0) — the shippable core

### 9. `add-routing-config`
- **Goal:** CRUD for tiers, ordered model assignments, and header rules — the data the proxy routes on.
- **Spec:** §5 (Tier/RoutingEntry/RoutingRule), §6.2; invariant 5.
- **Scope:** Tier CRUD (`default` seeded, user-defined keys); RoutingEntry ordering — position 0 primary, **max 5 models per tier total** (§7.4; schema-enforced since #2), a model may sit in multiple tiers; RoutingRule CRUD (`header` match on `x-polyrouter-tier` by default, `default` fallthrough; target tier or model); validation (no empty-tier targets without a clear error contract for #10).
- **DoD:** CRUD e2e with tenant-isolation coverage; ordering persists; cap enforced.

### 10. `add-inference-proxy-core`
- **Goal:** The public proxy contract: `/v1/chat/completions`, `/v1/messages`, `/v1/models` with **explicit routing only** (Layer 0), streaming + non-streaming.
- **Spec:** §6.1, §7.2 Layer 0, §3.2.5 (backpressure); invariants 1, 12.
- **Scope:** Bearer agent-key auth (#3 guard), `last_used_at` stamping; route resolution precedence: explicit model → **tier key/alias in the `model` field (§6.1)** → `x-polyrouter-tier` header via RoutingRule → `default` tier (clear error when a tier has no models); `model=auto` **resolves to the default tier for now** (pipeline lands in #13/#14 — `auto` must already be accepted, §2); translate via #5 so any client protocol reaches any provider protocol; SSE streaming and non-streaming with **slow-client backpressure from day one** (pipe correctly; no unbounded buffering to an unread socket); `GET /v1/models` lists the tenant's models, tier keys, and aliases incl. `auto`.
- **Out of scope:** fallback chains and mid-stream policy (#12), logging (#11), smart layers (#13/#14).
- **DoD (§15):** an external agent configured only with `base_url` + key gets working completions, streaming and non-streaming, **including with `model=auto`** (resolves to the default tier at this stage); naming a model works; header or `model=<tier>` forces the tier; `default` serves otherwise; OpenAI-shaped client ⟷ Anthropic upstream (and vice-versa) works for plain, multi-turn tool, and streamed turns; a stalled client does not grow process memory unboundedly.

### 11. `add-request-logging`
- **Goal:** Every routed request writes an immutable-cost RequestLog row without slowing the hot path.
- **Spec:** §5 (RequestLog), §7.5, §7.7, §3.2.4; invariants 4, 8, 9.
- **Scope:** **`RequestLog` table + migration lands here** (decision_layer, routing_reason, price snapshots, `usage_estimated`, `escalated`, `quality_signal`; indexes on created_at/agent/provider/model); tokens from provider `usage` (**no billing tokenizer on the hot path**; `chars/4` estimates only where routing needs size); cost computed at request time; **unit-price snapshots stored on the row**; `usage_estimated=true` when provider usage is missing/partial (estimate from streamed text / request chars) — never silent nulls; duration, status, tier, `decision_layer='explicit'|'header'|'default'`, structured `routing_reason`; batched/Redis-buffered writes off the request path; **no prompt/response bodies unless explicitly opted in**.
- **DoD (§15):** cost-immutability e2e — change the catalog price after a request completes; recorded cost and historical spend do not move; missing-usage request is flagged estimated; log write failure never fails the client request.

### 12. `add-fallbacks-and-stream-safety`
- **Goal:** Fallback chains with the mid-stream commit policy and graceful drain.
- **Spec:** §7.4, §6.3 (mid-stream policy), §8 (subscription preference), §3.2.5; invariants 3, 12.
- **Scope:** walk up to 5 ordered models per tier on provider error/timeout/429/unknown-model; **within a chain, prefer subscription-kind quota first and walk to paid API-key providers when the subscription hits its limits (§8)**; record which model served and why predecessors failed (`status=fallback`); **no commit to the client until the upstream's first token** — pre-commit failures fall back transparently; post-commit upstream errors terminate the stream with a clear terminal error event (`status=error`), **never a silent model swap**; optional configurable first-chunk buffer to widen the pre-commit window; graceful shutdown drains in-flight streams.
- **DoD (§15):** e2e — pre-first-token failure falls back transparently and the request succeeds; post-first-token failure yields a terminal error, never spliced output; a rate-limited subscription provider falls through to its paid fallback; SIGTERM under an active stream drains before exit.

### ⛔ REVIEW GATE (after #12)
Stop for human review of the shippable core (spec §14.5, CLAUDE.md). Do **not** propose Phase D until this gate passes.

## Phase D — Automatic routing (opt-in, must degrade to explicit)

### 13. `add-structural-routing`
- **Goal:** Layer 1 — `auto` routes via cheap, language-neutral structural features with per-agent system-prompt baseline subtraction.
- **Spec:** §7.1–§7.3, §7.6; invariants 1, 9.
- **Scope:** system-prompt **fingerprint (hash) + learned per-agent baseline** — score the last user turn + recent context delta, not the preamble; features: effective input size, code-block presence/size, tool/function-definition count, JSON-schema demand, multimodal presence, conversation depth, `max_tokens`/reasoning flags — **no natural-language keyword matching**; confident high/low exits immediately to a tier; ambiguous falls through to the default tier (until #14); `ROUTING_AUTO_LAYERS` gating; store `decision_layer='structural'` + structured `routing_reason`; sensible zero-tuning defaults, thresholds exposed for power users; **any failure in the smart path degrades to Layer 0 — never fail or stall the request**.
- **DoD (§15):** identical huge system prompts do not force the top tier (baseline subtraction test); non-English requests route sensibly; with the layer disabled or erroring, `auto` still serves via Layer 0; decisions visible with layer + reason.

### 14. `add-cascade-routing`
- **Goal:** Layer 3 — cheap-first with escalation on detected bad answers (FrugalGPT-style). Reaches the self-host feature target (L0+L1+L3).
- **Spec:** §7.2 Layer 3, §7.6; invariants 1, 3.
- **Scope:** for ambiguous, cheap-to-try requests: route to the cheap model, run cheap quality checks (malformed/invalid output, refusal, low self-reported confidence, verifier disagreement), escalate to a stronger tier on failure; **for streamed requests, escalation happens only pre-commit, reusing #12's first-chunk buffer — the mid-stream commit rule (invariant 3) holds**; `escalated=true` + `quality_signal` on the RequestLog; opt-in via `ROUTING_AUTO_LAYERS=…,cascade`; degrades to L1/L0 when disabled.
- **DoD:** e2e — a failing cheap answer escalates and the client still gets one coherent response; a committed stream is never swapped; escalation recorded and inspectable; disabling the layer changes nothing for explicit traffic.

## Phase E — Limits & notifications

> **#15 was split** (delivery core is independently shippable; producers depend on more surfaces). #15a landed the async, SSRF-guarded, secret-safe delivery pipeline + channel CRUD; #15b adds the producers, the scheduler, and password-reset wiring that emit into it.

### 15a. `add-notification-channels` (delivery core)
- **Goal:** The event → channel delivery pipeline (SMTP + Apprise), fully async, deduped, failure-isolated, secret-safe — the thing producers emit into.
- **Spec:** §5 (NotificationChannel), §10.1, §12 (SMTP/Apprise env); invariants 5, 6, 8, 11.
- **Scope:** **`NotificationChannel` table + migration lands here**; owner-scoped channel CRUD (Settings-facing API): kinds `smtp` (Nodemailer: host/port/user/pass/TLS-mode/from/to) and `apprise` (Apprise URLs; POST to `APPRISE_API_URL`); config **encrypted at rest** (AES-GCM under `NOTIFY_CREDENTIALS_SECRET`), never logged; per-channel event subscriptions; per-channel **test-send** persisting `last_test_at`/`last_test_status` (sanitized). SSRF on **every** egress under a **mode-gated policy mirroring the local-provider exception** (metadata blocked always/never allowlistable; self-host allows the operator's own loopback/private infra; cloud blocks unless a port-bounded `NOTIFY_ALLOWED_ENDPOINTS` soft-range entry): SMTP host validated **at connect time** + transport pinned to the validated IP (SNI preserved); Apprise targets scheme-aware (fixed-service allowed; host-bearing + `?smtp=`/`?host=` overrides validated; unknown rejected); `APPRISE_API_URL` host validated in an async `NOTIFY_RUNTIME` factory (**fails boot**); cloud Apprise additionally gated on `NOTIFY_APPRISE_EGRESS_CONFIRMED`, enforced at delivery. **Async delivery via BullMQ** on dedicated fail-fast producer + worker connections; `emit` is O(1), **TTL-deduped per `(type, scope)` window**, never throws/blocks (bounded even when Redis is blackholed); structured **secret-free** `NotificationEvent` (worker renders title/body from non-secret `fields`); per-channel failure isolation; all delivery errors are **fixed sanitized codes**. New deps: **bullmq**, **nodemailer**. Event *types* + subscription plumbing for `provider_down`/`request_failures_spike`/`weekly_spend_summary` live here so #15b/#16 just call `emit`.
- **DoD (§15):** add SMTP + Apprise channels (config encrypted at rest, not plaintext); test-send succeeds + records `success`, a refusing target records `failed:<code>`; a metadata target is rejected in every mode, a **cloud** instance rejects a private/loopback target and refuses a private-resolving `APPRISE_API_URL` at boot (self-host allows its own sidecar); duplicate synthetic `emit`s for one scope/window deliver at most once; a dead channel logs a failure without stalling a healthy one; a blackholed Redis leaves `emit` bounded; cross-tenant coverage; **canary** — a channel-config secret never reaches the Redis job store, DB status, API view, or logs.

### 15b. `add-notification-producers`
- **Goal:** Wire the real event producers + password-reset delivery into #15a's pipeline.
- **Spec:** §5, §10.1, §12; invariants 6, 8, 11.
- **Scope:** **event producers:** `provider_down` emitted on #6 circuit-breaker **open transition** (needs a breaker transition/open signal — #6 currently only stores state, so surface the transition), `request_failures_spike` detector over recent RequestLog (#11), optional scheduled `weekly_spend_summary` (budget events are #16); a scheduler for the periodic ones; optional env-configured **server-wide SMTP defaults** (§12) as a fallback channel; **wire Better Auth's password-reset email delivery** (the `sendResetPassword` stub #3 left) through SMTP. All emit into #15a's `emit`/event contract.
- **DoD (§15):** tripping the #6 breaker delivers a `provider_down` (deduped per incident); a burst of failed requests delivers one `request_failures_spike` per window; the weekly summary fires on schedule; a password reset sends through SMTP; a failing channel never delays enforcement or the request path; cross-tenant coverage.

### 16. `add-spend-limits`
- **Goal:** Budgets with atomic Redis counters — block in the request path, alert on schedule — correct across instances.
- **Spec:** §5 (Limit), §10; invariants 5, 10, 11.
- **Scope:** **`Limit` table + migration lands here**; Limit CRUD: scope global/org/agent, window day/week/month, action `alert`|`block`, subscribed channel ids; **Redis atomic counters** (INCR+expiry or token-bucket Lua) updated per request, reconciled against RequestLog; `block` evaluated in the proxy path with a clear rejection error until window reset; `alert` evaluated on a schedule, emitting `budget_alert`/`budget_block` events into #15.
- **DoD (§15):** two proxy instances + one Redis: combined spend crossing a block threshold stops new requests (no per-instance drift); a budget hovering at its threshold produces **at most one `budget_alert` per window per scope**; a failing notification channel never delays or blocks block-action enforcement; budget check adds negligible hot-path latency; cross-tenant tests cover Limits.
- **✅ Done (archived 2026-07-16):** shipped as `add-spend-limits`. The `Limit` table landed as **`budget`** (avoids the `limit` keyword); scope `global`/`agent` (org deferred), window `day`/`week`/`month`. Enforcement is an **asynchronously-metered postpaid soft cap over resetting UTC calendar windows** — the counter is a **reconciled read-model** (integer µ$): a `budget-eval` scheduler (own BullMQ queue) is the **sole writer**, recomputing each budget's current-period spend from the RequestLog ledgers and monotonically setting the shared Redis counter (no double-count/race), plus a reconciliation heartbeat. `block` is enforced pre-`prepare` in the proxy (streaming rejects pre-commit → 402) via a bounded fail-fast read off a capped cache with a **named fail mode** (`BUDGET_FAIL_OPEN`, default open) that also trips on a stale heartbeat (stopped scheduler → fail-closed 503, never silently under-budget). `alert`/`block` emit through #15's pipeline, once per budget per period, targeted to the budget's channels. Root `spec.md` §10 updated (rolling → resetting calendar window + single-writer reconciliation). Deferred here: **org scope**, a **reserve-then-settle hard cap**, a **sliding window**, and the **budgets SPA** (#18–#20).

## Phase F — Dashboard

> **Note (2026-07-14):** the out-of-band change `add-dashboard-prototype` implemented the full dashboard UI from the approved Claude Design prototype (project `c06afc7f…`, file `Polyrouter Prototype.dc.html`) against a **simulated data layer** (`packages/frontend/src/data/` + `src/state/appState.ts`). #18–#20 therefore re-scope from "build the UI" to **"replace the simulator with real APIs/auth"** behind that boundary — their spec sections, DoD, and dependencies stand, but the visual/interaction work is done. The UI's Google-Fonts (Geist) dependency was bundled locally in #22 (done).

### 17. `add-analytics-api`
- **Goal:** The control-plane aggregation endpoints powering every chart.
- **Spec:** §9 (aggregations), §5 (RequestLog indexes); invariant 5.
- **Scope:** time-bucketed `GROUP BY` endpoints over RequestLog: requests over time, spend, tokens, success/fallback/escalation rates, top models, per-agent/per-provider/per-tier breakdowns, free-vs-paid split; date-range params; paginated request-log listing incl. `decision_layer` + `routing_reason`; all tenant-scoped. (Timescale/ClickHouse are deferred cloud graduations — plain Postgres here.)
- **DoD:** aggregation correctness tests over seeded logs; cross-tenant coverage; queries indexed (no seq-scan on the hot log table for the standard ranges).
- **✅ Done (archived 2026-07-16):** shipped as `add-analytics-api` — a tenant-scoped `analytics` accessor on the central `PersistencePort` + a session-guarded `/api/analytics` controller (`summary`/`timeseries`/`breakdown`/`requests`) over `request_log` + the `request_attempt` cascade ledger. Spend sums **both ledgers with #16's per-row µ$ rounding** so the dashboard reconciles with budgets (invariant 4); counts/tokens/free-paid split are over served rows; `breakdown` resolves owner-scoped labels and attributes cascade attempts via their parent (both-sides `ownershipPredicate` — an adversarial cross-tenant attempt is tested); `requests` is keyset-paginated with the decision-inspector fields + per-row attempt cost. UTC buckets, plain SQL (invariant 9), bad-enum→400 / bad-range/cursor→422, no `sql.raw` of user input. **No migration** (reuses the `(owner, created_at)` index from #16), no new deps. Verified: 8 analytics e2e + full 152-test e2e suite green, build/lint/format clean. Deferred: the analytics UI (#19), a subscription-vs-API split, zero-filled buckets. **Unblocks #19 `add-dashboard-analytics`.**

### 18. `add-dashboard-core`
- **Goal:** The SPA shell and the 3-step onboarding: auth, connect an agent, connect providers — ending with a real proxied completion.
- **Spec:** §2, §9 (Agents/Providers/Settings pages), §3.4, §7.7 (price override UI), §16 (ToS note).
- **Scope:** SolidJS + Vite app served by NestJS in prod; auth pages (Better Auth incl. OAuth, localhost auto-login self-host); Agents page — create/rotate/delete, key-shown-once flow, **per-harness connection snippets** (OpenAI SDK, Anthropic SDK, Vercel AI SDK, LangChain, cURL, personal-agent harnesses from `shared`); Providers page — add all four kinds, test connection, sync models, health/breaker state, **model pricing view with manual override / user-entered prices for custom+local models** (backed by #8; a new effective-dated row, never mutating history); **subscription-kind UX: surface the ToS risk and nudge adding a pay-per-token fallback (§8, §16)**; onboarding assigns the first synced model to the `default` tier (via #9) so the snippet works immediately; Settings/account shell.
- **DoD:** a new user can sign up, mint an agent key, add a provider, and hit the proxy using a copied snippet — end to end against a real instance; frontend Vitest suites for key flows.
- **✅ Done (archived 2026-07-16):** shipped as `add-dashboard-core` — the SPA's **management slice** (auth + Agents + Providers + onboarding + account) now runs on the real `/api` backend; the observe (Overview/Requests/Costs, needs #17/#19) + config (Routing/Limits/Notifications, #20) pages stay on the simulator behind a "preview — simulated" marker. Filled three backend gaps: `GET /api/me` (works under cookie auth AND cookieless localhost auto-login), `GET /api/login-config` (public; named outside the `/api/auth*` prefix the raw Better Auth mount intercepts — a codex-caught would-have-shipped bug), and `PATCH /api/models/:id` for custom/local pricing (owner-scoped, request-shape-validated, cost-immutable). Frontend: an injectable `ApiClient` + Solid `AppProvider` context seam (fake-client-injectable), an auth gate (me→dashboard / login+OAuth, retryable error, auto-login-aware logout), real Agents CRUD (key shown once, never persisted), Providers CRUD + create-then-test/sync + custom/local price editor + subscription ToS nudge, and a failure-aware onboarding ending in a real proxied `auto` call. Verified: 36 frontend Vitest + 143 control-plane unit + 144 e2e (new `account` + `model-pricing` suites), full build/lint/format clean. The live "fresh user → real LLM" journey remains a manual smoke check.

### 19. `add-dashboard-analytics`
- **Goal:** Observe: overview charts, the request log, and the routing-decision inspector (the transparency feature).
- **Spec:** §9 (Overview/Requests/Costs), §1 (transparency).
- **Scope:** uPlot overview (messages over time, spend, tokens, success/fallback/escalation rates, date range); request-log table with the **decision inspector** (`decision_layer` + `routing_reason` — renders whatever layers exist; no dependency on #13); costs breakdowns (by model/provider/agent/tier, top models, free-vs-paid).
- **DoD (§15):** every request shows tokens, cost, latency, model, and a readable decision layer + reason in the dashboard.
- **✅ Done (archived 2026-07-16):** shipped as `add-dashboard-analytics` — the three Observe pages (Overview/Costs/Requests) + the routing-decision inspector now render live `/api/analytics` data (the simulator + its "preview" banners are retired). Overview: summary cards (spend + success/fallback/escalation rates) + a **uPlot** requests-per-bucket chart + spend-by-model breakdown + recent requests; Costs: range-relative spend + free/paid/unpriced split + model/provider/agent breakdowns; Requests: keyset-paginated log **over a frozen range window** with server-side filter chips + "Load more"; the inspector shows the verbatim `decision_layer` + `routing_reason` (transparency, invariant 1) + immutable price snapshots (0→"$0 free" vs null→"unpriced") + served/attempt/**total** cost, all rendered from snapshots (invariant 4). Backend: `/api/analytics/requests` gained a **multi-value `layer` filter** (so the grouped chips stay server-side; keyset pagination never yields an empty page). Store uses a per-shared-slice **generation guard** (discards stale responses) + a frozen `requestWindow` (no page skips). New dep `uplot`; simulator retired. Verified: 55 frontend Vitest + 143 control-plane unit + 153 e2e green, build/lint/format clean. Deferred: subscription-vs-API split, zero-filled buckets, a live stream. **Phase F remaining: #20 `add-dashboard-config`.**

### 20. `add-dashboard-config`
- **Goal:** Configure: routing, limits, and notification settings UI.
- **Spec:** §9 (Routing/Limits/Settings→Notifications), §2.3.
- **Scope:** Routing page — tiers, **drag-to-reorder primary+fallbacks**, header rules, **auto-layer toggles** (structural + cascade; surfaces `escalated`/`quality_signal`); Limits page (budgets, alert-vs-block, channel wiring); Settings → Notifications (add/edit/enable channels, event subscriptions, **send-test button** with inline success/failure).
- **DoD (§15):** routing and limits are fully configurable from the UI; test-send surfaces success/failure inline; toggling auto layers takes effect without restart.

## Phase G — Ops & packaging

### 21. `add-observability`
- **Goal:** The proxy is at least as observable as what it sells.
- **Spec:** §3.2.6; §14.10.
- **Scope:** OpenTelemetry traces with spans auth → routing decision → upstream call → log write; Prometheus metrics endpoint — latency/error/token/cost counters per provider, per model, per routing layer; circuit-breaker state metrics.
- **DoD:** traces show the full span chain for a proxied request; metrics scrape cleanly; per-provider error attribution visible.

### 22. `add-packaging`
- **Goal:** `docker compose up` → a working instance on one port.
- **Spec:** §13, §14.11, §12.
- **Scope:** single production Docker image (NestJS serves SPA + API + proxy); `docker-compose.yml` — app + postgres + redis + **optional `caronc/apprise`** service; **compose sets `BIND_ADDRESS=0.0.0.0` inside the container** (the §12 loopback default would break the published port); one-line install script (downloads compose, generates secrets, boots); migrations on boot; health endpoint wired to orchestration; graceful-shutdown drain verified in-container; README/self-host docs.
- **DoD (§15):** clean-machine `docker compose up` yields a working instance; first sign-up = admin; bodies not persisted by default; a deploy/restart drains in-flight streams.

## Deferred — propose only when explicitly flagged

**Post-v1 (not cloud-gated — deliberate deferral, recorded here so it isn't a silent gap):**

- `add-org-workspaces` — multi-seat Organization/Workspace (spec §5, §9 Settings→org/team, §11.1 org principals): org create/membership, org-scoped ownership of agents/providers/limits, Settings UI. #2's Organization schema, the guard's user-or-org principal abstraction, and #16's `org` limit scope are forward-compatible stubs for this.

**Cloud-tier graduations** (spec §3.3/§7.6/§14.12; CLAUDE.md: "cloud-tier only — not in the baseline build"):

- `add-semantic-routing` — Layer 2: local multilingual embedding classifier (BGE-M3/e5, ONNX) + nearest-centroid head + Redis decision cache (§5 RoutingDecisionCache). Must degrade to L0/L1.
- `add-learning-loop` — offline retraining of the L2 head + contextual-bandit per-cluster model preferences. Never on the hot path.
- `split-data-plane` — extract `data-plane` to its own Hono/Go service (the §4 directory boundary makes this lift-and-shift).
- `add-events-store` — move RequestLog analytics to Timescale (or partitions+BRIN, or ClickHouse); config stays in Postgres.

## Cross-cutting reminders (apply to every change)

- Tenant scoping via the shared guard (#2) — every new resource type gets cross-tenant tests.
- Secrets through the shared encryption util (#2); never logged.
- Every user-supplied or env-supplied, server-fetched URL goes through #4.
- Each change registers the env vars it introduces in the #1 boot config schema (fail-fast stays complete).
- Strict TS, global ValidationPipe, migrations for any schema change, changeset for anything user-facing.
- Surface the subscription-provider ToS risk in UI copy wherever `subscription` providers appear (spec §16).
