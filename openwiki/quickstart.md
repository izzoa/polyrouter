---
type: Guide
title: Polyrouter Quickstart
description: Getting started with polyrouter — the self-hostable LLM router with one endpoint for every model, four-layer routing (explicit / structural / semantic / cascade), fallback chains, budget enforcement, and an opt-in local semantic embedder.
tags: [quickstart, onboarding, getting-started]
resource: README.md
---

# Polyrouter Quickstart

Polyrouter is a **self-hostable LLM router/gateway**: one OpenAI- and Anthropic-compatible endpoint that sits between your agents and your LLM providers. It routes every request to the right model across your providers (BYOK API keys, custom OpenAI/Anthropic-compatible endpoints, local models, Claude/ChatGPT subscriptions via OAuth), retries down a fallback chain when a provider fails, enforces budgets, and records what each request actually cost — while storing **metadata only**, never your prompts.

This page is the entry point. For the bigger picture see [Architecture Overview](/openwiki/architecture/overview.md). For the full request lifecycle see [Request Flow](/openwiki/architecture/request-flow.md).

## What You Get

- **One endpoint for every model** — agents talk to polyrouter; it routes to OpenAI, Anthropic, custom providers, local models, or [subscription OAuth](/openwiki/providers/subscription-oauth.md) providers.
- **Four-layer routing** —
  - **Layer 0** explicit (model name wins, header tier wins, default tier catches) — always on.
  - **Layer 1** structural (language-neutral features → band) — opt-in.
  - **Layer 2** semantic (local ONNX embedding → cosine band) — opt-in, refines only the L1-ambiguous slice.
  - **Layer 3** cascade (cheap first → escalate on quality-gate failure) — opt-in.
  Every smart layer **degrades to explicit/default**; a request never fails because routing tried to be clever. See [Routing Engine](/openwiki/routing/engine.md) and the [Semantic Stack](/openwiki/architecture/semantic-stack.md) reference.
- **Fallback chains** — automatic failover through ordered provider chains when upstreams fail. Mid-stream failures terminate with a clear error; models are never silently swapped.
- **Budget enforcement** — per-agent or global spend limits with alert and block actions, backed by atomic Redis counters that stay correct across multiple proxy instances.
- **Metadata-only cost tracking** — immutable cost records with snapshotted prices; prompt/response bodies are never stored by default. Opt-in encrypted body capture is available on self-hosted instances.
- **Dashboard** — SolidJS + uPlot frontend for monitoring requests, managing providers, configuring routing, viewing analytics, and the **decision inspector** (every request shows its decision layer and human-readable routing reason).

## Install (One Command)

The fastest path uses the prebuilt multi-arch Docker image (Postgres 16 + Redis 7 + app, all wired up):

```bash
curl -fsSL https://raw.githubusercontent.com/izzoa/polyrouter/main/install.sh | sh
```

The script checks Docker Compose v2, fetches a pinned source archive, generates four 32-byte-hex secrets into a mode-600 `.env` (**never** overwritten on re-run), and boots `docker compose -p polyrouter-selfhost up -d --build`. The first build takes a few minutes; subsequent runs reuse the `.env` and just refresh the source.

Two image variants ship for every release:

| Image | Contents | When to use |
|-------|----------|-------------|
| `ghcr.io/izzoa/polyrouter:<v>` | Baseline: NestJS app, no ONNX runtime, no model | Default self-host, smallest attack surface |
| `ghcr.io/izzoa/polyrouter:<v>-semantic` | Baseline + `onnxruntime-node` + a pinned `all-MiniLM-L6-v2` model pre-baked | Want Layer 2 semantic routing out of the box |

To run the semantic variant, layer the override compose file on top:

```bash
docker compose -f docker-compose.yml -f docker-compose.semantic.yml up -d
```

CI asserts the baseline image stays ORT- and model-free. See [Deployment](/openwiki/operations/deployment.md) for the full env-var matrix, the `-semantic` override, and bring-your-own-model support.

## First API Call

Once running (default: `http://localhost:3001`), send a request using the OpenAI-compatible endpoint:

```bash
curl http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer poly_YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

Or use the Anthropic-compatible endpoint:

```bash
curl http://localhost:3001/v1/messages \
  -H "x-api-key: poly_YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

API keys are minted from the dashboard's **Agents** page (sidebar → Agents → New) or via the `/api/agents` REST endpoint. Keys use the `poly_` prefix and verify via **HMAC-SHA256 + prefix lookup** — fast per-request verification, never bcrypt on the hot path. Key rotation is one click and instantly invalidates the old key.

## How a Request Is Routed

The decision precedence is **first match wins**:

1. **Explicit model** in the request body (e.g. `"model": "gpt-4o"`) — always honored.
2. **`x-polyrouter-tier` header** → that tier's chain (the built-in tier header has structural precedence over other header rules).
3. **`model: "auto"`** → enabled smart layers run in order, each consuming the previous layer's ambiguity:
   - **Layer 1** (structural) — extracts features, classifies into `high` / `low` / `ambiguous`.
   - **Layer 2** (semantic, when enabled + a model is loaded) — runs **only** on the L1-ambiguous slice. Confident band → route. Still ambiguous → continue.
   - **Layer 3** (cascade) — tries the cheap tier, evaluates quality, escalates on quality-gate failure.
4. **`default` tier** — the guaranteed catch-all.

