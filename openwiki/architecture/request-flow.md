---
type: Architecture
title: Request Flow
description: The complete lifecycle of an LLM request through polyrouter — from ingress through auth, budget enforcement, Layer 0/1/2/3 routing resolution, protocol translation, provider execution, decision-trail telemetry, cost recording, and (for the L2-ambiguous slice) hot-path learning evidence contribution.
tags: [request-flow, proxy, routing, lifecycle, semantic, cascade]
resource: packages/control-plane/src/proxy/proxy.service.ts
---

# Request Flow

Every request to polyrouter follows a deterministic pipeline. The smart layers are layered — Layer 0 is always on, Layer 1 (structural), Layer 2 (semantic, opt-in), and Layer 3 (cascade) each consume the previous layer's ambiguity signal. Understanding this flow is essential for debugging, extending the proxy, or adding new providers.

## Pipeline Overview

```
Client Request (OpenAI or Anthropic format)
    │
    ▼
① Auth Guard ─── Validate API key (HMAC prefix lookup)
    │
    ▼
② Budget Gate ─── Check Redis spend counters against block budgets
    │
    ▼
③ Parse & Normalize ─── ProviderAdapter.parseRequest() → NormalizedRequest (IR)
    │
    ▼
④ Layer 0 Route Resolution ─── model field → tier header → header rules → default
    │                              Produces RouteDecision (tier + entry chain)
    ▼
⑤ Smart Layers (only when model="auto" AND decision fell through to default)
    │  ┌─ Layer 1 Structural ──► high | low | ambiguous
    │  │   (only ambiguous?)
    │  └─ Layer 2 Semantic ──────► high | low | ambiguous (routing reason trail appended)
    │      (only ambiguous?)
    └─ Layer 3 Cascade ──────────► cheap tier → quality gate → escalate
    │
    ▼
⑥ Build Provider Chain ─── ChainAttempt[] with lazy adapter construction
    │
    ▼
⑦ Execute Chain ─── Walk chain with circuit breaker protection
    │                 First successful event = committed (no swap)
    ▼
⑧ Protocol Translation ─── NormalizedResponse/Stream → client's wire format
    │
    ▼
⑨ Record & Observe ─── Append request_log + request_attempt, emit metrics,
    │                   cascade-settle evidence contribution (L2-ambiguous slice)
    │
    ▼
Response to Client
```

## Step-by-Step Detail

### ① Authentication

The agent key guard intercepts requests to `/v1/**`. It:

1. Extracts the `Authorization: Bearer poly_...` header (or `x-api-key` for Anthropic format)
2. Looks up the agent by HMAC hash prefix (indexed column, O(1) candidate resolution)
3. Validates the full HMAC-SHA256 signature against `api_key_hash`
4. Attaches the authenticated principal to the request context

Disabled users are denied on **both** planes (session + agent key) and cannot mint new sessions. See [Security & Auth](/openwiki/security/auth.md) for the dual auth model.

### ② Budget Enforcement

Before any routing work, the proxy service checks block budgets:

```typescript
async enforceBudgets(owner: string, agentId: string): Promise<void>
```

- Reads Redis spend counters (fail-fast, 50ms timeout)
- If a block budget is exceeded, returns 429 with `retry-after` header
- **Fail-open by default** — if Redis is unavailable, the request proceeds (`BUDGET_FAIL_OPEN=true`); set `false` for a hard cap that returns 503
- Budget enforcement faults are counted by `polyrouter_budget_enforcement_faults_total`

### ③ Parse & Normalize

The request body is parsed into the **Intermediate Representation (IR)**:

```typescript
interface NormalizedRequest {
  model: string;
  system?: ContentBlock[];
  messages: NormalizedMessage[];
  tools?: NormalizedTool[];
  toolChoice?: NormalizedToolChoice;
  params: NormalizedParams;
  responseFormat?: unknown;
  reasoning?: ReasoningControl;
  stream?: boolean;
}
```

The IR is protocol-agnostic — it uses content blocks everywhere, normalizes tool results into individual messages, and carries malformed tool args as `inputRaw: string` without throwing. See [Provider Adapters](/openwiki/providers/adapters.md) for translation details.

### ④ Layer 0 Route Resolution

A pure function over the routing snapshot (`packages/data-plane/src/routing/resolve.ts`). It checks, in order:

1. **Model field** — three patterns: direct model ID (`gpt-4o`), provider-prefixed (`p1:gpt-4o`), tier name (`fast`).
2. **Tier header** (`x-polyrouter-tier`) — has structural precedence over other header rules. Resolves against remap rules first, then direct tier lookup. The matched header is recorded (`request_log.routing_header_name` / `_value`).
3. **Other header rules** — priority order, first match wins.
4. **Default rule** — the system's default routing rule.
5. **Default tier** — the guaranteed catch-all.

Output: `RouteDecision` containing the target tier and ordered entry chain.

See [Routing Engine](/openwiki/routing/engine.md) for the full Layer 0 logic.

### ⑤ Smart Layers (L1 → L2 → L3)

