---
type: Architecture
title: Provider Adapters & Protocol Translation
description: Polyrouter's provider adapter interface, supported LLM providers (OpenAI, Anthropic, custom, local), protocol translation via intermediate representation, and circuit breaker integration.
tags: [providers, adapters, protocol-translation, circuit-breaker, ssrf]
resource: packages/data-plane/src/providers/adapter.ts
---

# Provider Adapters & Protocol Translation

Polyrouter communicates with LLM providers through a unified adapter interface. Protocol translation normalizes requests and responses between OpenAI and Anthropic wire formats using an intermediate representation (IR).

## Provider Adapter Interface

All providers implement the same interface:

```typescript
interface ProviderAdapter {
  chat(request: NormalizedRequest): Promise<NormalizedResponse>;
  chatStream(request: NormalizedRequest): AsyncGenerator<NormalizedStreamEvent>;
  listModels(): Promise<ProviderModelInfo[]>;
  testConnection(): Promise<ConnectionResult>;
}
```

This abstraction allows the proxy core to be protocol-agnostic — it works entirely with normalized types.

## Supported Providers

| Provider Kind | Auth Method | Endpoint Format | Notes |
|---------------|------------|-----------------|-------|
| `openai` | Bearer token | `/chat/completions`, `/models` | Also supports OpenAI-compatible APIs |
| `anthropic` | `x-api-key` header | `/v1/messages`, `/v1/models` | Cursor-paginated model list |
| `custom` | Configurable | User-defined | Any OpenAI-compatible API |
| `local` | None | Configurable | Loopback-only, SSRF guard relaxed |

Provider credentials are encrypted at rest with AES-256-GCM and decrypted only at call time.

**Source**: `packages/data-plane/src/providers/` — adapter implementations

## Shared HTTP Adapter

The `http-adapter.ts` module provides shared transport for all HTTP-based providers:

- **SSRF protection** — every outbound URL validated through `createGuardedHttpClient`
- **First-byte timeout** — 30s default, configurable per provider
- **Inter-event timeout** — detects stalled streams
- **Byte cap** — 10 MiB max on buffered responses
- **Pagination** — handles Anthropic's `has_more` + `last_id` cursor pagination for model lists
- **Response bounds** — caps untrusted provider responses to prevent memory exhaustion

**Source**: `packages/data-plane/src/providers/http-adapter.ts`

## Protocol Translation

### Intermediate Representation (IR)

The IR is the canonical shape for all requests and responses:

```typescript
// Request
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

// Response
interface NormalizedResponse {
  content: ContentBlock[];
  stopReason: NormalizedStopReason;
  usage: NormalizedUsage;
  model: string;
}
```

The IR uses **content blocks everywhere** — text, images, tool use, and tool results are all typed blocks.

**Source**: `packages/data-plane/src/proxy/translate/ir.ts`

### Translation Challenges

| Challenge | Solution |
|-----------|----------|
| **Tool results grouping** | Anthropic groups all `tool_result` in one `user` message; IR models each as separate `role:'tool'` message |
| **Usage token differences** | Anthropic excludes cache tokens from input; IR stores uncached components; adapters convert by formula |
| **Malformed tool args** | Carried as `inputRaw: string` + `inputParseError: true` (never throws on model output) |
| **Prompt caching** | Anthropic's `cache_control: {type: 'ephemeral'}` carried opaquely; dropped when crossing to OpenAI |
| **Reasoning/thinking** | Tagged with source protocol; emitted only back to the owning protocol |

### Wire Format Adapters

- **OpenAI** (`openai.ts`) — Chat Completions format with SSE streaming
- **Anthropic** (`anthropic.ts`) — Messages format with tool-result grouping and cache control

### Golden Tests

Protocol translation is verified with recorded wire-format fixtures:

```
packages/data-plane/src/proxy/translate/golden/
├── anthropic/    # Anthropic wire format examples
├── openai/       # OpenAI wire format examples
└── README.md     # Test documentation
```

Tests verify round-trip fidelity: `requestIn(requestOut(ir))` must preserve semantics.

## Circuit Breaker

Each provider has a Redis-backed circuit breaker protecting against cascading failures:

### State Machine

```
closed ──(failures ≥ threshold)──▶ open ──(cooldown expires)──▶ half_open
  ▲                                                                │
  │                           success ──▶ closed                    │
  │                                                                │
  └──(failure in half_open)── open ◀──(trip)──────────────────────┘
```

### Configuration

```typescript
{
  threshold: 5,          // failures before opening
  cooldownMs: 30_000,    // how long to stay open
  probeLeaseMs: 10_000,  // half-open probe window
  stateTtlMs: 300_000,   // Redis key TTL
}
```

### Redis Atomicity

State transitions use Lua scripts for atomicity:
- `decide()` — check state and admit/reject
- `complete()` — record outcome (success/failure)
- `renew()` — refresh probe lease

Server clock via Redis `TIME` command eliminates instance wall-clock skew. An in-memory store serves as fallback if Redis is unavailable.

### Metrics

- `polyrouter_breaker_state` — gauge (0=closed, 1=half_open, 2=open)
- `polyrouter_breaker_opens_total` — counter by provider
- `polyrouter_breaker_store_faults_total` — Redis degradation counter

**Source**: `packages/data-plane/src/breaker/breaker.ts`, `packages/control-plane/src/proxy/breaker-observability.ts`

## SSRF Protection

All outbound HTTP requests pass through SSRF protection:

- **URL validation** — `assertUrlSafe()` checks provider base URLs
- **IP classification** — blocks private, loopback, link-local, and metadata ranges
- **DNS rebinding defense** — resolved IP validated at connect time
- **Mode-gated exception** — loopback allowed only for `local` provider kind in self-host mode

**Source**: `packages/shared/src/server/security/ssrf.ts`, `packages/shared/src/server/security/network-host.ts`
