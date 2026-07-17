# Build Spec: An Open-Source LLM Router (a "Manifest"-style app)

> Purpose: This document is a complete, implementation-ready brief for an LLM/AI coding agent to recreate an application functionally equivalent to **Manifest** (manifest.build / github.com/mnfst/manifest). Build a *similar* app; do not copy assets, branding, or proprietary text. Where a detail is not publicly documented, this spec marks it **[design inference]** and gives a sensible default you may implement or change.
>
> **v2 note:** This revision (a) restructures the tech stack into a **scale-tiered** recommendation that separates the control plane from the data plane, and (b) **replaces the routing engine** with a layered design that fixes the well-documented failure modes of naive rule-based complexity routing. Both changes are explained inline with rationale so the agent understands *why*, not just *what*.

---

## 1. What you are building

A **smart LLM router** (a.k.a. LLM gateway) that sits between a user's AI agents/apps and their LLM providers. It exposes **one OpenAI-compatible and Anthropic-compatible HTTP endpoint**. For every incoming chat-completion request, it decides *which model at which provider* should serve it, forwards the request, streams the response back, and records cost/tokens/latency.

The core value proposition: users already pay for LLM access in fragmented ways (flat-rate subscriptions like ChatGPT Plus/Claude Max, pay-per-token API keys, local models). This app lets them point any agent at a single URL and route each request to an appropriate/cheaper model — cutting spend substantially — while adding fallbacks and budget limits. It is **local-first / self-hostable**: the operator's requests flow through their own instance to their own provider accounts, not through a third-party proxy.

**One-liner:** "Route each LLM call to the right model through one endpoint, with automatic fallbacks and spend limits."

### Positioning (design constraints that follow from it)
- **Privacy:** In self-hosted mode, prompts/responses never leave the user's infrastructure except to go directly to the chosen provider. Store only metadata (tokens, cost, model, latency, timestamps) by default — not prompt/response bodies. Make body logging opt-in.
- **No markup:** The router does not resell tokens or take a per-call fee. Users pay providers directly with their own keys/subscriptions.
- **Transparency:** The routing decision must be inspectable — the user can see *why* a given model was chosen for a request.
- **Open source:** MIT-style license, cloud + self-hosted parity on the same codebase/DB backend.

### The routing philosophy (read this before §7)
**Explicit routing is the reliable core; automatic routing is an opt-in enhancement that must degrade gracefully.** The reference project shipped an automatic rule-based complexity classifier as its headline feature and then **deprecated it** because static rules proved brittle (system-prompt contamination, English-only, no way to keep up with new harnesses). The lesson baked into this spec: the dependable, zero-latency, language-neutral path is *explicit* (caller names a model, or a tier via header, or a default). Anything "smart" layers on top and can always fall back to explicit. See §7 for the full design.

---

## 2. Primary user flows

The product is essentially a 3-step onboarding plus an analytics dashboard:

1. **Connect an agent/harness.** User creates an "Agent" in the dashboard, which mints an API key. The UI shows a copy-paste snippet for their platform (OpenAI SDK, Anthropic SDK, Vercel AI SDK, LangChain, a generic cURL call, and popular personal-agent harnesses). The snippet just sets `base_url` to the router and `api_key` to the minted key — a drop-in replacement for the OpenAI/Anthropic base URL.
2. **Connect providers.** User adds one or more providers: an **API key** provider (BYOK), a **subscription** provider (reuse an existing flat-rate plan), a **custom** OpenAI/Anthropic-compatible endpoint, or a **local** model server. On connect, the app fetches/loads that provider's available models and their per-token prices.
3. **Configure routing + limits.** User assigns models to routing **tiers**, sets a default model + fallbacks, optionally defines header-based custom routes, and sets budget limits/alerts.
4. **Observe.** A dashboard shows requests over time, spend, tokens, top models, per-agent and per-provider breakdowns, and the routing decision for each request.

The "magic path": an agent calls model id `auto` → router resolves a tier → picks the best model in that tier from the user's connected providers → forwards → records. **`auto` is opt-in**; explicit model ids and header-selected tiers always work and are the recommended default for anyone who knows their workload.

---

## 3. Tech stack (scale-tiered)

### 3.0 The one structural idea: this is two systems, not one

The app has a **control plane** and a **data plane** with *opposite* requirements, and the biggest architectural decision is how much to separate them.

- **Control plane** — dashboard, auth, provider/tier/rule CRUD, analytics queries. Low request volume, rich domain logic, benefits from a batteries-included framework. NestJS + an ORM + a reactive SPA is an excellent fit.
- **Data plane** — the `/v1/chat/completions` proxy that scores, forwards, and **streams**. Latency-sensitive, high-concurrency, I/O-bound, holding many long-lived mostly-idle connections ("C10k for LLM streams"). Wants minimal per-request overhead, cheap concurrency, true multi-core parallelism, and careful backpressure.

Conflating them (one process, one port) is **correct for self-host** (simplicity wins) and a **liability at cloud/multi-tenant scale** (a proxy OOM kills your dashboard; a dashboard deploy severs in-flight streams; the CPU-bound scorer starves the event loop). The stack below is therefore split into a **baseline** (build this first; right for personal scale), **universal upgrades** (worth it at any scale), and **cloud-tier graduations** (only once real volume justifies them).

### 3.1 Baseline stack (build this first — correct for self-host / personal scale)

| Layer | Technology | Notes |
|---|---|---|
| Language | **TypeScript** (strict everywhere) | |
| Backend | **NestJS 11** | Modular; great for the control-plane API. Fine for the proxy at personal scale. |
| DB | **PostgreSQL 16** | Config *and* logs to start. |
| ORM | **Drizzle** (see 3.2 — do **not** use TypeORM) | SQL-first, type-safe, predictable migrations. |
| Auth | **Better Auth** | Email/password + Google/GitHub/Discord OAuth; localhost auto-login for self-host UX. |
| Router endpoint | OpenAI-compatible `/v1/chat/completions` (+ Anthropic-compatible `/v1/messages`) | The public contract. |
| Frontend | **SolidJS** + **Vite** | Fast, tiny bundle. |
| Charts | **uPlot** | Fastest option for dense time-series. |
| Cache/counters | **Redis** (see 3.2) | Needed the moment there's >1 instance, and useful before that. |
| Build | **Turborepo** + **npm workspaces** | |
| Runtime | **Node.js 24.x LTS**, npm 10–11 | Node 24 bundles npm 11; `engines` allows `>=10 <12`. |
| Tests | **Jest** + **Supertest** (backend), **Vitest** (frontend/shared) | |
| Packaging | **Docker** (single container: NestJS serves SPA + API + proxy on one port) | Primary distribution. |