Smart layers run **only when** `ir.model === "auto"` AND the Layer 0 decision fell through to the `default` tier. Each layer either decides, defers, or degrades; together they form the **decision trail** persisted to the request log.

Effective layers are computed from `(instance capability) ∧ (tenant preference)`:

- Instance capability = boot-resolved `ROUTING_AUTO_LAYERS` token set, masked for Layer 2 by `SemanticClassifierService.available` (the WHOLE classifier ready — embedder + centroids, not merely the flag)
- Tenant preference = per-tenant `routing_settings` row, default-on when unset

A 1s read deadline protects the request from a hang on the settings read; on timeout we fall back to the raw capability (invariant 1).

#### ⑤a — Layer 1 Structural

Per-tenant calibrated thresholds are resolved from the **same** settings read (no extra I/O). The structural router extracts language-neutral features (size, code, tools, schema, depth, multimodal, `maxTokens`), applies an EMA baseline per-agent (so a harness system prompt that dwarfs the user message can't force everything into the top tier), and emits one of:

| Band | Action |
|------|--------|
| `high` | Routes to `auto_high`; **Layer 2 is skipped** (L1 is decisive) |
| `low` | Routes to `auto_low`; **Layer 2 is skipped** |
| `ambiguous` | Hand to Layer 2 (then Layer 3 if still ambiguous) |

**Telemetry**: the verdict is recorded on every evaluated row via `structural_band`/`structural_score`/`structural_dimension`/`structural_reason`, even when the row falls through to cascade (no silent telemetry).

#### ⑤b — Layer 2 Semantic (opt-in)

Layer 2 refines **only** the L1-ambiguous slice. It never re-evaluates an L1-confident band. The sequence:

1. **Extract** request text through the canonical extractor (`extractSemanticInput`) — newest user turn first, bounded by `totalChars`/`perMessage`/`perBlock` caps; system content excluded; a request with no non-system evidence renders to `''` and the router skips.
2. **Embed** the text under a per-call deadline (`SEMANTIC_TIMEOUT_MS`); the embedder has bounded concurrency (`SEMANTIC_CONCURRENCY`); saturation → `EmbedError('saturated')` → skip.
3. **Resolve classification source** — bundled centroids decorated with per-tenant learned state under read-time gates (`enabled ∧ (epoch, generation, revision) match`). Any failure, Redis fault, or stale state → fall back to bundled, never skip.
4. **Classify** — `classifySemantic(vector, centroids, {high, low})` returns `{ kind: 'band' | 'invalid' }`. `invalid` (zero-norm, dim mismatch, non-finite) is a discriminated fault — no band, no telemetry.
5. **Decide** —

| Outcome | Verdict carried? | Action |
|---------|------------------|--------|
| `high` band, target resolves | yes | Routes to `auto_high`, `decision_layer = 'semantic'`; never cascades |
| `low` band, target resolves | yes | Routes to `auto_low`, `decision_layer = 'semantic'`; never cascades |
| Confident band but target empty/missing | yes | Verdict recorded; falls through to Layer 0 default (does **not** cascade — mirrors L1's unroutable) |
| `ambiguous` band | yes | Hands to Layer 3 cascade; **carries the in-memory vector + decision-time learning gate to the recorder** for evidence contribution at cascade-settle |
| `invalid` / fault / unavailable | no | Hands to cascade (or Layer 0 default) |

Any L2 fault — embed timeout, saturation, abort, classifier unavailable, Redis fault on learned reads, `invalid` classification — yields exactly the same L1-ambiguous flow as if L2 were disabled. The smart path never fails or stalls a request.

**Decision trail**: the Layer 1 reason is appended first, then the Layer 2 reason (`semantic:low s=-0.1845 hi=0.3021 lo=0.4866 src=bundled`). `request_log.routing_reason` carries the ordered trail; the four L2 telemetry columns are written atomically (all-or-none DB check).

See [Semantic Stack](/openwiki/architecture/semantic-stack.md) for the embedder, bundle contract, classifier, and learning loop design.

#### ⑤c — Layer 3 Cascade

Cascade runs when Layer 1 was `ambiguous` AND Layer 2 was also `ambiguous`/`skip`/unroutable. It:

1. Tries the cheap tier (`auto_low`) under a bounded timeout (`ROUTING_CASCADE_CHEAP_TIMEOUT_MS`)
2. Evaluates quality — binary 0/1 score (no embedding model, no generative LLM)
3. On quality-pass: replays the buffered response
4. On quality-fail: escalates to the strong tier (`auto_high`), which is followed by the **default tier chain** so a down strong tier still rescues to the reliable core
5. Records each attempt in `request_attempt` (cascade cost ledger) and triggers an L2 learning-evidence contribution when the request started in the L2-ambiguous slice

The cascade commit rule follows the same commit boundary as the main proxy: once the first token is sent to the client, the model is locked.

### ⑥ Build Provider Chain

The resolved entries are converted into `ChainAttempt[]`:

```typescript
interface ChainAttempt {
  entry: RouteEntry;
  adapter: ProviderAdapter; // lazily constructed
  breaker: CircuitBreaker;
}
```

Each attempt gets its own circuit breaker instance and adapter. Adapters are constructed lazily to avoid decrypting credentials for providers that won't be tried. Per-chain-member metadata (`AttemptMeta`) is built in parallel for recording.

### ⑦ Execute Chain

The proxy walks the chain with circuit breaker protection:

```
For each attempt in chain:
  ┌─ Breaker state = closed? ──yes──▶ Execute request
  │                                    │
  │                              success? ──yes──▶ COMMIT (no swap after this)
  │                                    │
  │                              failure? ──yes──▶ Classify error
  │                                    │              │
  │                              shouldFallback(kind)? ──yes──▶ Next attempt
  │                                    │              │
  │                                    │              no──▶ Return error to client
  │                                    │
  └─ Breaker state = open? ──yes──▶ Skip (count skip)
```

**Commit boundary**: The first successful stream event locks the provider. After commitment, mid-stream failures produce a **terminal error frame** rather than attempting fallback — preserves stream structure so clients can parse without custom handling.

**Caller abort handling**: If the client disconnects, the error is classified as `CallCancelledError` — breaker-neutral, not counted as a provider failure.

### ⑧ Protocol Translation

The response (or stream events) is translated from the IR back to the client's wire format:

- **Buffered**: `NormalizedResponse` → OpenAI or Anthropic JSON
- **Streaming**: `NormalizedStreamEvent` generator → SSE frames in the target protocol

Key translation challenges:

- **Tool results**: IR uses separate `role:'tool'` messages; Anthropic groups them in one `user` message
- **Usage tokens**: Anthropic excludes cache tokens from input; OpenAI includes them
- **Reasoning/thinking**: Tagged with source protocol, emitted only back to the owning protocol
- **`max_tokens_spelling`**: per-provider outgoing field name — `auto` defaults to `max_tokens` for `local` providers and `max_completion_tokens` for everything else; OpenAI o-series / reasoning models require the latter, local/legacy gateways accept only the former

### ⑨ Record & Observe

After the response completes (or fails):

1. **Request log** — immutable record with snapshotted prices, token counts, latency, full routing decision (`decision_layer` + ordered `routing_reason`), and (when applicable) the L2 telemetry quartet
2. **Request attempts** — per-attempt cost ledger for cascade escalations
3. **Metrics** — `polyrouter_requests_total`, `polyrouter_tokens_total`, `polyrouter_cost_microusd_total`, `polyrouter_upstream_duration_seconds`, `polyrouter_breaker_*`, `polyrouter_budget_enforcement_faults_total`
4. **Notifications** — if the request triggered a budget alert or provider-down event, fire-and-forget via BullMQ
5. **L2 learning-evidence contribution** — for the L2-ambiguous slice only: the recorder hands the in-memory vector + decision-time learning gate to the `LearningContributionModule` once the cascade settles; the vector is added to a bounded volatile cohort and dropped after contribution. Only a sum over ≥ `MIN_COHORT` embeddings ever reaches Redis.

Recording is enqueue-based — the request path enqueues metadata, and a background writer batch-inserts to PostgreSQL.

## Error Mapping

| Error kind | HTTP status | Fallback eligible |
|------------|-------------|-------------------|
| `unknown_model` | 404 | No |
| `ambiguous_model` | 404 | No |
| `empty_tier` | 400 | No |
| `auth` (upstream) | 502 | Yes |
| `rate_limit` | 429 | Yes |
| `unavailable` | 503 | Yes |
| `bad_request` | 400 | No |
| `budgetBlocked` | 429 | No |
| `budgetEnforcementUnavailable` | 503 | No |
| `provider_credential_required` | 503 | Yes (config-driven) |

## Stream Error Handling

Mid-stream failures (after commit) inject a **terminal error frame** into the SSE stream in the client's expected protocol format. This preserves stream structure so clients can parse the error without custom handling.

## Source References

| Component | Primary file |
|-----------|--------------|
| Orchestration | `packages/control-plane/src/proxy/proxy.service.ts` |
| Proxy core | `packages/data-plane/src/proxy/core.ts` |
| Route resolution | `packages/data-plane/src/routing/resolve.ts` |
| Structural router | `packages/control-plane/src/proxy/structural/structural-router.ts` |
| Cascade router | `packages/control-plane/src/proxy/cascade/cascade-router.ts` |
| Semantic router | `packages/control-plane/src/semantic/semantic-router.ts` |
| Classifier | `packages/control-plane/src/semantic/semantic-classifier.service.ts` |
| Embedder runtime | `packages/control-plane/src/semantic/semantic-runtime.service.ts` |
| Auth guard | `packages/control-plane/src/auth/agent-key.guard.ts` |
| Budget service | `packages/control-plane/src/budgets/budget-service.ts` |
| Recording | `packages/control-plane/src/recording/request-recorder.ts` |
| Learning contributor | `packages/control-plane/src/semantic/semantic-learning-contributor.ts` |
| Metrics | `packages/control-plane/src/observability/proxy-metrics.ts` |