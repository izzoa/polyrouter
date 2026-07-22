---
type: Architecture
title: Provider Adapters & Protocol Translation
description: Polyrouter's provider adapter interface, supported LLM providers (OpenAI, Anthropic, ChatGPT Responses, custom, local, subscription OAuth), protocol translation via intermediate representation, circuit breaker integration, per-provider max-tokens spelling, listed pricing, attribution headers, and SSRF-protected HTTP transport.
tags: [providers, adapters, protocol-translation, circuit-breaker, ssrf, oauth, max-tokens]
resource: packages/data-plane/src/providers/adapter.ts
---

# Provider Adapters & Protocol Translation

Polyrouter communicates with LLM providers through a unified adapter interface. Protocol translation normalizes requests and responses between OpenAI and Anthropic wire formats using an intermediate representation (IR). Every adapter shares a single HTTP transport with built-in SSRF protection, response bounds, and idle/connect timeouts.

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

This abstraction allows the proxy core to be protocol-agnostic — it works entirely with normalized types. Adapters are constructed lazily per chain attempt so credentials for unused providers are never decrypted.

## Supported Providers

| Provider kind | Auth method | Endpoint format | Notes |
|---------------|------------|-----------------|-------|
| `api_key` | Bearer token / `x-api-key` | `/chat/completions`, `/v1/messages`, `/models` | OpenAI, Anthropic, or any compatible API |
| `subscription` | OAuth Bearer + preset headers | Pinned by preset | Claude Pro/Max, ChatGPT Plus/Pro — see [Subscription OAuth](/openwiki/providers/subscription-oauth.md) |
| `custom` | Configurable | User-defined | Any OpenAI-compatible API |
| `local` | None | Configurable | Loopback-only, SSRF guard relaxed (`MODE=selfhosted`) |

