---
type: Architecture
title: Architecture Overview
description: Polyrouter's dual-plane monorepo architecture — control plane (NestJS), data plane (proxy engine), frontend (SolidJS), and shared utilities — with core invariants and technology stack.
tags: [architecture, monorepo, control-plane, data-plane, frontend]
resource: CLAUDE.md
---

# Architecture Overview

Polyrouter is a **dual-plane LLM proxy** built as a Turborepo monorepo. The control plane handles configuration, auth, budgets, and persistence. The data plane is a framework-agnostic proxy engine that routes, translates, and forwards requests to LLM providers.

## Monorepo Structure

```
polyrouter/
├── packages/
│   ├── shared/          # Types, enums, database schema, security utilities
│   ├── control-plane/   # NestJS: auth, routing config, budgets, notifications, observability
│   ├── data-plane/      # Pure TS: proxy core, routing resolution, protocol translation, provider adapters
│   └── frontend/        # SolidJS SPA: dashboard UI
├── CLAUDE.md            # Agent operating rules
├── STYLESEED.md         # Frontend design system lock
├── docker-compose.yml   # Production stack
└── install.sh           # One-liner installer
```

Build dependencies flow **shared → data-plane → control-plane → frontend**, enforced by Turborepo's task graph.

## Dual-Plane Design

### Control Plane (`packages/control-plane/`)

The control plane is a NestJS 11 application responsible for:

- **Authentication** — Better Auth sessions for the dashboard, HMAC agent keys for the API
- **Routing configuration** — tier management, routing rules, auto-layer preferences
- **Budget enforcement** — pre-request spend checks against Redis counters
- **Notifications** — SMTP and Apprise channels via BullMQ queue
- **Observability** — Prometheus metrics and OpenTelemetry traces
- **Request recording** — immutable cost records with price snapshots

Key modules: `proxy`, `routing-config`, `providers`, `budgets`, `pricing`, `notifications`, `observability`, `recording`, `auth`, `redis`, `database`.

### Data Plane (`packages/data-plane/`)

The data plane is a pure TypeScript library with **no Nest, no DB, no I/O dependencies**. It provides:

- **Proxy core** — stream orchestration with circuit breaker integration
- **Routing resolution** — Layer 0 explicit routing (framework-agnostic)
- **Protocol translation** — OpenAI ↔ Anthropic normalization via intermediate representation (IR)
- **Provider adapters** — HTTP adapters with SSRF protection, pagination, and timeout handling

This separation means the data plane can be extracted to Hono, Go, or any other runtime without changing business logic.

### Shared (`packages/shared/`)

Dual-entry package:

- **Root export** (`@polyrouter/shared`) — browser-safe types, harness constants, config registry
- **Server export** (`@polyrouter/shared/server`) — database schema (Drizzle), tenancy primitives, encryption, SSRF protection, pricing resolution, routing constants

### Frontend (`packages/frontend/`)

SolidJS + Vite SPA with 12 dashboard pages. Communicates with the control plane via a typed fetch client. Uses cookie-based auth with Vite proxy in development and same-origin in production.

See [Dashboard](/openwiki/dashboard/overview.md) for details.

## Core Invariants

These rules from [`CLAUDE.md`](/CLAUDE.md) are non-negotiable across the codebase:

1. **Explicit routing is the reliable core** — automatic routing is opt-in and must degrade gracefully
2. **Protocol translation is isolated** — the proxy core never inspects provider-specific wire format
3. **Mid-stream commit rule** — once the first token is sent to the client, the model is locked; no swap
4. **Immutable cost records** — unit prices snapshotted at request time, never recomputed
5. **Mandatory tenant isolation** — every query scoped via `WHERE owner = current_principal`
6. **SSRF protection on all outbound URLs** — every user-supplied URL validated before fetch
7. **Fast API key verification** — HMAC prefix lookup, no full-table scan
8. **Fire-and-forget notifications** — never block the request path
9. **Fail-open by default** — availability over strict enforcement for budgets and breakers
10. **Bounded everything** — timeouts, byte caps, parse caps, pagination limits
11. **Exception-safe observability** — metrics/tracing never throw into callers
12. **Generation-stamped breakers** — stale completions can't corrupt circuit breaker state

## Technology Stack

| Layer | Technology | Version |
|-------|------------|---------|
| Language | TypeScript (strict) | 5.x |
| Backend framework | NestJS | 11 |
| ORM | Drizzle | latest |
| Database | PostgreSQL | 16 |
| Cache/queue | Redis | 7 |
| Auth | Better Auth | 1.6 |
| Frontend framework | SolidJS | latest |
| Frontend build | Vite | latest |
| Monorepo | Turborepo + npm workspaces | latest |
| Runtime | Node.js | 24.x LTS |
| Tests (backend) | Jest | latest |
| Tests (frontend/shared) | Vitest | latest |
| Packaging | Docker + Compose v2 | — |
| Charts | uPlot | latest |

## Data Flow Summary

```
                    ┌─────────────────────────────────────────────┐
                    │              Control Plane (NestJS)          │
                    │  Auth → Budget → Route Config → Recording   │
                    │  Notifications ← Observability ← Metrics    │
                    └──────────────────┬──────────────────────────┘
                                       │ orchestrates
                    ┌──────────────────▼──────────────────────────┐
                    │            Data Plane (Pure TS)              │
                    │  Route Resolution → Protocol Translation    │
                    │  → Provider Adapter → Circuit Breaker       │
                    └──────────────────┬──────────────────────────┘
                                       │ forwards
                              ┌────────▼────────┐
                              │  LLM Providers  │
                              │  OpenAI, Anthropic, Custom, Local │
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

Each phase is an independent OpenSpec change with its own proposal, design, specs, and tasks. Changes are archived after completion.
