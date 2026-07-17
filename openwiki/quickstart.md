---
type: Guide
title: Polyrouter Quickstart
description: Getting started with polyrouter — the self-hostable LLM router that gives you one endpoint for every model with smart routing, fallback chains, and budget enforcement.
tags: [quickstart, onboarding, getting-started]
resource: README.md
---

# Polyrouter Quickstart

Polyrouter is a self-hostable LLM router/gateway. It gives you **one OpenAI- and Anthropic-compatible endpoint** for every model, with smart routing, automatic fallbacks, spend limits, and metadata-only cost tracking. No markup. No third-party proxy.

## What You Get

- **One endpoint for every model** — agents send requests to polyrouter; it routes to OpenAI, Anthropic, custom providers, or local models
- [**Smart routing**](/openwiki/routing/engine.md) — explicit model naming, tier-based routing, and optional auto-routing with cascade escalation
- [**Fallback chains**](/openwiki/routing/engine.md) — automatic failover through ordered provider chains when upstreams fail
- [**Budget enforcement**](/openwiki/data-model/schema.md) — per-agent or global spend limits with alert and block actions
- [**Metadata-only cost tracking**](/openwiki/data-model/schema.md) — immutable cost records with snapshotted prices; prompt/response bodies are never stored
- [**Dashboard**](/openwiki/dashboard/overview.md) — SolidJS SPA for monitoring requests, managing providers, configuring routing, and viewing analytics

## Install (One Command)

```bash
curl -fsSL https://raw.githubusercontent.com/izzoa/polyrouter/main/install.sh | sh
```

This pulls the prebuilt Docker image, generates secrets into `.env`, and boots the full stack (app + PostgreSQL + Redis). The install script is idempotent — re-running refreshes the source and preserves your `.env`.

See [Deployment](/openwiki/operations/deployment.md) for Docker Compose details and configuration options.

## First API Call

Once running (default: `http://localhost:3000`), send a request using the OpenAI-compatible endpoint:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer poly_YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

Or use the Anthropic-compatible endpoint:

```bash
curl http://localhost:3000/v1/messages \
  -H "x-api-key: poly_YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

API keys are minted from the dashboard's [Agents page](/openwiki/dashboard/overview.md) or via the `/api/agents` endpoint. Keys use the `poly_` prefix with HMAC-SHA256 verification.

## Architecture at a Glance

```
Agent Request → polyrouter → Provider (OpenAI, Anthropic, custom, local)
                   ↓
            Budget Check → Route Resolution → Protocol Translation → Upstream Call
                   ↓
            Record Cost/Tokens/Latency → Return Response
```

The system is split into two planes:
- **Control Plane** ([`packages/control-plane/`](/openwiki/architecture/overview.md)) — NestJS backend handling auth, routing configuration, budget enforcement, notifications, and observability
- **Data Plane** ([`packages/data-plane/`](/openwiki/architecture/overview.md)) — framework-agnostic proxy engine handling routing resolution, protocol translation, and provider adapters

See [Architecture Overview](/openwiki/architecture/overview.md) for the full breakdown.

## Navigation

| Section | What It Covers |
|---------|---------------|
| [Architecture Overview](/openwiki/architecture/overview.md) | Monorepo structure, dual-plane design, technology stack, core invariants |
| [Request Flow](/openwiki/architecture/request-flow.md) | Full lifecycle of a request through the proxy |
| [Routing Engine](/openwiki/routing/engine.md) | Layer 0/1/3 routing, tiers, fallback chains, cascade logic |
| [Provider Adapters](/openwiki/providers/adapters.md) | Supported providers, protocol translation, circuit breakers |
| [Data Model](/openwiki/data-model/schema.md) | Database schema, tenant isolation, immutable costs |
| [Dashboard](/openwiki/dashboard/overview.md) | Frontend pages, design system, state management |
| [Security & Auth](/openwiki/security/auth.md) | Dual auth model, SSRF protection, encryption |
| [Deployment](/openwiki/operations/deployment.md) | Docker Compose, environment variables, install script |
| [Testing](/openwiki/testing/guide.md) | Test types, running tests, CI pipeline |

## Quick Reference

### Key Files

| File | Purpose |
|------|---------|
| [`CLAUDE.md`](/CLAUDE.md) | Agent operating rules and core invariants |
| [`STYLESEED.md`](/STYLESEED.md) | Frontend design system lock |
| [`FABLE_AUDIT.md`](/FABLE_AUDIT.md) | Security audit findings and resolutions |
| [`CONTRIBUTING.md`](/CONTRIBUTING.md) | Development setup and workflow |
| [`SECURITY.md`](/SECURITY.md) | Vulnerability reporting |

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
| Build | Turborepo + npm workspaces |
| Runtime | Node.js 24.x LTS |
| Packaging | Docker + Compose |

## Backlog

The following areas are deferred or pending future work:

- **Cloud Tier** (Layer 2 embedding classifier + learning loop) — deferred per spec; requires training data and ML infrastructure
- **Data-Plane Split** (extract proxy to Hono/Go) — performance optimization deferred until profiling shows need
- **Events Store** (Timescale/ClickHouse for high-volume logs) — deferred until `request_log` scale demands it
- **Organization/Workspace** (multi-seat teams) — schema stubs exist but features deferred