Provider credentials are encrypted at rest with AES-256-GCM and decrypted only at call time (see [Security & Auth](/openwiki/security/auth.md#credential-envelope)).

### Auth Schemes

Adapters receive an `AuthScheme` with the resolved credential:

- `api_key` — Anthropic sends `x-api-key`; OpenAI sends `Authorization: Bearer` (byte-identical to pre-OAuth behavior)
- `oauth_bearer` — Anthropic sends `Authorization: Bearer` + the preset's `anthropic-beta` value and **no** `x-api-key`; OpenAI-Responses sends `Authorization: Bearer` + `chatgpt-account-id` + the Responses beta header

Credential resolution for `subscription` providers (decrypt → envelope parse → refresh) is handled by the control plane's [Subscription OAuth](/openwiki/providers/subscription-oauth.md#token-refresh--rotation-safety) seam before adapter construction.

## Per-Provider `max_tokens_spelling`

OpenAI introduced `max_completion_tokens` for o-series / reasoning models and **rejects the older `max_tokens`** in that surface. Local and legacy OpenAI-compatible gateways commonly accept only the older spelling. polyrouter routes the outbound field per provider:

| `max_tokens_spelling` | Outgoing wire field | Used by |
|------------------------|---------------------|---------|
| `auto` *(default)* | `local` kind → `max_tokens`; everything else → `max_completion_tokens` | baseline behavior |
| `max_completion_tokens` | `max_completion_tokens` always | reasoning-model-first operators |
| `max_tokens` | `max_tokens` always | legacy / local-only gateways |

Inbound: polyrouter accepts either spelling on every protocol; the resolver picks the effective cap before the adapter serializes.

The setting is per-provider (column `provider.max_tokens_spelling`), NOT NULL with default `'auto'`. Existing `local` providers switch to `max_tokens` on upgrade; all others are unchanged. Outbound always emits exactly one field.

Source: `add-max-tokens-spelling`, `providerMaxTokensQuirks` in `packages/control-plane/src/providers/providers.dto.ts`.

## Shared HTTP Adapter

The `http-adapter.ts` module provides shared transport for all HTTP-based providers:

- **SSRF protection** — every outbound URL validated through `createGuardedHttpClient`
- **First-byte timeout** — per-provider override (`PROVIDER.first_byte_timeout_ms`, `1000–3600000`) falls back to `PROXY_FIRST_EVENT_TIMEOUT_MS` (default 30 s). Raise for slow local models — a 30 s prefill would otherwise 503 and trip the breaker.
- **Inter-event idle timeout** — per-provider override (`PROVIDER.idle_timeout_ms`, same range) falls back to `PROXY_IDLE_TIMEOUT_MS` (default 30 s). Detects stalled streams and trips the breaker cleanly.
- **Byte cap** — 10 MiB max on buffered responses (untrusted provider responses are bounded to prevent memory exhaustion).
- **Pagination** — handles Anthropic's `has_more` + `last_id` cursor pagination for model lists.
- **Response bounds** — caps untrusted provider responses to prevent memory exhaustion.
- **Error decoding** — extracts provider-specific error kinds (`auth`, `rate_limit`, `unavailable`, `bad_request`, `unknown`) with typed payloads.

### Long-Call Timeouts (research-class models)

Some models (Deep Research, Opus with thinking enabled, etc.) take seconds-to-minutes prefill with no body yet, then continue streaming. A blanket first-event timeout would 503 them. Per-provider overrides (`first_byte_timeout_ms`, `idle_timeout_ms`) — range 1 s to 1 h, validated by DB CHECK constraints and Zod — let you set long patience for a research-class model without touching global defaults. The breaker uses the same per-call deadline, so a genuinely hung connect still trips cleanly.

Source: `add-long-call-timeouts`, `fix-long-call-timeouts`, `packages/data-plane/src/proxy/long-call-timeouts.spec.ts`.

### Provider-Listed Pricing (Display Only)

OpenRouter-style `/models` responses carry a per-model `pricing` extension (per-token USD decimal strings). `parseModelList` surfaces these as a per-1M USD **display estimate** stored in the model row's `listed_*` columns — distinct from billing prices, which always come from the bundled catalog or user edits (cost immutability invariant). The dashboard shows listed prices as an `estimated` fallback when no billing price is known, and users can edit model prices directly. Listed prices are rewritten on every catalog sync and cleared when a provider's base URL or protocol changes.

Source: `packages/data-plane/src/providers/listed-pricing.spec.ts`, `packages/control-plane/src/providers/providers.service.ts` (`listedColumnsFrom`).

### OpenRouter Attribution

Requests to `openrouter.ai`-hosted providers carry polyrouter's identity headers — `HTTP-Referer: https://polyrouter.app` and `X-OpenRouter-Title: polyrouter` — so polyrouter appears in OpenRouter's app attribution. The host gate matches only the exact `openrouter.ai` host (case, explicit port, and trailing-FQDN-dot tolerant; subdomains and spoofed suffixes excluded). Identity is disclosed only to OpenRouter; auth is never affected.

Source: `packages/data-plane/src/providers/http-adapter.ts` (`openRouterAttributionHeaders`), `packages/data-plane/src/providers/attribution.spec.ts`.

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

The IR uses **content blocks everywhere** — text, images, tool use, and tool results are all typed blocks. The same IR is consumed by the Layer-2 canonical text extractor (`extractSemanticInput`) for embedding; the structural router extracts its cheap features from it; the cascade reads the normalized `stopReason` to evaluate quality.

Source: `packages/data-plane/src/proxy/translate/ir.ts`.

### Translation Challenges

| Challenge | Solution |
|-----------|----------|
| **Tool results grouping** | Anthropic groups all `tool_result` in one `user` message; IR models each as separate `role:'tool'` message |
| **Usage token differences** | Anthropic excludes cache tokens from input; IR stores uncached components; adapters convert by formula |
| **Malformed tool args** | Carried as `inputRaw: string` + `inputParseError: true` (never throws on model output) |
| **Prompt caching** | Anthropic's `cache_control: {type: 'ephemeral'}` carried opaquely; dropped when crossing to OpenAI |
| **Reasoning/thinking** | Tagged with source protocol; emitted only back to the owning protocol |
| **Reasoning adjustment** | A declared `reasoning_effort`/`thinking` steers the Layer-1 score; a maximal declaration routes `auto_high` directly |
| **`max_tokens_spelling`** | Resolved per-provider at adapter build time; inbound accepts either, outbound emits exactly one |

### Wire Format Adapters

- **OpenAI** (`openai-adapter.ts`) — Chat Completions format with SSE streaming
- **Anthropic** (`anthropic-adapter.ts`) — Messages format with tool-result grouping and cache control
- **OpenAI Responses** (`responses-adapter.ts`) — ChatGPT backend's Responses API (`/backend-api/codex/responses`), OAuth-only. The backend accepts **only streaming** requests, so `chat()` folds the SSE event stream into a buffered `NormalizedResponse`. There is no models endpoint: `listModels()` rejects typed and `testConnection()` probes the preset's trusted `probeModel`. Exactly three identity headers are sent — Bearer, `chatgpt-account-id`, and `responses=experimental` — never `x-api-key` or client fingerprints (no-spoofing rule). `max_output_tokens` and sampling params are dropped (the backend rejects them).

### Golden Tests

Protocol translation is verified with recorded wire-format fixtures:

```
packages/data-plane/src/proxy/translate/golden/
├── anthropic/    # Anthropic wire format examples
├── openai/       # OpenAI wire format examples
└── README.md     # Test documentation
```

Tests verify round-trip fidelity: `requestIn(requestOut(ir))` must preserve semantics. Streaming and non-streaming variants are both covered, including tool use, system prompt order, cache control, and reasoning blocks.

## Circuit Breaker

Each provider has a Redis-backed circuit breaker protecting against cascading failures.

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

Server clock via Redis `TIME` command eliminates instance wall-clock skew. An in-memory store serves as fallback if Redis is unavailable. Each `ChainAttempt` gets its own breaker instance so breaker state is per-(provider, model, principal) — a down upstream on one tenant never trips another tenant's breaker.

Generation-stamped keys (an incrementing generation counter) ensure stale completions from a previous generation cannot corrupt the current breaker state under retries.

### Long-Stall Trips

Hung connects and stalled reads trip the breaker cleanly. A per-provider `first_byte_timeout_ms`/`idle_timeout_ms` enforces the patience; on breach the breaker records the failure atomically.

### Metrics

- `polyrouter_breaker_state` — gauge (0=closed, 1=half_open, 2=open)
- `polyrouter_breaker_opens_total` — counter by provider
- `polyrouter_breaker_store_faults_total` — Redis degradation counter

Source: `packages/data-plane/src/breaker/breaker.ts`, `packages/control-plane/src/proxy/breaker-observability.ts`.

## SSRF Protection

All outbound HTTP requests pass through SSRF protection:

- **URL validation** — `assertUrlSafe()` checks provider base URLs
- **IP classification** — blocks private, loopback, link-local, CGNAT, and metadata ranges (IPv4 and IPv6)
- **DNS rebinding defense** — resolved IP validated at connect time, not just at URL parse time
- **Mode-gated exception** — loopback allowed only for `local` provider kind in self-host mode (`MODE=selfhosted`); cloud instances deny loopback even for `local` providers

Source: `packages/shared/src/server/security/ssrf.ts`, `packages/shared/src/server/security/network-host.ts`.

## Wire Protocol Reference

For each provider kind, here is the exact wire shape the proxy emits. The IR lives in `packages/data-plane/src/proxy/translate/ir.ts`; the per-protocol serializers live next to it.

### OpenAI Chat Completions

```http
POST /v1/chat/completions HTTP/1.1
Authorization: Bearer <api-key>
Content-Type: application/json

{
  "model": "gpt-4o",
  "messages": [{"role": "user", "content": "..."}],
  "stream": true,
  "max_completion_tokens": 1024    // or "max_tokens" per provider setting
}
```

Streaming: `data: {choices:[{delta:{...}}]}\n\n` SSE frames, terminated by `data: [DONE]\n\n`.

### Anthropic Messages

```http
POST /v1/messages HTTP/1.1
x-api-key: <api-key>
anthropic-version: 2023-06-01
Content-Type: application/json

{
  "model": "claude-sonnet-4-20250514",
  "system": [...],
  "messages": [{ "role": "user", "content": [...] }],
  "max_tokens": 1024
}
```

Streaming: SSE frames with `type: message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`.

### OpenAI Responses (subscription-only)

Used exclusively by the ChatGPT preset. The endpoint is `/backend-api/codex/responses`. The proxy sends three identity headers (Bearer, `chatgpt-account-id`, `responses=experimental`) and **no** `x-api-key`, no client fingerprints, no imitation `instructions`. The backend only accepts streaming; the adapter folds the stream back into a buffered response for non-streaming clients. `max_output_tokens`, `temperature`, and `top_p` are dropped (the backend rejects them). Reasoning items emitted by the backend are dropped, not persisted or replayed.

### Cross-Protocol Notes

- A request that arrives OpenAI-format and is routed to an Anthropic provider (or vice versa) goes through the full translation pipeline — the IR handles every conversion.
- Tool calls are translated bidirectionally with content-block fidelity. Multi-turn tool loops preserve round-trip semantics.
- System prompts may carry cache-control markers on Anthropic; the IR carries them opaquely and they are dropped when crossing to OpenAI.
- Reasoning/thinking blocks are tagged with the source protocol and only emitted back to the owning protocol — they never bleed across.

## How to Add a New Provider

Most adapters implement the same four methods and share the `http-adapter` transport. The rough checklist:

1. **Implement `ProviderAdapter`** — at minimum `chat` and `chatStream`. Use `http-adapter` for HTTP-based providers; it gives you SSRF, timeouts, byte caps, and pagination for free.
2. **Decide the credential envelope** — `plain` (raw API key) or `oauth` (subscription OAuth). The credential resolver lives in `subscription-oauth.service.ts` for OAuth; for plain, just `resolvePlainCredentialValue` from shared/server.
3. **Add the protocol-specific IR serializer** in `packages/data-plane/src/proxy/translate/` if the protocol is genuinely new (not OpenAI-compatible). Golden files pin round-trip fidelity.
4. **Add a model-list parser** if the provider exposes `/models`. Otherwise, users paste model ids in the dashboard or the operator seeds them.
5. **For OAuth providers**: add a preset in `packages/control-plane/src/subscription-oauth/presets.ts`. Run `scripts/verify-...-oauth.md` live verification before enabling (`enabled: false` ships by default).
6. **Tests** — unit tests for the adapter's protocol edges, plus an e2e against the stub upstream (`packages/control-plane/test/proxy/stub-upstream.ts`).
7. **Doc touchpoints** — add the provider to the README's provider list; add any new env vars to the config registry.

See [Subscription OAuth](/openwiki/providers/subscription-oauth.md) for the full OAuth flow.