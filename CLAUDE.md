# CLAUDE.md — polyrouter (open-source LLM router)

## What this file is
The always-loaded operating rules for coding agents on this project. The **full architecture, rationale, data model, and acceptance criteria live in [`spec.md`](./spec.md)** — the reference spec. Read the relevant section of that spec before proposing or implementing anything. This file is the short version; **the spec wins on any specific detail**, and the invariants below are non-negotiable.

## What we're building
**polyrouter** — a self-hostable **LLM router / gateway**: one OpenAI- and Anthropic-compatible endpoint that sits between a user's AI agents and their LLM providers, routes each request to an appropriate model, adds fallbacks and spend limits, and records cost/tokens/latency. Local-first, no per-call markup, metadata-only by default. See §1 of the spec.

**Naming:** the app is **polyrouter**. Where the spec shows Manifest-branded examples (`mnfst_…` key prefix, `x-manifest-tier` header), use the polyrouter equivalents (`poly_…`, `x-polyrouter-tier`) — spec §16 forbids reusing the reference project's branding.

## How we work (spec-driven, OpenSpec)
- **No feature code without an approved change proposal.** Work is delivered as OpenSpec changes.
- Flow: `/opsx:explore` (when unsure) or `/opsx:propose <capability>` → **review `proposal.md` + `tasks.md` + spec deltas against `spec.md`** → implement `tasks.md` in order → `archive` (merges deltas into `openspec/specs/`).
- **Durable context lives in two places:** `openspec/project.md` (the constitution — stack, conventions, invariants) and `spec.md` (the full reference). Keep both in sync when a decision changes; open a change to do it, don't edit silently.
- **Implement only the current approved change's `tasks.md`.** If a task contradicts the spec or an invariant below, **stop and flag it** — never silently reinterpret scope.
- Prefer **small, single-capability changes** in dependency order (see build order). One capability ≈ one proposal.
- Lift each capability's "definition of done" from the spec's **§15 acceptance criteria** + the matching milestone; express them as WHEN/THEN scenarios in the delta spec.

## Build order & review gate (from spec §14)
Build in this order; each is roughly one capability/change:
1. **Foundation** — monorepo (Turborepo + npm workspaces), shared types, Drizzle + Postgres + Redis, **central tenant-scoping guard**, config + boot fail-fast.
2. **Auth & identity** — Better Auth (session plane) + **HMAC agent-API-key plane**, first-user-admin guard, auth-endpoint rate limiting.
3. **Provider layer** — adapter interface, OpenAI/Anthropic adapters, provider CRUD, **seed the bundled versioned pricing table**, **SSRF-validate base_urls**, Redis circuit breaker.
4. **Protocol translation core** — the OpenAI↔Anthropic normalization module **with golden-file contract tests** (§6.3). Everything downstream depends on this; do it before the proxy exits "happy path."
5. **Inference proxy — Layer 0** — endpoints, explicit / `x-polyrouter-tier` / default routing, fallbacks + **mid-stream commit policy**, RequestLog with **price snapshot**, streaming drain + backpressure.
   → **⛔ REVIEW GATE: stop here for human review.** This is the shippable core; do not proceed to automatic routing until it's approved.
6. **Auto routing — Layer 1 (structural)** — system-prompt fingerprinting + per-agent baseline, language-neutral features.
7. **Auto routing — Layer 3 (cascade)** — cheap-first + escalation. (Self-host feature target reached: L0 + L1 + L3.)
8. **Limits, alerts & notifications** — Redis atomic counters, block/alert, **SMTP + Apprise** channels, async delivery, dedup.
9. **Dashboard SPA** — SolidJS + uPlot; connect-agent flow, routing UI, **routing-decision inspector**, limits/notifications UI.
10. **Observability** — OTel traces + Prometheus metrics on the proxy.
11. **Packaging** — single-container Docker + compose (app/postgres/redis/optional apprise) + install script.
12. **Cloud graduations (deferred; only when flagged)** — Layer 2 embedding classifier + learning loop, split data-plane to Hono/Go, events to Timescale/ClickHouse.

## Tech stack — canonical, do not re-litigate (spec §3)
Pin these versions; do not substitute without a change proposal that says why.
- **Language:** TypeScript **strict** everywhere. Runtime **Node.js 24.x LTS**, npm 10–11 (Node 24 bundles npm 11).
- **Backend / control plane:** **NestJS 11**. **ORM: Drizzle** (NOT TypeORM). **PostgreSQL 16**.
- **Cache / atomic counters / queue:** **Redis** (+ a Redis-backed job queue, e.g. BullMQ).
- **Auth:** **Better Auth** (email/password + Google/GitHub/Discord OAuth).
- **Proxy contract:** OpenAI-compatible `/v1/chat/completions` + `/v1/models`; Anthropic-compatible `/v1/messages`.
- **Frontend:** **SolidJS** + **Vite**, **uPlot** for charts, custom CSS.
- **Monorepo/build:** **Turborepo** + npm workspaces. **Docker** is the primary distribution (single container: NestJS serves SPA + API + proxy on one port).
- **Data-plane split, embedding classifier, Timescale/ClickHouse are CLOUD-TIER ONLY** — do not add them to the baseline build.

## Repository layout (spec §4)
```
packages/
  shared/          # TS types, enums, constants (CJS + ESM)
  control-plane/   # NestJS: dashboard API, auth, provider/tier/rule CRUD, analytics
    src/{entities,analytics,auth,providers,routing-config,database/migrations}/
  data-plane/      # the proxy (a NestJS module in baseline; extractable later)
    src/{proxy,proxy/translate,routing,recording}/
  frontend/        # SolidJS SPA (Vite)
    src/{pages,components,services}/
```

