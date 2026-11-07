# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: the solo self-hoster.** One developer or tinkerer runs polyrouter on their own
machine, homelab or VPS. They route their own coding agents and assistants through it,
watch their spend, and avoid surprise bills. When they invite anyone, it is a few
collaborators.

**Secondary: the small-team operator.** An engineer runs polyrouter for a team or a small
company. Several people's agents share one gateway, members are invite-only, each agent can
have its own budget, and provider keys are shared and encrypted at rest.

Design for the solo self-hoster first. The team case must keep working, but it must not
crowd out the one-person path.

## Product Purpose

polyrouter is a self-hostable LLM router and gateway. It sits between a user's AI agents and
their LLM providers.

- Agents use one endpoint and one key.
- polyrouter picks the model, falls back when a provider fails, and enforces budgets.
- It records each request's cost, token counts and latency.

Success means the operator can do four things:

- Point any agent at a single base URL and stop managing provider keys per tool.
- Trust that a named model always works.
- Know what every request cost, and why it went where it did.
- Never be surprised by a bill.

Tagline (README): **"One endpoint for every model."**

## Positioning

polyrouter is the operator's own router: their keys, on their box. It differs from
neighboring products by mechanism, not by a feature list:

- **No markup and no third-party proxy.** In self-host mode, traffic goes straight from the
  operator's instance to their providers, and there is no per-call fee.
- **Explicit routing is the reliable core.** A named model always routes as named. Tiers,
  fallback chains and `model: "auto"` are opt-in, and every smart layer degrades to the
  default. Routing never fails a request.
- **No silent model swaps.** Fallback happens only before the first token. After that, the
  model is committed, and a failure ends the stream with a clear error.
- **Cost records are immutable.** Each request stores a snapshot of the prices it was
  charged at, and later price updates never rewrite history. Estimates are flagged, never
  shown as exact.
- **Metadata only by default.** Prompt and response bodies are never stored unless the
  operator opts in.

## Operating Context

1. **Install.** The operator installs with Docker Compose, either with `install.sh` or the
   prebuilt image `ghcr.io/izzoa/polyrouter`. The optional semantic-routing variant is the
   `-semantic` image, enabled with `SEMANTIC_MODEL_PATH`. Full guide: `docs/self-hosting.md`.
2. **Sign up.** The first person to sign up becomes the admin. After that, signup is
   invite-only. Disabling a user revokes their sessions and keys.
3. **Add providers.** Supported kinds:
   - BYOK API keys.
   - Custom OpenAI- or Anthropic-compatible endpoints.
   - Local models over loopback. This is allowed only in self-host mode.
   - Flat-rate consumer subscriptions (ChatGPT Plus, Claude Max) and coding plans
     connected with an API key (OpenCode Go, MiniMax M Plan, Kimi Code, Z.ai GLM Coding
     Plan). These carry a visible terms-of-service risk warning, worded per plan.
4. **Connect agents.** The operator creates an agent key (`poly_…`, shown once) and points
   the client's base URL and key at the instance. Clients include SDKs, `curl`, and
   terminal agents such as OpenClaw and Hermes. Guide: `docs/connect-an-agent.md`.
5. **Run and monitor.** The operator configures and watches everything in the dashboard:
   - Overview, Requests, Costs, Agents and Batches.
   - Limits: budgets and alerts.
   - Providers.
   - Routing: tiers and headers, plus the Auto routing tab.
   - Settings, Users and Setup.

The usual rhythm: configure once, then check in to read costs and requests. The operator
also uses the routing-decision inspector to see why a request went where it did.

Alerts go out by SMTP and Apprise, off the request path.

## Capabilities and Constraints

**Protocols.** OpenAI `/v1/chat/completions` and `/v1/models`, and Anthropic `/v1/messages`.
Both stream. Cross-protocol requests are translated. A batch API is served at
`/v1/batches`.

**Routing.**

- Explicit model ids.
- Tiers via the `x-polyrouter-tier` header.
- Fallback chains.
- `auto`, made of layers. L1 is structural and runs in the baseline. L2 is semantic and
  ships as an optional module. L3 is a cascade: cheap first, then escalate.
- A **workload** axis: `code`, `vision` and `structured` in the baseline; `research` and
  `writing` only when semantic routing is on.
- Strong and cheap band targets, and self-calibration.

**Spend.**