### 3.2 Universal upgrades (apply at every scale — low risk, high payoff)

These are corrections to the reference stack that are worth doing *regardless* of scale. Prioritize them.

1. **Drizzle instead of TypeORM.** TypeORM 0.3's migration generation is famously flaky (occasionally destructive, occasionally silent misses), its hydration is slow, and maintenance is inconsistent. **Drizzle** is SQL-first, fully type-safe, has predictable migrations, and a tiny runtime — good for both relational config and a high-write log table. (Kysely is a lighter query-builder alternative; Prisma is DX-heavy but historically dragged a Rust engine binary that complicates Docker/serverless.) *For the `RequestLog` write path specifically, consider bypassing the ORM with batched parameterized inserts.* **Single best risk/reward change in the stack.**
2. **Redis for shared atomic state.** In-memory counters break the instant you run more than one proxy instance — users blow budgets each instance thinks are fine. Use Redis for: **atomic budget/rate counters** (`INCR` + expiry, or a token-bucket Lua script); **hot config/pricing cache** with pub/sub invalidation; a shared provider **circuit breaker** so all instances route around a rate-limited provider; and (optionally) an **async log buffer** so writing `RequestLog` doesn't sit synchronously in the request path.
3. **Fast-hash agent API keys — do NOT bcrypt them.** Session *passwords* need slow hashes (argon2/bcrypt). Agent *API keys* are high-entropy random tokens verified on **every proxy call**; bcrypt-ing them burns 50–100ms of CPU per request for no security gain. Use a **fast keyed hash (HMAC-SHA256)** with a stored key **prefix** for O(1) lookup. Common and costly mistake.
4. **Kill exact input tokenization on the hot path.** If the router runs a full BPE tokenizer (tiktoken) per request just to count input tokens, that's largely wasted: **the provider returns exact `usage` in its response**, which is the authoritative source for billing. Routing only needs a *rough* size estimate (`chars/4` is fine). Move exact counts to the provider response; keep the hot path cheap.
5. **Graceful shutdown + streaming backpressure.** On deploy/restart, **drain in-flight streaming connections** instead of severing live completions mid-token. And ensure a slow client applies backpressure to the upstream (pipe correctly) so a flood of tokens to an unread socket can't buffer unboundedly and OOM the process. Both are easy to botch and very visible to users.
6. **Observe your own proxy.** Add **OpenTelemetry** traces (spans: auth → scorer → upstream call → DB write) and **Prometheus** metrics. The gateway should be at least as observable as the observability it sells — you need to attribute latency/errors per provider and per routing layer.

### 3.3 Cloud-tier graduations (only once multi-tenant volume justifies them)

Doing these *before* you have volume is premature optimization that hurts velocity and self-host simplicity. Reach for them when the cloud tier is real.

1. **Split the data plane from the control plane.** Extract the proxy into its own deployable service so it scales, deploys, and fails independently of the dashboard. Best runtime choices: **Hono** (streaming-first, runtime-agnostic, a fraction of NestJS's per-request cost — it's what several production gateways run on) or, if you want true multi-core CPU parallelism for the scorer, **Go** (cheap goroutines, excellent stdlib HTTP). Keep NestJS for the control plane. *Rationale:* Node's single event loop + a synchronous CPU-bound scorer is fine at personal scale but hits a hard ceiling under multi-tenant load (2ms of scorer CPU × 1000 rps = 2s of event-loop time per second, on one core, before any real work).
2. **Move events off Postgres.** The dashboard is an OLAP workload (append-heavy writes + time-bucketed `GROUP BY` over millions of rows) bolted onto an OLTP database; they contend as logs grow. In increasing order of effort: **(a) TimescaleDB** — hypertables auto-partition by time, *continuous aggregates* make dashboard rollups incremental and cheap, columnar compression shrinks old chunks, same SQL/client; **(b)** native monthly **partitioning** + **BRIN index** on `created_at` (ideal for append-only time-ordered data) + precomputed rollup tables; **(c) ClickHouse** for events with Postgres retained for config (the path mature LLM-observability tools like Langfuse took). **Keep config in Postgres** — it's the right default there.
3. **Distributed circuit breaking + async log ingestion** via Redis/streams as instance count grows (see 3.2 items 2 and its log-buffer note).

### 3.4 Frontend (leave it mostly alone)

SolidJS (fast, tiny bundle) + uPlot (fastest dense time-series charts) is the strongest part of the stack. Two honest trade-offs, not defects: Solid's ecosystem/contributor pool is much smaller than React's, which matters for an **OSS project courting contributors** (React lowers that barrier at some perf cost); and uPlot is low-level/imperative, so rich interactions (zoom, annotations, tooltips) are more manual than ECharts or Observable Plot. Both are justified if fast dashboards are core — just named so the choice is deliberate.

### 3.5 Summary: what to build when

| Concern | Baseline (self-host) | Universal upgrade | Cloud graduation |
|---|---|---|---|
| ORM | — | **Drizzle** (not TypeORM) | batched inserts for logs |
| Shared counters | in-proc OK for 1 instance | **Redis** atomic counters | Redis + circuit breaker |
| API-key verify | — | **HMAC-SHA256 + prefix** | — |
| Input tokens | — | **provider `usage`**, est. only for routing | — |
| Proxy runtime | NestJS (one process) | graceful drain + backpressure | **Hono/Go**, separate service |
| Events store | Postgres | partition + BRIN + rollups | **Timescale → ClickHouse** |
| Observability | — | **OTel + Prometheus on proxy** | per-tenant dashboards |

---

## 4. Repository structure

Monorepo (Turborepo + npm workspaces):

```
packages/
├── shared/          # TS types, enums, constants shared by all sides.
│                    # Canonical supported-agent list + provider definitions.
│                    # Build to CJS + ESM.
├── control-plane/   # NestJS: dashboard API, auth, provider/tier/rule CRUD, analytics.
│   └── src/
│       ├── entities/       # Drizzle schema/models
│       ├── analytics/      # dashboard aggregation queries
│       ├── auth/           # Better Auth, sessions, API-key guard
│       ├── providers/      # provider adapters + model catalog/pricing
│       ├── routing-config/ # tiers, rules, fallback ordering (CRUD only)
│       └── database/migrations/
├── data-plane/      # The proxy. Baseline: a NestJS module inside control-plane.
│                    # Cloud graduation: extract to its own Hono/Go service.
│   └── src/
│       ├── proxy/          # /v1/chat/completions + /v1/messages, streaming
│       ├── routing/        # the layered decision pipeline (see §7)
│       └── recording/      # RequestLog writer (batched / Redis-buffered)
└── frontend/        # SolidJS SPA (Vite)
    └── src/{pages,components,services}/
```