## Non-negotiable invariants (a change that violates one fails review)
1. **Explicit routing is the reliable core.** `auto` and all "smart" layers are opt-in and **must degrade to explicit/default**. Never fail or stall a request because the smart router (embedding model, classifier) is unavailable. (§1, §7)
2. **Protocol translation is its own module** (`data-plane/proxy/translate/`) behind a `Normalized*` IR, backed by **golden-file contract tests**. Keep the proxy core protocol-agnostic; provider quirks stay in adapters. (§6.3)
3. **Mid-stream commit rule:** do not commit to streaming to the client until the upstream's **first token** arrives. Before that, fall back normally. After that, the model is committed — on upstream error, **terminate the stream with a clear terminal error; NEVER silently swap models**. (§6.3, §7.4)
4. **Cost is immutable.** Compute cost at request time against **snapshotted unit prices** stored on the RequestLog; never recompute historical cost against current prices. Flag missing/estimated usage (`usage_estimated`), never store silent nulls. Prices come from a bundled versioned table, not provider `/models`. (§7.7)
5. **Tenant isolation is mandatory and central.** Every access to an Agent/Provider/Model/RoutingRule/Limit/NotificationChannel/RequestLog is ownership-scoped (`WHERE owner = current_principal`). **No by-id fetch without an ownership guard.** Enforce in a shared repository/guard, not per-handler. (§11.1)
6. **SSRF: validate every user-supplied, server-fetched URL** (custom provider base_urls, Apprise/webhook targets, `APPRISE_API_URL`). Resolve and block private/loopback/link-local/metadata ranges (incl. IPv6; validate the resolved IP to defeat DNS rebinding). Loopback local models are the **only** exception, gated on `MODE=selfhosted`. (§8, §10.1, §11.2)
7. **API keys:** agent keys are **HMAC-SHA256 + prefix lookup**, fast-verified — **never bcrypt**. Session passwords use a slow hash (argon2/bcrypt). The two credential planes stay separate. (§3.2, §11)
8. **Privacy & secrets:** store **metadata only**; never persist prompt/response bodies unless the user explicitly opts in. Encrypt provider and notification-channel credentials at rest; **never log secrets**. (§1, §5, §8, §10.1)
9. **Hot path stays cheap:** do **not** run a full tokenizer for billing — use provider `usage`; estimate only for routing (`chars/4`). No per-request generative-LLM classification. (§3.2, §7.1, §7.7)
10. **Shared state is atomic in Redis.** Budget and rate counters must be correct across multiple proxy instances (no per-instance drift). (§3.2, §10)
11. **Notifications are async and resilient.** Deliver off the request path (queue/Redis); a slow or failing channel **must never block a request or budget enforcement**. Dedup/rate-limit alerts; a failed send logs and continues. (§10.1)
12. **Graceful shutdown drains in-flight streams; streaming applies backpressure** (no unbounded buffering to a slow client). (§3.2)

## Commands (maintain these scripts)
- `npm run dev` — control-plane (watch) + frontend (Vite) together
- `npm run build` — production build (shared → control-plane → frontend) via Turborepo
- `npm start` — start production server (serves SPA + API + proxy)
- `npm test -w packages/<pkg>` — unit tests (Jest for backend packages, Vitest for frontend/shared — spec §3.1)
- `npm run test:e2e -w packages/control-plane` — e2e (Supertest), incl. **protocol contract, SSRF, tenant-isolation, cost-immutability** suites
- `npm run db:generate -w packages/control-plane` / `npm run db:migrate` — Drizzle migrations (migrations run on boot)
- `npx changeset` — add a release note for any user-facing change

## Definition of done (every change)
- Tasks in `tasks.md` complete; code matches the approved delta spec.
- Tests written/updated and green — including the relevant **contract / SSRF / tenant-isolation / cost-immutability** checks where the change touches those areas.
- Migration generated if the schema changed; `npm run build` passes; lint clean; strict TS with no `any` escapes.
- Changeset added if user-facing.
- Spec/deltas updated and the change archived (source of truth stays current).

## Coding standards
- Strict TypeScript; global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`) on all input.
- Tenant scoping and secret encryption go through shared utilities, never re-implemented per endpoint.
- Conventional, present-tense commit messages explaining **why**.
- Keep PRs/changes focused on one capability.
- Gate self-host-only behavior (local providers, localhost auto-login, SSRF loopback exception) on `MODE=selfhosted`.
- UI work follows the [`STYLESEED.md`](./STYLESEED.md) design lock (one accent `#4F5DFF`, one focal point per screen) and must pass the `/ss-score` quality gate (≥ 80) before being shown.

## Do NOT
- Proxy through a central third party in self-host mode; add a per-call fee; persist prompt/response bodies without opt-in.
- Hardcode a closed provider allow-list (custom OpenAI/Anthropic endpoints must always be addable).
- Lead with a brittle rule-based auto-classifier, or call a generative LLM to classify every request.
- Swap models mid-stream after bytes are sent; recompute historical cost against current prices.
- Add cloud-tier infrastructure (data-plane split, embedding classifier, ClickHouse/Timescale) to the baseline build.
- **Compliance note:** reusing flat-rate *subscriptions* (ChatGPT Plus, Claude Max) programmatically likely violates those providers' ToS. Support it as a provider kind, but surface the risk to users; BYOK/API-key and local models don't carry it. (spec §16)

<!-- OPENWIKI:START -->

## OpenWiki

This repository uses OpenWiki for recurring code documentation. Start with `openwiki/quickstart.md`, then follow its links to architecture, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->
