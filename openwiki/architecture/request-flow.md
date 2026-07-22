---
type: Architecture
title: Request Flow
description: The complete lifecycle of an LLM request through polyrouter — from ingress through budget enforcement, routing resolution, protocol translation, provider execution, and cost recording.
tags: [request-flow, proxy, routing, lifecycle]
resource: packages/control-plane/src/proxy/proxy.service.ts
---

# Request Flow

Every request to polyrouter follows a deterministic pipeline. Understanding this flow is essential for debugging, extending the proxy, or adding new providers.

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
④ Route Resolution ─── Layer 0 → Layer 1 → Layer 2 (optional) → Layer 3
    │                     Produces RouteDecision (tier + entry chain)
    ▼
⑤ Build Provider Chain ─── ChainAttempt[] with lazy adapter construction
    │
    ▼
⑥ Execute Chain ─── Walk chain with circuit breaker protection
    │                 First successful event = committed (no swap)
    ▼
⑦ Protocol Translation ─── NormalizedResponse/Stream → client's wire format
    │
    ▼
⑧ Record & Observe ─── Append request_log, emit metrics, fire notifications
    │
    ▼
Response to Client
```

## Step-by-Step Detail

### ① Authentication

The agent key guard (`agent-key.guard.ts`) intercepts requests to `/v1/**`. It:

1. Extracts the `Authorization: Bearer poly_...` header (or `x-api-key` for Anthropic format)
2. Looks up the agent by HMAC hash prefix (fast index scan, not full-table)
3. Validates the full HMAC-SHA256 signature
4. Attaches the authenticated principal to the request context

See [Security & Auth](/openwiki/security/auth.md) for the dual auth model.

### ② Budget Enforcement

Before any routing work, the proxy service checks block budgets:

```typescript
async enforceBudgets(owner: string, agentId: string): Promise<void>
```

- Reads Redis spend counters (fail-fast, 50ms timeout)
- If a block budget is exceeded, returns 429 with `retry-after` header
- **Fail-open by default** — if Redis is unavailable, the request proceeds
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
  stream?: boolean;
}
```

The IR is protocol-agnostic — it uses content blocks everywhere, normalizes tool results into individual messages, and carries malformed tool args as `inputRaw: string` without throwing.

See [Provider Adapters](/openwiki/providers/adapters.md) for translation details.

### ④ Route Resolution

The routing engine resolves which provider/model to use. This is a layered pipeline:

1. **Layer 0** (always on) — explicit routing from model field, tier headers, default rules
2. **Layer 1** (opt-in) — structural classification based on request features
3. **Layer 2** (opt-in, requires ONNX model) — semantic embedding classification using cosine similarity against learned or bundled centroids; see [Routing Engine](/openwiki/routing/engine.md#layer-2--semantic-embedding-classification)
4. **Layer 3** (opt-in) — cascade routing with cheap-first escalation

The output is a `RouteDecision` containing the target tier and ordered entry chain.

See [Routing Engine](/openwiki/routing/engine.md) for the full routing logic.

### ⑤ Build Provider Chain

The resolved entries are converted into `ChainAttempt[]`:

```typescript
interface ChainAttempt {
  entry: RouteEntry;
  adapter: ProviderAdapter; // lazily constructed
  breaker: CircuitBreaker;
}
```

Each attempt gets its own circuit breaker instance and adapter. Adapters are constructed lazily to avoid decrypting credentials for providers that won't be tried.

### ⑥ Execute Chain

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

**Commit boundary**: The first successful stream event locks the provider. After commitment, mid-stream failures produce a terminal error frame rather than attempting fallback. This prevents jarring model swaps mid-response.

**Caller abort handling**: If the client disconnects, the error is classified as `CallCancelledError` — breaker-neutral, not counted as a provider failure.

### ⑦ Protocol Translation

The response (or stream events) is translated from the IR back to the client's wire format:

- **Buffered**: `NormalizedResponse` → OpenAI or Anthropic JSON
- **Streaming**: `NormalizedStreamEvent` generator → SSE frames in the target protocol

Key translation challenges:
- **Tool results**: IR uses separate `role:'tool'` messages; Anthropic groups them in one `user` message
- **Usage tokens**: Anthropic excludes cache tokens from input; OpenAI includes them
- **Reasoning/thinking**: Tagged with source protocol, emitted only back to owning protocol

### ⑧ Record & Observe

After the response completes:

1. **Request log** — immutable record with snapshotted prices, token counts, latency, routing decision
2. **Request attempts** — per-attempt cost ledger for cascade escalations
3. **Metrics** — `polyrouter_requests_total`, `polyrouter_tokens_total`, `polyrouter_cost_microusd_total`, `polyrouter_upstream_duration_seconds`
4. **Notifications** — if the request triggered a budget alert or provider-down event, fire-and-forget via BullMQ

Recording is enqueue-based — the request path enqueues metadata, and a background writer batch-inserts to PostgreSQL.

## Error Mapping

| Error Kind | HTTP Status | Fallback Eligible |
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

## Stream Error Handling

Mid-stream failures (after commit) inject a **terminal error frame** into the SSE stream in the client's expected protocol format. This preserves stream structure so clients can parse the error without custom handling.

## Source References

| Component | Primary File |
|-----------|-------------|
| Orchestration | `packages/control-plane/src/proxy/proxy.service.ts` |
| Proxy core | `packages/data-plane/src/proxy/core.ts` |
| Route resolution | `packages/data-plane/src/routing/resolve.ts` |
| Auth guard | `packages/control-plane/src/auth/agent-key.guard.ts` |
| Budget service | `packages/control-plane/src/budgets/budget-service.ts` |
| Recording | `packages/control-plane/src/recording/request-recorder.ts` |
| Metrics | `packages/control-plane/src/observability/proxy-metrics.ts` |
