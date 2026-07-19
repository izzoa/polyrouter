---
type: Architecture
title: Provider Adapters & Protocol Translation
description: Polyrouter's provider adapter interface, supported LLM providers (OpenAI, Anthropic, ChatGPT Responses, custom, local, subscription OAuth), protocol translation via intermediate representation, and circuit breaker integration.
tags: [providers, adapters, protocol-translation, circuit-breaker, ssrf, oauth]
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
| `api_key` | Bearer token / `x-api-key` | `/chat/completions`, `/v1/messages`, `/models` | OpenAI, Anthropic, or any compatible API |
| `subscription` | OAuth Bearer + preset headers | Pinned by preset | Claude Pro/Max, ChatGPT Plus/Pro — see [Subscription OAuth](/openwiki/providers/subscription-oauth.md) |
| `custom` | Configurable | User-defined | Any OpenAI-compatible API |
| `local` | None | Configurable | Loopback-only, SSRF guard relaxed |

Provider credentials are encrypted at rest with AES-256-GCM and decrypted only at call time.

**Source**: `packages/data-plane/src/providers/` — adapter implementations

### Auth Schemes

Adapters receive an `AuthScheme` with the resolved credential:

- `api_key` — Anthropic sends `x-api-key`; OpenAI sends `Authorization: Bearer` (byte-identical to pre-OAuth behavior)
- `oauth_bearer` — Anthropic sends `Authorization: Bearer` + the preset's `anthropic-beta` value and **no** `x-api-key`; OpenAI-Responses sends `Authorization: Bearer` + `chatgpt-account-id` + the Responses beta header

Credential resolution for `subscription` providers (decrypt → envelope parse → refresh) is handled by the control plane's [Subscription OAuth](/openwiki/providers/subscription-oauth.md#token-refresh--rotation-safety) seam before adapter construction.

**Source**: `packages/data-plane/src/providers/oauth-scheme.spec.ts`, `packages/data-plane/src/providers/anthropic-adapter.ts`

## Shared HTTP Adapter

The `http-adapter.ts` module provides shared transport for all HTTP-based providers:

- **SSRF protection** — every outbound URL validated through `createGuardedHttpClient`
- **First-byte timeout** — 30s default, configurable per provider
- **Inter-event timeout** — detects stalled streams
- **Byte cap** — 10 MiB max on buffered responses
- **Pagination** — handles Anthropic's `has_more` + `last_id` cursor pagination for model lists
- **Response bounds** — caps untrusted provider responses to prevent memory exhaustion

**Source**: `packages/data-plane/src/providers/http-adapter.ts`

### Provider-Listed Pricing (Display Only)

OpenRouter-style `/models` responses carry a per-model `pricing` extension (per-token USD decimal strings). `parseModelList` surfaces these as a per-1M USD **display estimate** stored in the model row's `listed_*` columns — distinct from billing prices, which always come from the bundled catalog or user edits (cost immutability invariant). The dashboard shows listed prices as an `estimated` fallback when no billing price is known, and users can edit model prices directly. Listed prices are rewritten on every catalog sync and cleared when a provider's base URL or protocol changes.

**Source**: `packages/data-plane/src/providers/listed-pricing.spec.ts`, `packages/control-plane/src/providers/providers.service.ts` (`listedColumnsFrom`)

### OpenRouter Attribution

Requests to `openrouter.ai`-hosted providers carry polyrouter's identity headers — `HTTP-Referer: https://polyrouter.app` and `X-OpenRouter-Title: polyrouter` — so polyrouter appears in OpenRouter's app attribution. The host gate matches only the exact `openrouter.ai` host (case, explicit port, and trailing-FQDN-dot tolerant; subdomains and spoofed suffixes excluded). Identity is disclosed only to OpenRouter; auth is never affected.

**Source**: `packages/data-plane/src/providers/http-adapter.ts` (`openRouterAttributionHeaders`), `packages/data-plane/src/providers/attribution.spec.ts`

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

- **OpenAI** (`openai-adapter.ts`) — Chat Completions format with SSE streaming
- **Anthropic** (`anthropic-adapter.ts`) — Messages format with tool-result grouping and cache control
- **OpenAI Responses** (`responses-adapter.ts`) — ChatGPT backend's Responses API (`/backend-api/codex/responses`), OAuth-only. The backend accepts **only streaming** requests, so `chat()` folds the SSE event stream into a buffered `NormalizedResponse`. There is no models endpoint: `listModels()` rejects typed and `testConnection()` probes the preset's trusted `probeModel`. Exactly three identity headers are sent — Bearer, `chatgpt-account-id`, and `responses=experimental` — never `x-api-key` or client fingerprints (no-spoofing rule). `max_output_tokens` and sampling params are dropped (the backend rejects them).

**Source**: `packages/data-plane/src/providers/responses-adapter.ts`, `packages/data-plane/src/proxy/translate/responses.ts`

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
