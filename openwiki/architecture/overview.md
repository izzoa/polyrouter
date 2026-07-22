---
type: Architecture
title: Architecture Overview
description: Polyrouter's dual-plane monorepo architecture — control plane (NestJS), data plane (proxy engine), shared types/utilities, frontend (SolidJS), and the optional Layer-2 semantic stack (embedder, classifier, learning loop) — with core invariants and the technology stack.
tags: [architecture, monorepo, control-plane, data-plane, frontend, semantic]
resource: CLAUDE.md
---

# Architecture Overview

Polyrouter is a **dual-plane LLM proxy** built as a Turborepo monorepo. The control plane handles configuration, auth, budgets, observability, request recording, and (when opted in) the Layer-2 semantic runtime + learning sweep. The data plane is a framework-agnostic proxy engine — pure TypeScript, no Nest, no DB — that handles routing resolution, protocol translation, the Layer-1 structural classifier, the Layer-2 cosine classifier, and provider adapters.

## Monorepo Structure

```
polyrouter/
├── packages/
│   ├── shared/          # Types, enums, database schema, security utilities, pricing resolution
│   ├── control-plane/   # NestJS: auth, routing config, budgets, notifications, observability,
│   │                    #          request recording, body capture, pricing refresh,
│   │                    #          semantic runtime, semantic classifier, semantic learning sweep
│   ├── data-plane/      # Pure TS: proxy core, routing resolution, protocol translation,
│   │                    #         provider adapters, circuit breaker,
│   │                    #         semantic math (centroids, classifier, extractor, anchors, learning)
│   └── frontend/        # SolidJS SPA: dashboard UI (incl. L2 toggle and learning card)
├── README.md            # Product-facing docs incl. semantic-layer section + OAuth presets
├── CLAUDE.md            # Agent operating rules
├── STYLESEED.md         # Frontend design system lock
├── docker-compose.yml   # Baseline production stack (app + postgres + redis)
├── docker-compose.semantic.yml
│                        # Override compose for the `-semantic` image variant (Layer 2)
└── install.sh           # One-liner installer
```

Build dependencies flow **shared → data-plane → control-plane → frontend**, enforced by Turborepo's task graph.

## Dual-Plane Design

### Control Plane (`packages/control-plane/`)

The control plane is a NestJS 11 application responsible for:

- **Authentication** — Better Auth sessions for the dashboard, HMAC agent keys for the API
- **Routing configuration** — tier management, routing rules, auto-layer preferences, threshold calibration
- **Budget enforcement** — pre-request spend checks against Redis atomic counters (fail-open by default)
- **Notifications** — SMTP and Apprise channels via a dedicated BullMQ queue
- **Observability** — Prometheus metrics, OpenTelemetry traces, exception-safe counters
- **Request recording** — immutable cost records with price snapshots; cascade attempts get a per-attempt ledger
- **Body capture** — opt-in encrypted prompt/response body storage (selfhosted only)
- **Pricing refresh** — scheduled catalog pulls from LiteLLM (daily, on by default, opt-out per env)
- **Semantic runtime** *(opt-in, flag-gated)* — loads the local ONNX embedder, runs warmup, builds bundled centroids, hosts the classifier, and resolves the per-tenant learned-supersedes-bundled state
- **Semantic learning sweep** *(opt-in)* — daily BullMQ sweep that folds cascade-labeled evidence into learned centroids under bounded rails; CAS atomic against a Postgres epoch; one-action revert

Key modules: `proxy`, `routing-config`, `providers`, `budgets`, `pricing`, `notifications`, `observability`, `recording`, `auth`, `redis`, `database`, `body-capture`, `semantic` (Layer 2), `subscription-oauth`, `calibration`.

### Data Plane (`packages/data-plane/`)

The data plane is a pure TypeScript library with **no Nest, no DB, no I/O dependencies** (it consumes injected `Redis`/`fetch` seams). It provides:

