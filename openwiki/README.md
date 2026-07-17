---
type: Index
title: Polyrouter Documentation Index
description: Complete documentation index for polyrouter — the self-hostable LLM router with smart routing, fallback chains, and budget enforcement. Cross-references all generated wiki pages.
tags: [docs, index, documentation, cross-reference]
---

# Polyrouter Documentation

Welcome to the polyrouter documentation. This is the central reference for understanding, deploying, operating, and extending polyrouter — a self-hostable LLM router/gateway that gives you one OpenAI- and Anthropic-compatible endpoint for every model.

## Quick Links

| Document | Description |
|----------|-------------|
| [**Quickstart**](/openwiki/quickstart.md) | Get up and running in one command |
| [**Architecture Overview**](/openwiki/architecture/overview.md) | Dual-plane design, monorepo structure, tech stack |
| [**Request Flow**](/openwiki/architecture/request-flow.md) | Full lifecycle of an LLM request |
| [**Routing Engine**](/openwiki/routing/engine.md) | Layer 0/1/3 routing, tiers, fallbacks, cascade |
| [**Provider Adapters**](/openwiki/providers/adapters.md) | Supported providers, protocol translation, circuit breakers |
| [**Data Model**](/openwiki/data-model/schema.md) | Database schema, tenant isolation, immutable costs |
| [**Dashboard**](/openwiki/dashboard/overview.md) | SolidJS frontend pages, design system, components |
| [**Security & Auth**](/openwiki/security/auth.md) | Dual auth, SSRF protection, encryption, tenant isolation |
| [**Deployment**](/openwiki/operations/deployment.md) | Docker Compose, env vars, install script, runbook |
| [**Testing**](/openwiki/testing/guide.md) | Test types, CI pipeline, golden files, how to add tests |

## Documentation Map

```
quickstart.md                          ← Start here
├── architecture/
│   ├── overview.md                    ← Monorepo structure, dual-plane design, core invariants
│   └── request-flow.md               ← Full request lifecycle through the proxy
├── routing/
│   └── engine.md                      ← Layer 0 explicit, Layer 1 structural, Layer 3 cascade
├── providers/
│   └── adapters.md                    ← Provider interface, protocol translation, breakers
├── data-model/
│   └── schema.md                      ← PostgreSQL schema, tenant isolation, immutable costs
├── dashboard/
│   └── overview.md                    ← SolidJS SPA, 9 pages, StyleSeed design system
├── security/
│   └── auth.md                        ← Dual auth, SSRF, encryption, metadata-only privacy
├── operations/
│   └── deployment.md                  ← Docker Compose, env vars, operational runbook
└── testing/
    └── guide.md                       ← Unit, e2e, contract, security tests; CI pipeline
```

## Cross-Reference Matrix

This matrix shows which documentation pages reference each other:

| From ↓ / To → | Quickstart | Arch Overview | Request Flow | Routing | Providers | Data Model | Dashboard | Security | Deployment | Testing |
|----------------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Quickstart** | — | ✓ | | ✓ | | ✓ | ✓ | | ✓ | |
| **Arch Overview** | | — | ✓ | | | ✓ | ✓ | ✓ | | |
| **Request Flow** | | ✓ | — | ✓ | ✓ | ✓ | | ✓ | | |
| **Routing** | | | ✓ | — | ✓ | | | | | |
| **Providers** | | | ✓ | ✓ | — | | | ✓ | | |
| **Data Model** | | | | | | — | ✓ | ✓ | | |
| **Dashboard** | | | | | | ✓ | — | ✓ | | |
| **Security** | | ✓ | | | | ✓ | | — | ✓ | |
| **Deployment** | | | | | | | | ✓ | — | ✓ |
| **Testing** | | ✓ | ✓ | | | | | | ✓ | — |

## Key Source Files

These files in the repository root provide essential context:

| File | Purpose |
|------|---------|
| [`CLAUDE.md`](/CLAUDE.md) | Agent operating rules and 12 non-negotiable core invariants |
| [`STYLESEED.md`](/STYLESEED.md) | Frontend design system lock (accent color, elevation, density) |
| [`FABLE_AUDIT.md`](/FABLE_AUDIT.md) | 19-surface security audit findings and resolutions |
| [`CONTRIBUTING.md`](/CONTRIBUTING.md) | Development setup, spec-driven workflow, definition of done |
| [`SECURITY.md`](/SECURITY.md) | Vulnerability reporting process and sensitive areas |
| [`TODOS.md`](/TODOS.md) | Build plan with status board (all 45 items + 15 epics resolved) |

## Project Structure