- Budgets cover a day, week or month, either globally or per agent.
- A budget either blocks requests or only alerts.
- Budgets are enforced with atomic Redis counters across instances.
- A batch reserves its ceiling until it settles.

**Non-negotiable invariants.** The 12 invariants in `CLAUDE.md` bind every design and
product decision, including:

- Explicit routing is the reliable core.
- Cost is immutable.
- Data is metadata-only.
- Tenants are isolated.
- Every user-supplied URL is SSRF-validated.
- A slow alert channel never blocks a request.
- The request hot path stays cheap.

**Terminology.** Use these terms consistently: agent, provider, model, tier, `auto`, layer
(L1/L2/L3), workload, band (strong/cheap), cascade, budget (block/alert), reservation,
spend basis (cash/notional).

**Open decisions.**

- **Hosted polyrouter (planned, undecided).** A hosted offering is planned, and `MODE=cloud`
  already exists in code, but its pricing, tenancy model and launch are undecided. The role
  of polyrouter.app, which the README links, is also undecided. Until this is decided,
  design for self-hosting, and don't present hosted as a current capability.
- **Cloud-tier infrastructure is deferred.** This means the split data plane and
  Timescale/ClickHouse. Neither belongs in the baseline.

**License.** AGPL-3.0-only. Anyone who offers a modified polyrouter as a network service
must publish their modified source.

## Brand Commitments

- **Name and identifiers.** The name is **polyrouter**, always lowercase. Agent keys use the
  `poly_` prefix and the tier header is `x-polyrouter-tier`.
- **Reference branding is forbidden.** Never reuse branding from the reference project:
  no Manifest names, `mnfst_` key prefixes or `x-manifest-*` headers.
- **Logo and favicon.** The logo is `assets/logo-light.svg` and `assets/logo-dark.svg`.
  The favicon is `packages/frontend/public/favicon.svg`.
- **Tagline.** "One endpoint for every model." The supporting line: "No markup, no
  third-party proxy — your keys, your box."
- **Visual identity.** The dashboard's visual identity is locked in `STYLESEED.md`. That
  file, not this one, is the authority on visuals.
- **Voice, as observed in shipped copy.** Shipped copy is plain, direct and literal. It
  states limits and risks rather than hiding them, for example the subscription ToS warning
  and the estimated-cost flags. The voice is honest about uncertainty: when a state is
  unverified, unpriced or estimated, the copy says so in text.

## Evidence on Hand

- **Public repository:** github.com/izzoa/polyrouter, released as v0.27.1. Version history
  is in `CHANGELOG.md` and `packages/*/CHANGELOG.md`.
- **Container images:** `ghcr.io/izzoa/polyrouter:<version>` and `<version>-semantic`.
- **Dashboard illustration:** `assets/dashboard-preview.svg`.
- **Docs:** `docs/self-hosting.md`, `docs/connect-an-agent.md`, `docs/routing.md`,
  `ROADMAP.md`.
- **Absent, so never fabricate:**
  - testimonials, customer names or logos;
  - user or install counts;
  - performance or cost-savings benchmarks;
  - hosted pricing;
  - uptime or SLA claims.

## Product Principles

1. **Explicit is the floor, and smart is opt-in.** Every automatic feature degrades to
   explicit or default routing. Nothing smart may fail or stall a request.
2. **Numbers never lie.** Cost, savings and counts show what was recorded. The UI names
   estimated, unpriced, unknown and unverified states in text, and never draws them as
   zeros or as exact figures.
3. **Your keys, your box.** Privacy and ownership are the default: data is metadata-only,
   credentials are encrypted, there is no third-party proxy and no per-call fee.
4. **The request path is sacred.** Alerts, learning, analytics and the dashboard all stay
   off the hot path. None of them may block or slow a request.
5. **One person first, team-ready.** Defaults must work for a single self-hoster with no
   ceremony. Invites, per-agent budgets and tenant scoping must hold when a team arrives.

## Accessibility & Inclusion

**Required standard: WCAG 2.2 AA** for the dashboard. Current practice already meets parts
of it:

- Hit targets of at least 24px at every width (2.5.8).
- Hit targets of 44px on coarse pointers and narrow viewports.
- Keyboard-operable controls and overlays with focus return.
- `prefers-reduced-motion` honored.
- Status shown in text, not by color alone.
- Layouts verified down to 320px.