- **Proxy core** — stream orchestration with circuit breaker integration, commit boundary, mid-stream error frame
- **Routing resolution** — Layer 0 explicit routing (framework-agnostic)
- **Protocol translation** — OpenAI ↔ Anthropic normalization via an intermediate representation (IR), backed by golden-file contract tests
- **Provider adapters** — HTTP adapters with SSRF protection, idle timeout, response bounds, error decoding, attribution headers
- **Circuit breaker** — Redis-backed, generation-stamped, Lua-atomic transitions, half-open probes
- **Semantic math (pure)** — `extractSemanticInput` (canonical extractor), `classifySemantic` (cosine three-band), `validateCentroids`, `foldEvidence` / `clampDriftSpherical` / `cosineDistance` (learning primitives), and the bundled anchor set
- **Embedder seam** — the `Embedder` interface consumed by the classifier; the runtime behind it (real ONNX in control-plane, deterministic stub in tests) is invisible to callers

This separation means the data plane can be extracted to Hono, Go, or any other runtime without changing business logic.

### Shared (`packages/shared/`)

Dual-entry package:

- **Root export** (`@polyrouter/shared`) — browser-safe types, harness constants, config registry helpers
- **Server export** (`@polyrouter/shared/server`) — database schema (Drizzle), tenancy primitives, encryption, SSRF protection, pricing resolution, routing constants, semantic learning sweep tenant shape, persistence port

### Frontend (`packages/frontend/`)

SolidJS + Vite SPA with a dashboard for managing routing, providers, agents, budgets, requests, and the L2 layer. Communicates with the control plane via a typed fetch client. Uses cookie-based auth with Vite proxy in development and same-origin in production.

See [Dashboard](/openwiki/dashboard/overview.md) for details, including the L2 toggle and learning card.

## Optional Layer-2 Semantic Stack

The semantic stack is **flag-gated**: it is entirely absent from the baseline build/image and activates only when both a model path and the `semantic` token in `ROUTING_AUTO_LAYERS` are present. It introduces these concerns:

- **Bundle contract** — a v1 `manifest.json` describing the tokenizer (WordPiece), tensor names, pooling, normalization, dims. The bundle is validated at boot; a broken bundle fails fast (loud, never silent).
- **Embedder runtime** (`SemanticRuntimeService`) — loads `onnxruntime-node` dynamically, builds an `InferenceSession`, runs a warmup inference so requests never pay first-call JIT, exposes a bounded `Embedder` with try-acquire/no-queue admission.
- **Classifier** (`SemanticClassifierService`) — embeds the bundled anchors through the SAME extractor live requests use, averages per-band centroids, validates them (unit-norm, non-cancelling), and stamps a content-derived revision.
- **Router** (`SemanticRouter`) — consumes Layer 1's ambiguous slice, classifies against the bundled centroids, and either routes (confident band), passes to cascade (still ambiguous), or degrades (fault/unavailable). All faults degrade to `skip` — never a fabricated verdict.
- **Classification-source seam** — the bundled centroids are bound at the `CLASSIFICATION_SOURCE` token; the learned decorator layers per-tenant state under read-time gates.
- **Learning loop** (`LearningContributionModule` + `SemanticLearningScheduler`) — accumulates L2-ambiguous cascade-labeled evidence in bounded volatile memory, flushes to Redis only as ≥ `MIN_COHORT` aggregates, and runs a daily sweep that folds fresh evidence into learned centroids with EMA + spherical drift clamp. Postgres is authoritative (CAS + audit); Redis is the atomic stage/promote store.

The full design, bundle manifest shape, privacy invariants, and the L1 → L2 → L3 interplay live in the dedicated [Semantic Stack](/openwiki/architecture/semantic-stack.md) reference.

## Core Invariants

These rules from [`CLAUDE.md`](/CLAUDE.md) are non-negotiable across the codebase:

1. **Explicit routing is the reliable core** — automatic routing is opt-in and must degrade gracefully; every smart-layer fault degrades to explicit/default. **Layer 2 specifically**: an unavailable embedder, an embed timeout, a degenerate `invalid` classification, or a Redis fault on learned reads must each yield `skip` (no verdict, no telemetry fabrication, never a stalled request).
2. **Protocol translation is isolated** — the proxy core never inspects provider-specific wire format
3. **Mid-stream commit rule** — once the first token is sent to the client, the model is locked; no swap
4. **Immutable cost records** — unit prices snapshotted at request time, never recomputed
5. **Mandatory tenant isolation** — every query scoped via `WHERE owner = current_principal`
6. **SSRF protection on all outbound URLs** — every user-supplied URL validated before fetch; the loopback exception is gated on `MODE=selfhosted` and provider kind `local`
7. **Fast API key verification** — HMAC prefix lookup, no full-table scan
8. **Fire-and-forget notifications** — never block the request path
9. **Fail-open by default** — availability over strict enforcement for budgets and breakers; the semantic layer's Redis-fault path follows the same rule (bundled falls back, never a router skip)
10. **Bounded everything** — timeouts, byte caps, parse caps, pagination limits; the semantic embedder has its own bounded concurrency, timeout, and input-cap knobs
11. **Exception-safe observability** — metrics/tracing never throw into callers
12. **Generation-stamped breakers** — stale completions can't corrupt circuit breaker state