> Baseline keeps `data-plane` as a module compiled into the single NestJS server (one container, one port). The directory boundary exists from day one so the cloud-tier extraction (3.3) is a lift-and-shift, not a rewrite.

**Deployment topology:** Baseline — NestJS serves the built SPA *and* the API/proxy on one port. Dev — Vite on `:3000` proxies `/api` and `/v1` to the backend on `:3001`; CORS only in dev.

---

## 5. Data model

**[Partly design inference]** — a complete, workable schema (Drizzle). Adjust names freely.

- **User** — id, email, name, credentials (Better Auth), OAuth identities, created_at. First user on a fresh self-hosted instance is **admin**.
- **Organization / Workspace** *(for multi-seat "team" tier)* — id, name, owner_user_id. Providers/agents/limits can scope to an org.
- **Agent** — id, user/org id, name, **api_key_hash** (HMAC-SHA256), **api_key_prefix** (for O(1) lookup; full key shown once, format e.g. `mnfst_…`), harness_type (enum from shared: openai_sdk, anthropic_sdk, vercel_ai_sdk, langchain, curl, openclaw, hermes, …), created_at, last_used_at.
- **Provider** — id, user/org id, name, kind (`api_key`|`subscription`|`custom`|`local`), protocol (`openai_compatible`|`anthropic_compatible`), base_url, encrypted_credentials (encrypt at rest), health/status, created_at.
- **Model** — id, provider_id, external_model_id, display_name, capabilities (context window, tools/vision/reasoning flags), input_price_per_1m, output_price_per_1m, is_free, last_synced_at. Prices/capabilities are seeded from a **bundled pricing table**, not scraped from provider `/models` (which usually omit price) — see §7.7.
- **Tier** — id, user/org id, key (`default` + user-defined; the reference is collapsing the old `standard/complex/reasoning` complexity tiers onto a single `default`), display_name, description. Ships with `default` seeded.
- **RoutingEntry** — join Tier ↔ Model with **ordered priority**: position 0 = primary, 1..N (cap **5**) = fallbacks. A model may appear in multiple tiers.
- **RoutingRule** — id, user/org id, match_type (`header`|`default`), header_name (default `x-manifest-tier`), header_value, target (tier or specific model/provider), priority.
- **RequestLog** — id, agent_id, provider_id, model_id, tier_assigned, **decision_layer** (which layer of §7 decided: `explicit`|`header`|`default`|`structural`|`semantic`|`cascade`), **routing_reason** (structured, human-readable), input_tokens, output_tokens (from provider `usage`), **input_price_snapshot / output_price_snapshot** (unit prices used, so `cost` is immutable — §7.7), **usage_estimated** (bool), cost, duration_ms, status (`success`|`error`|`fallback`|`escalated`), **escalated** (bool), **quality_signal** (nullable; from cascade checks / feedback), created_at. Powers all analytics. **No prompt/response bodies unless opted in.** Index on created_at, agent_id, provider_id, model_id.
- **Limit / Budget** — id, scope (global|org|agent), threshold_amount, window (day|week|month), action (`alert`|`block`), notify_channel_ids (FK → NotificationChannel; which channels fire on `alert`), created_at. **Live spend counters live in Redis** (atomic), reconciled against RequestLog.
- **NotificationChannel** — id, user/org id, name, kind (`smtp`|`apprise`), enabled (bool), config (**encrypted at rest**: SMTP host/port/user/pass/from/to for `smtp`; one or more Apprise URLs for `apprise`), events_subscribed (csv of event types: `budget_alert`, `budget_block`, `provider_down`, `request_failures_spike`, …), created_at, last_test_at/last_test_status. Configured in **Settings → Notifications** (§9); delivery layer in §10.1.
- **RoutingDecisionCache** *(optional, for §7 Layer 2)* — key (feature-hash / quantized embedding), tier, created_at, ttl. Backed by Redis in practice; a table is only needed for warm-start/analytics.

Manage schema with Drizzle migrations; run on boot.

---

## 6. Public API surface

### 6.1 Inference proxy (the contract agents depend on)
- **`POST /v1/chat/completions`** — OpenAI-compatible. Accept standard body (`model`, `messages`, `stream`, `temperature`, `tools`, …). Support **SSE streaming** and non-streaming. Auth: `Authorization: Bearer <agent_api_key>` (HMAC verify, §3.2).
  - `model` = `auto` sentinel → run the layered pipeline (§7).
  - `model` = a real model/tier/alias → honor it (fallbacks still apply).
  - Honor custom-routing headers (default `x-manifest-tier: <tier>`) to force a tier.
  - Translate to the chosen provider's protocol and back so the client always gets an OpenAI-compatible response. **This normalization is the single hardest part of the build — see §6.3.**
- **`GET /v1/models`** — the user's available models/aliases (incl. `auto`).
- **Anthropic-compatible surface** — accept `/v1/messages`-shaped requests and normalize into the same pipeline so Anthropic-SDK agents are a drop-in too.

**Proxy auth:** a guard resolving `Bearer <key>` → Agent via prefix lookup + HMAC compare; reject unknown/disabled; stamp `last_used_at`.

### 6.2 Management REST API (dashboard SPA, under `/api`, session-authenticated)
CRUD + actions for: Agents (list/create/rotate-key/delete + per-harness snippet), Providers (list/create/test-connection/sync-models/delete), Models (list/filter/refresh-pricing), Tiers & RoutingEntries (order, assign/unassign, set primary+fallbacks), RoutingRules (CRUD header→tier/model), Limits (CRUD), Analytics (§9), Auth (Better Auth routes). Global `ValidationPipe` with `whitelist: true`, `forbidNonWhitelisted: true`.

### 6.3 Protocol translation & streaming (the hard part — budget the most time here)
"Translate to the provider's protocol and back" hides the single hardest part of the app, and it's where most bugs will live. Every request is normalized OpenAI ⟷ chosen-provider, and OpenAI Chat Completions vs Anthropic Messages differ in ways that break naive passthrough:
- **System prompt:** OpenAI puts it in the `messages` array (`role:"system"`); Anthropic uses a top-level `system` field.
- **Tool calling:** OpenAI `tool_calls` (with **stringified-JSON** `arguments`) plus a follow-up `role:"tool"` message vs Anthropic `tool_use` / `tool_result` **content blocks**. Multi-turn tool conversations are the #1 thing an agent gets wrong.
- **Streaming events:** OpenAI SSE `chat.completion.chunk` deltas vs Anthropic's `message_start` / `content_block_start` / `content_block_delta` / `message_delta` / `message_stop` sequence. The translator reassembles one into the other, token by token.
- **Stop reasons:** OpenAI `finish_reason` (`stop`/`length`/`tool_calls`/…) vs Anthropic `stop_reason` (`end_turn`/`max_tokens`/`tool_use`/…) — map both ways.
- **Multimodal:** different image block shapes/encodings (data URLs vs base64 source objects).
- **Usage:** different field names; Anthropic reports cache-read/write tokens separately — preserve them for cost (§7.7).