```
polyrouter/
├── packages/
│   ├── shared/              # @polyrouter/shared — types, DB schema, security
│   │   └── src/
│   │       ├── index.ts           # Browser-safe root export
│   │       └── server/index.ts    # Server-only: DB, tenancy, encryption, SSRF
│   ├── control-plane/       # NestJS backend — auth, routing, budgets, observability
│   │   └── src/
│   │       ├── proxy/             # Proxy service, routing config, breaker observability
│   │       ├── routing-config/    # Tier/rule/entry CRUD, auto-layers
│   │       ├── providers/         # Provider management service
│   │       ├── budgets/           # Budget service, scheduler, config
│   │       ├── pricing/           # Price resolution from model_price table
│   │       ├── notifications/     # Channel service, SMTP/Apprise adapters
│   │       ├── producers/         # Notification producers (weekly summary, etc.)
│   │       ├── recording/         # Request log writer, request recorder
│   │       ├── observability/     # Prometheus metrics, OpenTelemetry tracing
│   │       ├── auth/              # Session guard, agent key guard, rate limiting
│   │       ├── redis/             # Redis module, error logging
│   │       └── database/          # Drizzle queries, analytics, cost SQL
│   ├── data-plane/          # Pure TS — proxy core, routing, translation, adapters
│   │   └── src/
│   │       ├── proxy/
│   │       │   ├── core.ts        # Stream orchestration with breaker integration
│   │       │   └── translate/     # Protocol translation (IR ↔ OpenAI/Anthropic)
│   │       ├── routing/
│   │       │   └── resolve.ts     # Layer 0 route resolution (pure function)
│   │       ├── providers/
│   │       │   ├── adapter.ts     # ProviderAdapter interface
│   │       │   ├── openai.ts      # OpenAI adapter
│   │       │   ├── anthropic.ts   # Anthropic adapter
│   │       │   └── http-adapter.ts # Shared HTTP transport with SSRF guard
│   │       └── breaker/
│   │           └── breaker.ts     # Circuit breaker state machine
│   └── frontend/            # SolidJS SPA dashboard
│       └── src/
│           ├── App.tsx            # App shell with auth state machine
│           ├── pages/             # 9 dashboard pages
│           ├── components/        # 12 UI components
│           ├── data/api.ts        # Typed fetch client
│           ├── state/appState.ts  # SolidJS store with context DI
│           └── styles.css         # StyleSeed design tokens
├── CLAUDE.md                # Agent operating rules
├── STYLESEED.md             # Design system lock
├── FABLE_AUDIT.md           # Security audit
├── CONTRIBUTING.md          # Dev workflow
├── SECURITY.md              # Vulnerability reporting
├── TODOS.md                 # Build plan status
├── docker-compose.yml       # Production stack (app + Postgres + Redis)
├── install.sh               # One-liner installer
└── openwiki/                # Generated documentation (this wiki)
    ├── README.md            # This file
    ├── quickstart.md        # Entry point
    ├── architecture/
    │   ├── overview.md      # Architecture overview
    │   └── request-flow.md  # Request lifecycle
    ├── routing/
    │   └── engine.md        # Routing engine
    ├── providers/
    │   └── adapters.md      # Provider adapters & translation
    ├── data-model/
    │   └── schema.md        # Database schema
    ├── dashboard/
    │   └── overview.md      # Frontend dashboard
    ├── security/
    │   └── auth.md          # Security & auth
    ├── operations/
    │   └── deployment.md    # Deployment & runbook
    └── testing/
        └── guide.md         # Testing guide
```

## Quick Reference

### Tech Stack
| Layer | Technology |
|-------|------------|
| Language | TypeScript (strict) |
| Backend | NestJS 11 |
| ORM | Drizzle |
| Database | PostgreSQL 16 |
| Cache/Queue | Redis 7 |
| Auth | Better Auth + HMAC agent keys |
| Frontend | SolidJS + Vite |
| Charts | uPlot |
| Build | Turborepo + npm workspaces |
| Runtime | Node.js 24.x LTS |
| Packaging | Docker + Compose v2 |

### Core Invariants (from CLAUDE.md)
1. Explicit routing is the reliable core; auto-routing is opt-in
2. Protocol translation is isolated from the proxy core
3. Mid-stream commit rule — no model swap after first token
4. Immutable cost records — prices snapshotted, never recomputed
5. Mandatory tenant isolation on every query
6. SSRF protection on all outbound URLs
7. Fast API key verification via HMAC prefix lookup
8. Fire-and-forget notifications — never block request path
9. Fail-open by default for budgets and breakers
10. Bounded everything — timeouts, byte caps, parse caps
11. Exception-safe observability — metrics never throw
12. Generation-stamped breakers — no stale state corruption

### API Surface
| Endpoint | Protocol | Purpose |
|----------|----------|---------|
| `POST /v1/chat/completions` | OpenAI | Inference |
| `POST /v1/messages` | Anthropic | Inference |
| `GET /v1/models` | Either | List available models |
| `/api/agents` | REST | Agent CRUD, key rotation |
| `/api/providers` | REST | Provider CRUD, model sync |
| `/api/tiers` | REST | Tier CRUD |
| `/api/routing-entries` | REST | Tier↔model assignments |
| `/api/routing-rules` | REST | Header-based routing rules |
| `/api/analytics` | REST | Usage analytics |
| `/api/limits` | REST | Budget management |
| `/api/notifications` | REST | Channel management |
| `/api/auth` | Better Auth | Login, signup, OAuth |

### Getting Started
1. [**Install**](/openwiki/operations/deployment.md#quick-install) — one command
2. [**Create an agent**](/openwiki/dashboard/overview.md#agents) — get an API key
3. [**Add a provider**](/openwiki/dashboard/overview.md#providers) — connect OpenAI/Anthropic
4. [**Send a request**](/openwiki/quickstart.md#first-api-call) — test the proxy
5. [**Configure routing**](/openwiki/routing/engine.md) — set up tiers and fallbacks
6. [**Set budgets**](/openwiki/data-model/schema.md#budget-enforcement) — control spending