**Two semantic-stack invariants worth highlighting:**

- **Privacy** — embedded text and vectors are **never** logged, persisted to Postgres, returned in an API response, or attached to telemetry. Everything that touches Redis is an aggregate (sum + count, or a learned centroid) over ≥ `MIN_COHORT` embeddings; the first raw embedding that lands in Redis is the one for the sum of size 2. Losing Redis loses learning and nothing else.
- **Baseline-image cleanliness** — CI asserts the baseline Docker image ships no `onnxruntime-node` and no model files. The semantic stack is the `-semantic` image variant only.

## Technology Stack

| Layer | Technology | Version |
|-------|------------|---------|
| Language | TypeScript (strict) | 5.x |
| Backend framework | NestJS | 11 |
| ORM | Drizzle | latest |
| Database | PostgreSQL | 16 |
| Cache / atomic counters / queue | Redis | 7 |
| Queue | BullMQ | latest |
| Auth | Better Auth | 1.6 |
| Frontend framework | SolidJS | latest |
| Frontend build | Vite | latest |
| Monorepo | Turborepo + npm workspaces | latest |
| Runtime | Node.js | 24.x LTS |
| Tests (backend) | Jest | latest |
| Tests (frontend/shared) | Vitest | latest |
| Packaging | Docker + Compose v2 | — |
| Charts | uPlot | latest |
| Semantic runtime (opt-in peer) | onnxruntime-node | 1.27.0 (glibc build) |

## Data Flow Summary

```
                    ┌────────────────────────────────────────────────────────┐
                    │              Control Plane (NestJS)                     │
                    │  Auth → Budget → Snapshot → Route Config → Recording    │
                    │  Notifications ← Observability ← Metrics              │
                    │  Semantic Runtime ───► Semantic Classifier              │
                    │           └──► Learning Sweep (BullMQ, daily)           │
                    └────────────────────────┬───────────────────────────────┘
                                             │ orchestrates
                    ┌────────────────────────▼───────────────────────────────┐
                    │            Data Plane (Pure TS)                        │
                    │  Layer 0 Route ─► Protocol Translation                 │
                    │       ─► Circuit Breaker ─► Provider Adapter           │
                    │  Layer 1 Structural ─► Layer 2 Semantic (cosine)        │
                    │       ─► Layer 3 Cascade (cheap→escalate)              │
                    └────────────────────────┬───────────────────────────────┘
                                             │ forwards
                                    ┌────────▼────────┐
                                    │  LLM Providers  │
                                    │  OpenAI, Anthropic, Custom, Local, OAuth  │
                                    └─────────────────┘
```

## Build Order

The project follows a strict 12-phase build order (from `CLAUDE.md`):

1. Foundation (monorepo, shared types, config)
2. Auth & identity
3. Database & tenancy
4. Provider adapters
5. Protocol translation
6. Inference proxy core
7. Routing configuration
8. Cascade routing & fallbacks
9. Pricing & analytics
10. Budget & notifications
11. Dashboard
12. Packaging & CI

The semantic stack was added **after** baseline completion as **flag-gated, opt-in changes**:

- `add-semantic-embedder` — flag-gated local ONNX embedder, baseline image stays ORT-free
- `add-semantic-routing` — Layer-2 classifier routing on the L1-ambiguous slice
- `add-semantic-learning` — per-tenant learned centroids (off by default)
- `add-semantic-dashboard` — L2 toggle + learning card, batteries-included `-semantic` image variant

Each phase is an independent OpenSpec change with its own proposal, design, specs, and tasks. Changes are archived after completion.