**Build it as its own module** (`data-plane/proxy/translate/`) with a clean `Normalized*` intermediate representation and one `in`/`out` adapter per protocol, so the proxy core stays protocol-agnostic. Critically, back it with a **golden-file contract test suite**: record real responses from each provider across a matrix (plain, multi-turn, tool-call round-trip, streamed, multimodal, error) and assert the normalization round-trips. Treat any provider that deviates from spec (many do) as a per-adapter quirk, not a special case sprinkled through the proxy.

**Mid-stream fallback policy (state this explicitly — the fallbacks in §7.4 are otherwise silently wrong under streaming).** Fallback is only transparent *before* the client has received any bytes. Rule: **do not commit to streaming to the client until the upstream returns its first successful token/event.** Failures up to that point (connection error, non-2xx, immediate 429) walk the fallback chain normally. Once the first token has been forwarded the model is **committed** — a mid-stream upstream error must terminate the client stream with a clear terminal error event (logged `status=error`), and must **never** silently swap to another model (which would splice two models' partial outputs into one response). Optionally buffer the first chunk / first N ms to widen the pre-commit fallback window at a small latency cost (make it configurable).

---

## 7. The routing engine (rewritten: a layered, degradable pipeline)

### 7.1 Design rationale — learn from the reference's mistake
The reference project led with an automatic **rule-based complexity/specificity scorer** (a "23-dimension" heuristic over the prompt) and then **deprecated it** (announced Jun 2026, removal Sep 2026; see `manifest.build/blog/deprecating-rule-based-routing/`). Its stated failure modes:

1. **System-prompt contamination** — harnesses (OpenClaw, Hermes, …) inject huge system prompts that push *every* request into the "complex" bucket, and the endless proliferation of third-party harnesses with different preambles makes hand-coded coverage hopeless.
2. **English-only** — keyword/semantic rules don't generalize across languages.
3. **The "just use an LLM classifier" fix taxes everyone** — a dedicated classification model adds latency + cost to *every* request, which most users don't want.

Their remedy was to **retreat to explicit routing** (default tier + `x-manifest-tier` header). This spec keeps that reliable core **and** re-introduces automatic routing done correctly — as opt-in layers that fix all three failure modes and always fall back to explicit.

### 7.2 The pipeline (evaluate in precedence order)

**Layer 0 — Explicit routing. Always wins. Zero latency. Language-neutral. This is the dependable core.**
- Request names a concrete model/provider → use it.
- `x-manifest-tier` header → map via RoutingRule to a tier/model. (Return a clear error if the target tier has no models.)
- Otherwise → the `default` tier.
- Fallbacks (§7.4) apply in all cases.
- *This layer alone is a complete, shippable product.* Everything below is enhancement.

**Layer 1 — Cheap structural pre-classification. Opt-in (`auto`). Sub-millisecond. Language-agnostic. Fixes problems 1 & 2.**
- **De-contaminate the system prompt** (fixes problem 1): score the **last user turn + recent context**, not the system block. **Fingerprint** the system prompt (hash) and **learn a per-agent baseline**; subtract anything constant across that agent's traffic — boilerplate that's identical on every request carries zero complexity signal by definition. Measure the *delta*, not the preamble.
- **Language-neutral features only** (fixes problem 2): effective input size (excluding boilerplate), presence/size of code blocks (code is code in any language), **tool/function-definition count**, structured-output demand (JSON schema present), multimodal content present, conversation depth, requested `max_tokens` / reasoning flags. **No natural-language keyword matching.**
- Confident high/low → assign tier immediately. **Most traffic exits here** at near-zero cost.

**Layer 2 — Semantic classification. Opt-in. Only when Layer 1 is ambiguous. Fixes problem 3 (no per-request generative call).**
- Embed the cleaned request with a **small multilingual embedding model run locally** (e.g. BGE-M3 / multilingual-e5, ONNX/GGUF, tens of millions of params, sub-10ms on CPU, never leaves the box). Embedding a short string is orders of magnitude cheaper than a chat completion — this is the "specialized model" idea done *cheaply*, and it's multilingual by construction.
- Classify the embedding with a cheap head: **nearest-centroid** or a small trained classifier (logistic regression / tiny MLP) over the embedding → tier.
- **Cache the decision** in Redis keyed on a quantized-embedding / feature hash. Harness traffic is highly repetitive, so after warmup this layer is mostly O(1) cache hits — the expensive path runs on a small minority of requests.

**Layer 3 — Empirical cascade (escalation). The escape hatch for genuine uncertainty. Turns a hard prediction into an easy detection.**
- Predicting difficulty up front is hard; *detecting a bad answer* is easier. For ambiguous, cheap-to-try requests, route to the **cheap model first** and **escalate** to a stronger tier only if a cheap quality check fails: malformed/invalid output, refusal, low self-reported confidence, or verifier/self-consistency disagreement. (Canonical reference: FrugalGPT-style LLM cascades.)
- Record the escalation on the RequestLog (`escalated=true`, `quality_signal`).

**Cross-cutting — Learn from outcomes (offline; never on the hot path).**
- Log (features/embedding, model, success, latency, cost, quality_signal) per request. Periodically **retrain the Layer-2 head** and **update per-cluster model preferences via a contextual bandit** (explore occasionally, exploit the cheapest model that historically met quality for similar requests). New harnesses and new models get **absorbed automatically** instead of someone rewriting static rules — directly defeating the treadmill that killed the reference's approach. (Related: RouteLLM-style learned preference routing, tunable on a cost/quality dial.)

**Guardrails — graceful degradation is mandatory.**
- If the embedding model or classifier is unavailable/slow, **fall back to Layer 0/1** (explicit / structural / default). **Never fail or stall a request because the smart router is down.**
- Every decision stores its `decision_layer` + `routing_reason` so the dashboard can show *why* (the transparency requirement).
- Ship sensible defaults so `auto` works with zero tuning; expose thresholds/weights for power users.

### 7.3 How the layers map to the three problems

| Failure mode (from the reference) | Fixed by |
|---|---|
| System prompt makes everything "complex" | L1 system-prompt fingerprinting + per-agent baseline subtraction; score the user turn |
| English-only | L1 language-neutral structural features + L2 multilingual embeddings (no keywords) |
| LLM classifier taxes every request | L1 exits most traffic for free; L2 uses a tiny local embedding model + Redis cache; L3 cascades cheap-first |
| Static rules can't keep up with new harnesses | Outcome logging + bandit/retraining absorb new harnesses/models automatically |

### 7.4 Fallbacks (unchanged, applies to every layer)
Up to **5** models per tier, ordered. Trigger on provider error, timeout, 429/rate-limit, or retired/unknown model. Walk the chain until one succeeds; record which model served and why earlier ones failed. The client gets a working response whenever any chain member succeeds. **Streaming caveat:** transparent fallback is only possible *before* the first byte reaches the client — see the mid-stream commit policy in §6.3.

### 7.5 Recording (unchanged)
Every routed request writes a RequestLog row (tokens from provider `usage`, computed cost, duration, model/provider, tier, decision_layer, reason, status). Automatic. `cost = (in/1e6)*in_price + (out/1e6)*out_price`, computed **at request time** against the price then in effect and stored immutably (§7.7).

### 7.6 Scale guidance for routing
- **Self-host / personal:** ship **Layer 0 + Layer 1 (+ optional Layer 3 cascade)**. No embedding model to run, no learning infra — cheap, reliable, language-agnostic, and it already fixes the two worst failure modes. This is the honest default.
- **Cloud / scale:** add **Layer 2 (embedding classifier + cache)** and the **learning loop**, which are where the cost of running/maintaining a model pays for itself across many tenants.

### 7.7 Pricing data & cost accuracy
Cost tracking is a headline feature, so treat pricing as real data, not an afterthought:
- **Where prices come from:** provider `/models` endpoints mostly **do not return prices**, and there is no universal pricing API (this is why the reference project maintains its own open model-parameter database). Ship a **bundled, versioned pricing + capability table** (input/output per-1M, context window, tool/vision/reasoning flags, cache-token prices) seeded from a maintained source (e.g. the LiteLLM or models.dev pricing JSON), with a **refresh mechanism** (periodic pull + manual override in the UI). Custom/local models let the user enter prices (local = free).
- **Compute at request time, store immutably:** compute `cost` when the request completes using the unit prices **then in effect**, and **snapshot those unit prices onto the RequestLog** (`input_price_snapshot`/`output_price_snapshot`, §5). Never recompute historical cost against current prices — a price change must not silently rewrite past spend (which would corrupt budgets and analytics). An effective-dated `ModelPrice` table (model_id, prices, valid_from) is the clean way to version the catalog.
- **Missing / partial usage:** some providers omit `usage`, send it only in the final streamed chunk, or drop it on error. Fallback: prefer provider `usage`; else estimate output tokens from the streamed text and input from the request (rough `chars/4` or a cached tokenizer count) and set `usage_estimated=true` so dashboards don't show null or false-precise costs.

---

## 8. Provider abstraction

Four provider **kinds** behind one adapter interface (`chat(request) → normalizedResponse`, `listModels() → Model[]`, `testConnection()`):

- **API-key (BYOK):** paste a key for a known provider (OpenAI, Anthropic, Google Gemini, DeepSeek, xAI, Mistral, Qwen/Alibaba, MiniMax, Kimi/Moonshot, Z.ai/Zhipu, OpenRouter, Groq, Cohere, …). Pull models + pricing. Billed by provider to the user's key.
- **Subscription:** reuse a flat-rate plan where allowed (ChatGPT Plus/Pro/Team, Claude Max/Pro, GitHub Copilot sub, MiniMax coding plan, Z.ai GLM coding plan, Ollama Cloud). Lower rate limits → nudge users to add pay-per-token fallbacks. **Prefer subscription quota first, fall back to paid API when limits hit.**
- **Custom:** any **OpenAI- or Anthropic-compatible** endpoint — user supplies base_url + key + protocol. Never restrict to a known list. **The base_url is user-supplied and fetched by the server — validate it against SSRF (§11.2).**
- **Local (self-hosted only):** **Ollama, LM Studio, llama.cpp** as first-class (OpenAI-compatible local servers). Mark free. Not offered in cloud.

Also support a curated **free-models** list (e.g. free tiers via OpenRouter) so simple traffic can go to $0 models; `is_free` flag on Model.

**Reliability:** wrap each provider in a **circuit breaker** (shared via Redis across instances — §3.2) so a rate-limited/down provider is skipped fast. Encrypt credentials at rest; never log them; `testConnection()` does a cheap validating call.

---

## 9. Analytics dashboard (SolidJS + uPlot)

- **Overview:** messages over time (uPlot), total spend, tokens, request count, success/fallback/escalation rates; date-range selector.
- **Requests / logs:** table of RequestLog — model, provider, tier, tokens, cost, latency, status, **decision_layer + routing_reason** (the "why this model" inspector — the transparency feature).
- **Costs:** spend by model/provider/agent/tier; top models by tokens; free vs paid split.
- **Agents:** manage, per-agent usage/spend, rotate keys, connection snippets.
- **Providers:** manage, health/circuit-breaker state, re-sync catalogs, per-provider usage.
- **Routing:** configure tiers, assign models, set primary+fallbacks (drag to reorder), define header rules; toggle `auto` layers.
- **Limits:** budgets, alert-vs-block, and which notification channels fire.
- **Settings / Auth:** account, OAuth, org/team, and **Notifications** — add / edit / enable notification channels (**SMTP** and/or **Apprise**), subscribe each channel to specific event types, and **send a test notification** to confirm delivery before relying on it (see §10.1).

Aggregations live in the control-plane `analytics/` module (time-bucketed `GROUP BY` over RequestLog; graduate to Timescale continuous aggregates / ClickHouse per §3.3).

---

## 10. Cost limits, alerts & notifications
Budgets scoped global/org/agent over a **resetting UTC calendar window** (day/week/month) — the "until reset" language below means the counter zeroes at the calendar boundary (the current day/ISO-week/month), not a trailing sliding window; a true sliding window is deferred. Action = **alert** (notify at threshold) or **block** (reject new requests for that scope with a clear error until reset). **Current spend tracked via Redis atomic counters** (correct across instances), reconciled against RequestLog — the reconciliation loop is the single writer that recomputes each budget's current-period spend from RequestLog and sets the shared counter (so the counter can't double-count or race), which makes block an **asynchronously-metered postpaid soft cap** (enforcement is eventually-consistent within the reconcile interval; admitted-in-flight requests may overshoot). Evaluate block in the request path (bounded, with a named fail-open/closed contract); evaluate alerts on a schedule.

