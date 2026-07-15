# Design: add-structural-routing

## Context

#10 built a pure Layer-0 resolver (`resolveRoute`) and an effectful `ProxyService.prepare` that loads an owned config snapshot, resolves the route, and builds the (post-#12) fallback chain. `auto` is accepted but Phase 5 of the resolver sends it to the `default` tier (`routingReason: 'auto → default tier'`). #9 owns tier / entry / **RoutingRule** CRUD with write-time target validation (`assertTargetOwned`). #11 records `decision_layer` (free text) + `routing_reason`. #12 gives every tier decision a fallback `chain`. Redis is wired (`REDIS_CLIENT`). Layer 1 slots **between** Layer 0's `auto→default` fallthrough and the returned decision — refining it when confident, deferring to it otherwise.

The whole design serves one invariant: **the smart path never fails or stalls a request** (invariant 1). Every uncertain or failing branch resolves to the Layer-0 `default` decision, and — per the sub-millisecond requirement (spec §7.2) — the hot path performs **no network I/O**.

## Decision 1 — De-contaminate by construction (exclude the system block; keyed fingerprint for the baseline)

Feature extraction reads the **last window of recent messages (ending at the final message)** and **excludes `NormalizedRequest.system` entirely**. This is the primary fix for problem 1: a huge harness preamble contributes literally zero to the size signal because it is never measured. The `system` block is instead **fingerprinted** purely as the per-agent baseline hash **field**: canonicalize with explicit per-block **type + boundary framing** (so `[text:"A"][text:"B"]` ≠ `[text:"AB"]`), cap the hashed input at `MAX_FINGERPRINT_CHARS = 16_000` (enough to distinguish preambles; keeps the HMAC to tens of µs), and take an **HMAC-SHA256 keyed with a derived server secret**, truncated to 128 bits — so the digest is **not dictionary-correlatable** by anyone able to read Redis. The key is derived once at boot by domain separation from the resolved `API_KEY_HMAC_SECRET`: `fpKey = HMAC-SHA256(API_KEY_HMAC_SECRET, "polyrouter.structural.fingerprint.v1")` (a versioned context label; no new secret to configure, rotates with the parent). Truthful persistence contract: the fingerprint is used **only** as an ephemeral, tenant-scoped, TTL'd Redis hash **field** (Decision 3); it is **never written to the RequestLog, `routing_reason`, or any log line** (Decision 5), so the durable record carries no hash of the prompt (invariant 8).

## Decision 2 — Language-neutral feature set + concrete scoring (no keyword matching)

`extractStructuralFeatures(ir): StructuralFeatures` computes, over the recent non-system window — **the last `RECENT_WINDOW = 6` messages ending at the final message** (so the latest turn is always included whether it is a `user` message or a terminal `role:'tool'` result), scanning at most `MAX_SCAN_CHARS = 32_000` to bound work (the size sub-score saturates at `SIZE_SAT = 8_000`, so a 4× cap loses **zero** classification fidelity while keeping the worst-case scan genuinely sub-millisecond):