Whatever layer decides, the tier's fallback chain applies on provider failure, budgets are enforced, and the decision (`decision_layer` + `routing_reason`) is recorded for the inspector. The Layer 2 verdict adds four telemetry columns (`semantic_band` / `semantic_score` / `semantic_source` / `semantic_revision`) when it evaluates.

For the full decision trail and the L1 → L2 → L3 interplay see [Request Flow](/openwiki/architecture/request-flow.md) and the [Semantic Stack](/openwiki/architecture/semantic-stack.md) reference.

## Architecture at a Glance

```
Agent Request → polyrouter → Provider (OpenAI, Anthropic, custom, local, OAuth)
                   ↓
            Budget Check → Route Resolution (L0 → L1 → L2 → L3)
                   ↓
            Protocol Translation → Upstream Call (with circuit-breaker)
                   ↓
            Record Cost/Tokens/Latency (immutable snapshot-priced) → Return Response
```

The system is split into four packages inside one container:

- **[Control Plane](/openwiki/architecture/overview.md#control-plane-packagescontrol-plane)** (`packages/control-plane/`) — NestJS backend: auth, routing configuration, budget enforcement, notifications, observability, request recording, body capture, pricing refresh, and the optional semantic runtime + learning sweep.
- **[Data Plane](/openwiki/architecture/overview.md#data-plane-packagesdata-plane)** (`packages/data-plane/`) — framework-agnostic TypeScript library: proxy core, routing resolution, protocol translation, provider adapters, circuit breaker, and the pure semantic math (centroids, classifier, extractor, anchors, learning primitives).
- **[Shared](/openwiki/architecture/overview.md#shared-packagesshared)** (`packages/shared/`) — types, Drizzle schema, security primitives (SSRF, encryption, credential envelope), pricing resolution.
- **[Frontend](/openwiki/dashboard/overview.md)** (`packages/frontend/`) — SolidJS + Vite SPA dashboard.

Build dependencies flow **shared → data-plane → control-plane → frontend**, enforced by Turborepo.

## Navigation

| Section | What it covers |
|---------|----------------|
| [Architecture Overview](/openwiki/architecture/overview.md) | Dual-plane monorepo, technology stack, core invariants |
| [Request Flow](/openwiki/architecture/request-flow.md) | Full lifecycle of an LLM request through the proxy |
| [Semantic Stack](/openwiki/architecture/semantic-stack.md) | The optional Layer-2 stack: embedder, bundle contract, classifier, learning loop, telemetry |
| [Routing Engine](/openwiki/routing/engine.md) | Layer 0/1/2/3 routing, tiers, fallback chains, cascade, calibration |
| [Provider Adapters](/openwiki/providers/adapters.md) | Supported providers, protocol translation, circuit breakers, `max_tokens_spelling` |
| [Subscription OAuth](/openwiki/providers/subscription-oauth.md) | Claude Pro/Max and ChatGPT Plus/Pro connect, token refresh, credential envelope |
| [Data Model](/openwiki/data-model/schema.md) | Database schema, tenant isolation, immutable costs, L2 telemetry |
| [Dashboard](/openwiki/dashboard/overview.md) | SolidJS frontend pages, design system, L2 toggle and learning card |
| [Security & Auth](/openwiki/security/auth.md) | Dual auth model, credential envelope, SSRF, metadata-only privacy, L2 invariants |
| [Deployment](/openwiki/operations/deployment.md) | Docker Compose, env vars, `-semantic` image variant, runbook |
| [Testing](/openwiki/testing/guide.md) | Test types, golden files, contract suites, L2 e2e |

## Quick Reference

### Key Files

| File | Purpose |
|------|---------|
| [`README.md`](/README.md) | Product-facing overview, install, the semantic-layer section, OAuth presets |
| [`CLAUDE.md`](/CLAUDE.md) | Agent operating rules and 12 non-negotiable core invariants |
| [`STYLESEED.md`](/STYLESEED.md) | Frontend design system lock (one accent `#4F5DFF`, flat borders, compact density) |
| [`CONTRIBUTING.md`](/CONTRIBUTING.md) | Development setup and spec-driven workflow |
| [`SECURITY.md`](/SECURITY.md) | Vulnerability reporting |
| [`CHANGELOG.md`](/CHANGELOG.md) | Release notes — v0.8.0 ships the semantic stack |

### Tech Stack

| Layer | Technology |
|-------|------------|
| Language | TypeScript (strict) |
| Backend | NestJS 11 |
| ORM | Drizzle |
| Database | PostgreSQL 16 |
| Cache | Redis 7 |
| Auth | Better Auth + HMAC agent keys |
| Frontend | SolidJS + Vite |
| Charts | uPlot |
| Build | Turborepo + npm workspaces |
| Runtime | Node.js 24.x LTS |
| Semantic runtime (opt-in) | `onnxruntime-node@1.27.0` (glibc build) |
| Packaging | Docker + Compose v2 |

## Backlog

The following areas are deferred or pending future work:

- **Cloud tier** (split data-plane to Hono/Go, Timescale/ClickHouse events) — deferred per spec.
- **Organizations / workspaces** — schema stubs exist; features deferred.
- **Layer 2 model bundle publisher tooling** — currently a single reference MiniLM bundle is baked; curated bundles for other embedding families may follow.

Nothing else from the v0.8.0 surface is backlogged — all delivered capabilities are documented in their respective section pages.