### 10.1 Notification delivery (SMTP + Apprise)
Decouple *what triggers a notification* from *how it's delivered*. The app emits **events** — `budget_alert`, `budget_block`, `provider_down` / circuit-open (§8), `request_failures_spike`, and (optional) `weekly_spend_summary` — into a small notification service that fans each event out to whichever **NotificationChannel**s (§5) are enabled and subscribed to it. Users manage channels in the **Settings → Notifications** panel. Support **two channel kinds** (either or both):

- **SMTP (built-in email, zero extra dependencies).** User supplies host, port, username, password/app-password, TLS/STARTTLS mode, from-address, and recipient(s); send via a standard mailer (e.g. Nodemailer). This is the no-infrastructure default so email alerts work out of the box on self-host.
- **Apprise (one integration → 100+ services).** The homelab-standard fan-out. Users paste one or more **Apprise URLs** (e.g. `discord://…`, `tgram://…`, `slack://…`, `ntfy://…`, `gotify://…`, `mailto://…`, `pover://…`), so a single channel can reach Discord / Telegram / Slack / ntfy / Gotify / Pushover / email / etc. Support **both** integration modes: (a) POST to a running **Apprise API** container (`caronc/apprise`) over HTTP — keeps the app runtime-agnostic and is the recommended default; or (b) shell out to the Apprise CLI/library where installed. Because Apprise also handles email, users who prefer URL-based config can skip SMTP entirely.