- `effectiveInputChars` — Σ text chars in the window, **recursing into `ToolResultBlock.content`** (a large final tool result counts) (the size signal; baseline-subtracted below).
- `codeBlockChars` — chars inside fenced ```` ``` ```` spans (code is code in any language).
- `toolCount` — `ir.tools?.length ?? 0`.
- `toolSchemaDemand` — any tool carries a non-empty `parameters` object (the representable proxy for structured-output/JSON-schema demand; see Decision 7).
- `multimodalPresent` — any `type:'image'` block in the window (incl. inside tool results).
- `conversationDepth` — total message count.
- `maxOutputTokens` — `ir.params.maxOutputTokens ?? 0`.

All counts/sizes/flags — **no natural-language matching**, so a request routes identically regardless of human language (problem 2).

**Scoring (`classifyStructural`, pure).** Each feature → a saturating sub-score in `[0,1]` (`sat(x, S) = min(1, max(0, x) / S)`); every input is coerced to a finite non-negative number first (NaN/±∞/undefined/negative → 0):

| sub-score | formula | default saturation | weight |
|---|---|---|---|
| size | `sat(effectiveInputChars − (baseline?.ewma ?? 0), SIZE_SAT)` | `SIZE_SAT = 8000` | 0.30 |
| code | `sat(codeBlockChars, CODE_SAT)` | `CODE_SAT = 4000` | 0.20 |
| tools | `sat(toolCount, TOOLS_SAT)` | `TOOLS_SAT = 8` | 0.20 |
| schema | `toolSchemaDemand ? 1 : 0` | — | 0.10 |
| depth | `sat(conversationDepth, DEPTH_SAT)` | `DEPTH_SAT = 20` | 0.10 |
| multimodal | `multimodalPresent ? 1 : 0` | — | 0.05 |
| maxTokens | `sat(maxOutputTokens, MAXTOK_SAT)` | `MAXTOK_SAT = 4096` | 0.05 |

`score = Σ wᵢ·subᵢ ∈ [0,1]` (weights sum to 1). Band: `score ≥ HIGH → 'high'`, `score ≤ LOW → 'low'`, else `'ambiguous'`. Defaults `HIGH = 0.60`, `LOW = 0.25`, `BASELINE_ALPHA = 0.20`. The saturations are exported constants; the three thresholds/alpha **and the weights** are tunable (Decision 6 — thresholds/alpha as scalars, weights as one optional validated JSON override defaulting to the built-ins), satisfying §7.2's "expose thresholds/weights for power users". The loader **enforces `0 ≤ LOW < HIGH ≤ 1`** and normalizes/validates any weight override (each ≥0, positive sum) — fail-fast at boot — so bands can never overlap. Note the default weights cap the size sub-score at 0.30, so baseline subtraction alone can move a `high` to at most `ambiguous`, never to `low` (a deliberate conservatism: size alone never forces the top tier). `reasoning_effort` is omitted deliberately (Decision 7).

## Decision 3 — Per-agent baseline: in-process cache is the hot path; Redis is bounded, fail-fast shared backing

The baseline realizes "**learn a per-agent baseline; subtract anything constant across that agent's traffic**" — an **EWMA of `effectiveInputChars`** per `(tenant, agent, systemFingerprint)`. To keep the hot path network-free (sub-ms) yet correct across instances, without ever accumulating unbounded work or keys:

- **Read (hot path, synchronous, never awaits):** `StructuralBaselineStore.read(key)` returns the entry from a **bounded in-process LRU** (`MAX_BASELINE_ENTRIES = 10_000`, LRU-evicted). A local miss returns `null` (→ classify from raw features, no subtraction yet) **and** enqueues one coalesced cold-seed (a per-key dedup set collapses repeats). No `await`, no `Promise.race` on the request path — a down/slow Redis cannot stall or fail routing (invariant 1); the read is in-memory arithmetic (invariant 9).
- **Observe (after the decision, off the response path):** `observe(key, effectiveInputChars, alpha)` updates the **local** EWMA synchronously (so a single instance — the self-host default, spec §7.6 — learns immediately with no infra) and enqueues a **coalesced, throttled** Redis sync (at most one write per key per `OBSERVE_FLUSH_MS = 5_000`, since the local EWMA already holds the signal). Errors are swallowed; a dropped update is acceptable for a smoothing heuristic.
- **Dedicated fail-fast connection + total-work bound:** the store uses `REDIS_CLIENT.duplicate({ enableOfflineQueue: false, maxRetriesPerRequest: 1 })` so a disconnected Redis **rejects commands immediately** instead of buffering in ioredis's offline queue. The coalescing worker bounds **all transient state together** — pending cold-seeds, scheduled/throttled flushes, timers, and in-flight commands share one `MAX_BACKGROUND_ENTRIES = 4_096` budget, and **admission is rejected before any per-key state (dedup entry, timer) is allocated** when the budget is full (so unique-fingerprint floods can't grow process memory). A sustained-outage test submits **more than the cap with unique keys** and asserts every internal collection stays bounded — not merely that the request returned promptly.
- **Lifecycle:** the store owns its duplicate connection and worker, so it implements `OnApplicationShutdown` — cancel timers, clear queued state, and `disconnect()` the duplicate (the existing `RedisLifecycle` only closes the shared `REDIS_CLIENT`). Covered by a lifecycle test.
- **Hard cardinality bound:** baselines live in a **per-`(tenant, agent)` Redis HASH** `route:sbaseline:<userId>:<agentId|'-'>` with field = the HMAC `fpDigest`. The Lua write is atomic: EWMA the field, **refuse a new field once `HLEN ≥ MAX_FINGERPRINTS_PER_AGENT = 32`** (an over-cap fingerprint just gets no shared baseline — it still works locally from raw features), then `EXPIRE` the hash with the sliding `BASELINE_TTL = 2_592_000` (30 days). Cardinality is thus bounded by `users × agents × 32`, and a client rotating system prompts cannot exhaust Redis. Keys are **always tenant-scoped** (no global `anon`; a missing agent scopes to `-` under the user).

Cross-instance vs local EWMA may differ slightly (local sees one instance's traffic; a seed refresh overwrites local with the shared aggregate) — acceptable heuristic drift (invariant 10 is best-effort here, by design).

## Decision 4 — Band → tier via `auto_high` / `auto_low` RoutingRules (reuse #9, deterministic, inert in L0)

The classifier emits a **band**, not a tier; the tenant maps bands to destinations with two new `RoutingRule` match types:

- `RULE_MATCH_TYPES` (shared) gains `auto_high` and `auto_low`. Because #9's DTO validates `@IsIn(RULE_MATCH_TYPES)` and `assertTargetOwned`, these get CRUD + ownership-checked targets **for free**; `header_value` is irrelevant (only `header` requires it).
- They are **consumed only by Layer 1**. The Layer-0 resolver already ignores them (`resolveRoute` Phase 2 skips non-`header`, Phase 4 matches only `default`), so adding them changes nothing about explicit/header/default routing. (Verified against the current resolver.)
- **Deterministic selection:** the existing rule comparator (`priority` desc, `createdAt` asc, `id`) is currently private in `resolve.ts`; it is **exported and reused** so the band picks the highest-priority `auto_high`/`auto_low` rule **regardless of snapshot order** (the repository does not guarantee rule order). Ties resolve identically to Layer-0 rule selection.
- **Target semantics:** a `tier:<key>` target resolves through the exported `resolveTarget(snap, target, 'structural', reason)` to a full `RouteDecision` **carrying that tier's fallback chain** (§7.4 applies to every layer); a `model:<id>` target resolves to a **single-member chain (no fallback)** — identical semantics to a directly-named model, and a legitimate choice for a fixed cheap/strong model. No configured target, or an unresolvable/empty target → treated as ambiguous → Layer 0 `default`.

Trade-off: `auto_high`/`auto_low` overload `RoutingRule.match_type` with a *score-driven* (vs header-driven) semantics. Chosen over a new table because it is a size-M change, reuses validated CRUD + tenant scoping, needs no migration, and #20's dashboard can drive the same rows.

## Decision 5 — Integrate as an override of the `auto→default` fallthrough (Layer 0 explicit/header always win)

`StructuralRouter.decide(principal, agentId, ir, snapshot): Promise<RouteDecision | null>` orchestrates extract → local baseline read → classify → fire-and-forget observe → resolve band target, the **entire body wrapped in try/catch → `null`** (invariant 1). `ProxyService.prepare` calls it **only when** `ir.model === AUTO_ALIAS` **and** the Layer-0 `decision.decisionLayer === 'default'`:

- `model=auto` is the opt-in signal.
- `decisionLayer === 'default'` means Layer 0 found no explicit model and no `header`/custom-`header`-rule match — so an `x-polyrouter-tier` header (or a custom `header` rule) on an `auto` request still wins (its decision is `decisionLayer==='header'`, and structural is skipped). **Note:** a configured `default` *RoutingRule* also yields `decisionLayer==='default'`; structural therefore **overrides a plain `default` decision (rule or seeded tier) for a confident `auto` band** — this is intended (the user opted into smart routing for `auto`) and is stated in the spec delta and tested. An ambiguous band leaves the Layer-0 `default` decision (rule or tier) untouched.

A non-null result replaces the decision; the chain is rebuilt from `decision.chain` exactly as #12 does, so fallbacks, breaker, streaming commit boundary, and served-model recording all apply unchanged. `routing_reason` is a **typed serialization of the band + numeric sub-scores only** (no raw text, no fingerprint), e.g. `structural:high score=0.71 size=0.90 code=0.50 tools=1.00 depth=0.20` — satisfying the transparency DoD and invariant 8.

## Decision 6 — Gating and the degradation matrix

`ROUTING_AUTO_LAYERS` (comma list, `routing` config namespace, registered in the #1 fail-fast schema) is parsed to a set; `structural` present ⇒ Layer 1 active for `auto`. **Default `structural`** — the §7.6 "honest default" (ship L0 + L1) — but *inert until the tenant configures `auto_high`/`auto_low`*, so landing this change is behavior-preserving for existing `auto` traffic (still `default`) until a target is set. Empty (`ROUTING_AUTO_LAYERS=`) hard-disables all smart layers ⇒ `auto` = pure Layer 0. #14 later adds `cascade`. The other knobs (§7.2 "expose thresholds/weights"): `ROUTING_STRUCTURAL_HIGH_THRESHOLD`, `ROUTING_STRUCTURAL_LOW_THRESHOLD`, `ROUTING_STRUCTURAL_BASELINE_ALPHA` (scalars), and `ROUTING_STRUCTURAL_WEIGHTS` (an optional JSON object overriding per-feature weights, default = the built-ins). The loader fails fast at boot unless: `0 ≤ LOW < HIGH ≤ 1`; `0 < BASELINE_ALPHA ≤ 1`; and any `ROUTING_STRUCTURAL_WEIGHTS` override has only **known feature keys**, every value **finite and ≥ 0**, a **positive finite sum**, and a finite normalized result (rejecting NaN/±∞ — e.g. `{"size":1e309}` → `Infinity` → reject).

Every branch degrades to the Layer-0 `default` decision — the request always succeeds via the reliable core, with no network on the hot path:

| Condition | Outcome |
|---|---|
| `structural` not in `ROUTING_AUTO_LAYERS` | `StructuralRouter` not consulted → Layer 0 `default` |
| request model ≠ `auto`, or L0 already chose header/explicit | structural skipped → Layer 0 decision stands |
| no `auto_high`/`auto_low` rule, or its target empty/unresolvable | `decide` → `null` → Layer 0 `default` |
| Redis baseline unavailable / slow | local cache read (null on cold miss) → classify from raw features; **no await, no stall** |
| feature extraction / classification throws | caught → `null` → Layer 0 `default` |
| band is `ambiguous` | `null` → Layer 0 `default` |

## Decision 7 — Representable signals now; richer signals are a scoped, declared follow-up

Spec §7.2 lists "structured-output demand (JSON schema present)" and "reasoning flags" among the *eventual* L1 features. The `Normalized*` IR (#5) models neither a `response_format` nor a `reasoning_effort` field, and adding them is a **translation-contract change** (new IR fields + both `requestIn` parsers **and** `requestOut` emitters — omitting the round-trip would silently break structured-output/reasoning on the actual upstream call, a separate defect from routing). Per CLAUDE.md's "small, single-capability changes" rule, that belongs in its own slice, not bundled into this size-M routing change. So this change **declares its scope**: it ships the language-neutral structural classifier over the representable feature subset, using `toolSchemaDemand` (a tool with a non-empty parameter schema) as the structured-output proxy and **deferring `reasoning_effort`** and native `response_format` to a fast-follow that widens the IR. This mirrors how the spec itself tiers routing (L1 now; L2/L3 and richer signals later) — it is an explicit, delta-surfaced scope boundary, not a silent gap, and the two extra sub-scores drop in additively once the IR carries the fields. (At implementation, if the IR already surfaces `response_format`, the schema sub-score prefers it.)

## Risks / trade-offs

- **`match_type` overload** — mitigated by L0-inertness (verified) + reuse of validated CRUD.
- **Eventual-consistency baseline** — local-first read means a cold instance has no subtraction for the first request of a `(tenant,agent,fingerprint)`; acceptable (falls to raw features, still routes).
- **Heuristic thresholds** — concrete defaults given; exposed as env knobs; the learned baseline adapts the dominant size signal without tuning; cascade (#14) later turns hard prediction into easier detection.
- **Default-on for `auto`** — harmless without configured targets; a tenant preferring #10 behavior sets `ROUTING_AUTO_LAYERS=`.