Requirements: **encrypt channel credentials at rest** (SMTP passwords, and Apprise URLs that may embed tokens); never log them. Provide a **"Send test notification"** button per channel that delivers a sample event and surfaces success/failure inline (persist `last_test_status`). Deliver **asynchronously** (worker / Redis-buffered) so a slow or failing channel never blocks the request path or a budget check. **De-duplicate / rate-limit** alerts (e.g. at most one `budget_alert` per window per scope) so a budget hovering at threshold doesn't spam every channel. If a send fails, log and continue — a broken Discord webhook must never stall budget enforcement. Treat user-supplied Apprise / webhook targets (and `APPRISE_API_URL`) as server-fetched URLs and apply the same **SSRF** validation as custom providers (§11.2). Both kinds are available self-hosted **and** in cloud (cloud may restrict outbound SMTP hosts).

---

## 11. Auth
Better Auth (or equivalent): email/password + Google/GitHub/Discord OAuth. **Self-host UX:** frictionless localhost auto-login; first account = admin; optional `SEED_DATA` default admin for dev. **Two credential planes:** session cookies for the dashboard/management API; **agent API keys (Bearer, HMAC-verified with prefix lookup — §3.2)** for the proxy. Keep them separate.

### 11.1 Tenant isolation (non-negotiable)
Every data access is scoped to the authenticated principal (user, or org for shared resources). **No endpoint fetches an Agent, Provider, Model, RoutingRule, Limit, NotificationChannel, or RequestLog by id without an ownership guard (`WHERE owner = current_principal`).** This is the most common way apps like this leak (IDOR): an agent implementing CRUD will happily return another tenant's row by id unless scoping is enforced. Enforce it centrally (shared repository/guard layer), not per-handler, and cover it with cross-tenant read tests (§15).

### 11.2 Outbound-URL safety (SSRF)
Custom providers (§8) and notification targets (§10.1) let a user hand the **server** an arbitrary URL it will then fetch — an SSRF vector, and a serious one in multi-tenant cloud: a URL pointed at `169.254.169.254`, `localhost`, or an internal service can exfiltrate cloud-metadata credentials or reach private infra. For every user-supplied, server-fetched URL: resolve and **block private / loopback / link-local / metadata IP ranges** (incl. IPv6 and IPv4-mapped/NAT64, and defend against DNS rebinding by validating the *resolved* IP **at connect time (before the socket connects)**, not just the hostname), **require https for remote destinations** (`http` only for a proven-loopback or explicitly-allowlisted endpoint — hardened from "prefer" by the `add-ssrf-url-guard` change), optionally allowlist (address- and port-bounded — an allowlist can relax private LAN ranges but never metadata/loopback), and apply network egress controls in the cloud deployment. Redirects are followed only same-origin (cross-origin redirects are refused so credentials never leak). Local-model providers are the deliberate exception in **self-hosted** mode (loopback is the point) — gate that relaxation on `MODE=selfhosted`.

### 11.3 Auth endpoint protection
Rate-limit / throttle the **registration, login, and password-reset** endpoints (brute-force and account-enumeration protection) — distinct from the per-agent budget/rate limits (§10), which protect spend, not the auth surface. Guard the **first-user-becomes-admin** step against a concurrent-signup race with a transaction / advisory lock, so two simultaneous first signups can't both claim admin.

---

## 12. Configuration & environment

All configuration is environment variables, assembled from per-namespace Zod fragments (each subsystem's
`*.config.ts` calls `registerConfig(...)`) and validated once at boot by `loadConfig()`
(`packages/shared/src/config/registry.ts`): boot **fails fast and names each offending variable, never
its value**. New config goes through the registry, not raw `process.env`. The list below is the full
registered surface; the packaged compose fixes the deploy-invariant ones itself (`BIND_ADDRESS=0.0.0.0`,
`MODE=selfhosted`, `NODE_ENV=production`, service-network `DATABASE_URL`/`REDIS_URL`, the auth URLs) and
passes the optional tunables through from `.env`.

```
# --- core / boot ---
PORT=3001                          # HTTP listen port
BIND_ADDRESS=127.0.0.1             # loopback by default for self-host safety (compose sets 0.0.0.0)
NODE_ENV=development|production|test   # `production` disables ALL dev-secret fallbacks + serves the SPA
MODE=selfhosted|cloud              # gates local providers, auto-login, the SSRF loopback exception, dev fallbacks

# --- database / redis (localhost defaults — MUST override in production) ---
DATABASE_URL=postgresql://user:pass@host:5432/db   # default postgresql://polyrouter:polyrouter@localhost:5432/polyrouter
REDIS_URL=redis://localhost:6379   # breaker state, budget counters, rate limits, queues

# --- auth & identity (the four hex secrets are REQUIRED IN PRODUCTION) ---
BETTER_AUTH_SECRET=<32-byte hex>   # session signing — required in prod (openssl rand -hex 32)
API_KEY_HMAC_SECRET=<32-byte hex>  # agent-API-key HMAC — required in prod
PROVIDER_CREDENTIAL_KEY=<32-byte hex>  # encrypts provider credentials at rest — required in prod
NOTIFY_CREDENTIALS_SECRET=<32-byte hex>  # encrypts notification-channel credentials at rest — required in prod
BETTER_AUTH_URL=http://127.0.0.1:3001  # public auth base URL (cookies/redirects) — set when exposing
DASHBOARD_ORIGIN=http://localhost:3000 # allowed CORS origin — set to the real dashboard origin
TRUSTED_PROXY_CIDRS=                # csv CIDRs trusted for X-Forwarded-For (empty ⇒ proxy headers untrusted)
SEED_DATA=false                    # seed a dev admin (self-host, non-prod, loopback only)
# OAuth (a provider is offered only when BOTH id AND secret are set):
GOOGLE_CLIENT_ID= GOOGLE_CLIENT_SECRET=
GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET=
DISCORD_CLIENT_ID= DISCORD_CLIENT_SECRET=
# Dev-only: with NODE_ENV≠production AND MODE=selfhosted AND loopback-bound, the four hex secrets fall back
# to FIXED, PUBLICLY-KNOWN constants (identical on every install) — never run a reachable instance that way.

# --- proxy (hot-path bounds) ---
PROXY_MAX_BODY_BYTES=10485760       # 10 MiB /v1 request cap
PROXY_FIRST_EVENT_TIMEOUT_MS=30000  # time-to-first-byte/event abort — raise for slow local models
PROXY_EVENT_TIMEOUT_MARGIN_MS=500   # core per-event bound = first-byte + margin (adapter timeout wins pre-headers)
PROXY_IDLE_TIMEOUT_MS=30000         # buffered-read inter-chunk idle deadline — raise for slow models

# --- routing (smart layers; explicit routing is always on) ---
ROUTING_AUTO_LAYERS=structural      # csv: smart layers on. DEFAULT OMITS cascade — set structural,cascade to enable L3
ROUTING_STRUCTURAL_HIGH_THRESHOLD=0.6   # must be > LOW (cross-field boot check)
ROUTING_STRUCTURAL_LOW_THRESHOLD=0.25
ROUTING_STRUCTURAL_BASELINE_ALPHA=0.2   # baseline EWMA alpha ∈ (0,1]
ROUTING_STRUCTURAL_WEIGHTS=         # optional JSON weight override (validated, normalized)
ROUTING_CASCADE_QUALITY_THRESHOLD=0.5   # cascade escalates below this quality
ROUTING_CASCADE_CHEAP_TIMEOUT_MS=30000  # cheap-leg drain bound so a hung upstream still escalates

# --- budgets / spend limits ---
BUDGET_FAIL_OPEN=true              # on a Redis/enforcement fault, ADMIT (default). Set false for a hard 503 cap
BUDGET_SCHED_ENABLED=true          # the reconcile scheduler IS the enforcement engine (sole counter writer)
BUDGET_SCHED_CRON=* * * * *
BUDGET_STALE_MS=180000             # heartbeat older than this ⇒ counters untrusted ⇒ route through the fail mode
BUDGET_REDIS_TIMEOUT_MS=50         # hot-path block-check read deadline
BUDGET_RECONCILE_TIMEOUT_MS=2000   # scheduler reconcile-write deadline (separate from the 50ms hot path)
BUDGET_CACHE_TTL_MS=10000  BUDGET_CACHE_MAX=5000   # in-process owner-budget cache

# --- pricing catalog ---
PRICING_REFRESH_URL=<LiteLLM raw JSON>  # admin refresh source (a bundled snapshot ships by default; refresh is opt-in)
PRICING_FETCH_TIMEOUT_MS=15000  PRICING_MAX_BYTES=8000000

# --- notifications (channels are managed in the Settings UI; these are server-wide defaults) ---
SMTP_HOST= SMTP_PORT=587 SMTP_USER= SMTP_PASS= SMTP_FROM= SMTP_SECURE=starttls  # active only when HOST AND FROM set
APPRISE_API_URL=                   # unset by default; e.g. http://apprise:8000 for the caronc/apprise sidecar (SSRF-validated at boot)
NOTIFY_ALLOWED_ENDPOINTS=          # ; -separated host,cidr[,port] SSRF allowlist entries for soft-private ranges
NOTIFY_APPRISE_EGRESS_CONFIRMED=false   # gates cloud Apprise egress
NOTIFY_FAILURE_THRESHOLD=20  NOTIFY_FAILURE_WINDOW_MS=900000   # request-failure spike alert
NOTIFY_WEEKLY_ENABLED=false  NOTIFY_WEEKLY_CRON="0 8 * * 1"    # weekly per-owner spend summary

# --- observability ---
METRICS_ENABLED=true               # Prometheus /metrics (404 when false)
OTEL_ENABLED=false                 # OTLP tracing (never required for a request to succeed)
OTEL_SERVICE_NAME=polyrouter
OTEL_EXPORTER_OTLP_ENDPOINT=       # malformed URL fails boot; unreachable-but-valid never blocks a request
```

Gate by `MODE`: local providers, localhost auto-login, and the SSRF loopback exception only where
appropriate. **Sharp edges** an operator must know: `BUDGET_FAIL_OPEN` defaults to allow-on-fault (and a
stopped `BUDGET_SCHED_ENABLED` scheduler silently degrades block enforcement after `BUDGET_STALE_MS`);
`ROUTING_AUTO_LAYERS` leaves cost-saving cascade OFF unless it lists `cascade`; SMTP is a no-op unless
both `SMTP_HOST` and `SMTP_FROM` are set. (Cloud graduation — a split data plane, embedding classifier,
Timescale/ClickHouse — adds its own vars and is out of the baseline build.)

---

## 13. Deployment
- **Baseline (recommended for self-host):** one **Docker** image running NestJS (serving SPA + API + proxy) + PostgreSQL + Redis. Provide `docker-compose.yml` (app + postgres + redis, plus an **optional `apprise` service** — `caronc/apprise` — for URL-based notifications) and a one-line install script that downloads compose, generates secrets, and boots. First sign-up = admin.
- **Cloud graduation:** deploy `data-plane` (Hono/Go) and `control-plane` (NestJS) as separate services; events to Timescale/ClickHouse; Redis shared. The §4 directory split makes this a config/deploy change, not a rewrite.
- Run migrations on boot; expose a health endpoint; **implement graceful shutdown that drains streams** (§3.2).

---

## 14. Suggested build milestones (order for the agent)

1. **Scaffold monorepo** (Turborepo + workspaces): `shared`, `control-plane`, `data-plane` (as a module first), `frontend`. TS strict, ESLint/Prettier, Jest/Vitest.
2. **Control-plane skeleton** (NestJS + **Drizzle** + Postgres): entities (§5), migrations-on-boot, global validation pipe, **central tenant-scoping guard/repository (§11.1)**. Stand up **Redis**.
3. **Auth:** Better Auth (email/password first), session guard, **HMAC agent-API-key guard with prefix lookup**, self-host auto-login + seed.
4. **Provider layer:** adapter interface + OpenAI-compatible + Anthropic-compatible adapters; provider CRUD; **seed the bundled versioned pricing/capability table (§7.7)** + catalog sync; `testConnection`; **circuit breaker (Redis)**; **SSRF-validate user-supplied base_urls (§11.2)**.
5. **Proxy — Layer 0 only:** the **protocol-translation module (OpenAI↔Anthropic) with golden-file contract tests (§6.3)** covering tool-call round-trips + streaming; `POST /v1/chat/completions` (streaming + non-streaming) + `/v1/messages` + `GET /v1/models`; explicit model / `x-manifest-tier` / default tier; **fallbacks + the mid-stream commit policy (§6.3)**; record RequestLog (tokens from provider `usage`, **price snapshot / cost at request time (§7.7)**; batched/Redis-buffered writes); **graceful drain + backpressure**. *Ship-able product here.*
6. **Routing Layer 1 (structural):** system-prompt fingerprinting + per-agent baseline, language-neutral features, `auto` → tier. Store `decision_layer`/`routing_reason`.
7. **Routing Layer 3 (cascade):** cheap-first + escalation with quality checks. (Self-host target reached: L0 + L1 + L3.)
8. **Limits, alerts & notifications:** Redis atomic counters, block-in-path, alert-on-schedule; the event→channel notification service with **SMTP** and **Apprise** channels (both configured in Settings), async delivery, per-channel test-send, encrypted channel creds, and alert de-dup/rate-limit.
9. **Frontend SPA** (Solid + uPlot): auth, connect-agent with per-harness snippets, providers UI, routing UI (drag-order fallbacks, toggle auto layers), analytics + **routing-decision inspector**, limits UI.
10. **Observability:** OTel traces + Prometheus metrics on the proxy.
11. **Packaging:** single-container Docker + compose (app/postgres/redis) + install script.
12. **Cloud graduations (later):** Layer 2 (local embedding classifier + Redis cache) + learning loop; extract data-plane to Hono/Go; events to Timescale/ClickHouse.
13. **Tests + polish:** backend unit + e2e (Supertest) for proxy/routing/fallbacks/degradation; **golden-file protocol contract tests (§6.3); cross-tenant/IDOR isolation tests (§11.1); SSRF-rejection tests (§11.2); cost-immutability test (price change doesn't alter historical cost, §7.7)**; frontend Vitest; seed data; docs.

---

## 15. Acceptance criteria

- An external agent configured only with `base_url = <router>/v1` + `api_key` + model `auto` gets working completions (streaming + non-streaming), no other changes.
- **Explicit routing is rock-solid:** naming a model works; `x-manifest-tier: <tier>` forces that tier; `default` serves when nothing else is specified. Fallbacks fire on primary failure and the request still succeeds.
- **`auto` degrades gracefully:** with Layer 2 disabled or its model unavailable, `auto` still routes via Layers 0/1 and never errors or stalls because of the smart path.
- **Language-agnostic:** a non-English request routes sensibly (no reliance on English keywords).
- **System-prompt robustness:** identical huge harness system prompts across requests do **not** force everything into the top tier (baseline subtraction works).
- Every request shows tokens, cost, latency, chosen model, and a readable **decision_layer + reason** in the dashboard.
- **Shared state is correct across instances:** run two proxy instances against one Redis; a budget with action=block stops new requests once the *combined* spend crosses the threshold (no per-instance drift). action=alert fires the subscribed notification channels at the threshold.
- **Notifications work end-to-end:** from **Settings → Notifications**, a user can add an **SMTP** channel and/or an **Apprise** channel, hit **Send test notification** and receive it, then get a real `budget_alert` on those channels — delivered asynchronously (never blocking a request or budget check), de-duplicated within the window, with a failing channel logged but not stalling enforcement, and stored credentials encrypted at rest.
- **Protocol translation round-trips:** an OpenAI-shaped client talking to an Anthropic upstream (and vice-versa) works for a plain turn, a **multi-turn tool-call exchange**, and a **streamed** response; system prompt, tool args, stop reasons, and usage all map correctly (golden-file suite passes, §6.3).
- **Mid-stream fallback is safe:** a failure *before* the first token falls back to the next model transparently; a failure *after* streaming has begun terminates the stream with a clear error and is **never** silently swapped mid-response (§6.3).
- **Cost is immutable:** a completed request stores its unit-price snapshot; later changing the model's catalog price does **not** alter that request's recorded cost or historical spend (§7.7). Requests with missing provider `usage` are flagged `usage_estimated`, not null.
- **SSRF is blocked:** adding a custom provider or notification target whose URL resolves to a private / loopback / link-local / metadata address is rejected (except loopback local models when `MODE=selfhosted`) (§11.2).
- **Tenants are isolated:** user A cannot read or mutate user B's agents, providers, logs, limits, or notification channels by guessing/passing their ids (§11.1).
- **API keys are fast-verified** (HMAC + prefix), not bcrypt-per-request.
- Self-hosted: `docker compose up` yields a working instance (app+postgres+redis) on one port; first sign-up = admin; prompt/response bodies not persisted by default; deploys drain in-flight streams.

---

## 16. Explicit non-goals / notes
- Do **not** proxy through a central third-party server in self-hosted mode — requests go from the user's instance directly to their providers.
- Do **not** add a per-call markup/fee.
- Do **not** persist prompt/response content unless the user opts in.
- Do **not** hardcode a closed provider allow-list — custom OpenAI/Anthropic-compatible endpoints must always be addable.
- Do **not** lead with a brittle rule-based auto-classifier as the headline feature, and do **not** call a generative LLM to classify every request. Explicit routing is the core; automatic routing is opt-in, layered, cheap, and must degrade to explicit.
- Do **not** bcrypt agent API keys; do **not** run a full tokenizer on the hot path for billing (use provider `usage`).
- Do **not** swap models mid-stream once bytes have been sent to the client, and do **not** recompute historical cost against current prices (§6.3, §7.7).
- Do **not** fetch a user-supplied URL (custom provider, notification target) without SSRF validation, and do **not** return any resource by id without an ownership check (§11.1, §11.2).
- Branding, logos, marketing copy, and any proprietary scoring weights are **not** to be reproduced; implement your own equivalents.

---

*Sources synthesized from the reference project's public homepage, README, contributing/architecture guide, documentation, and the "deprecating rule-based routing" blog post (manifest.build, github.com/mnfst/manifest). Routing best practices draw on established public work on LLM cascades (FrugalGPT) and learned preference routing (RouteLLM), adapted here. Items marked **[design inference]** fill gaps the public materials don't specify and are safe to adapt.*
