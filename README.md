<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" alt="polyrouter" width="400">
  </picture>
</p>

<p align="center">
  <strong>One endpoint for every model.</strong><br>
  A self-hostable LLM router / gateway: OpenAI- and Anthropic-compatible, explicit-first
  routing with fallbacks, spend limits, and metadata-only cost tracking.<br>
  No markup, no third-party proxy — your keys, your box.
</p>

<p align="center">
  <a href="https://github.com/izzoa/polyrouter/actions/workflows/ci.yml"><img src="https://github.com/izzoa/polyrouter/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE.md"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License: AGPL-3.0"></a>
  <img src="https://img.shields.io/badge/image-ghcr.io%2Fizzoa%2Fpolyrouter-2496ED?logo=docker&logoColor=white" alt="ghcr.io/izzoa/polyrouter">
  <img src="https://img.shields.io/badge/node-24.x-5FA04E?logo=node.js&logoColor=white" alt="Node 24.x">
</p>

<p align="center">
  <a href="#self-hosting"><b>Self-hosting</b></a> ·
  <a href="#connect-an-agent"><b>Connect an agent</b></a> ·
  <a href="./ROADMAP.md"><b>Roadmap</b></a> ·
  <a href="./CHANGELOG.md"><b>Changelog</b></a> ·
  <a href="https://github.com/izzoa/polyrouter/releases"><b>Releases</b></a> ·
  <a href="./CONTRIBUTING.md"><b>Contributing</b></a>
</p>

<p align="center">
  <a href="https://polyrouter.app"><img src="assets/dashboard-preview.svg" width="900" alt="polyrouter dashboard — the overview: KPI tiles for requests, spend, tokens and success rate; a requests-over-time chart; spend by model; and the live request log"></a>
  <br>
  <sub>The dashboard overview — KPI tiles, a requests-per-hour chart, spend by model, and the live request log (each row shows its routing layer, tokens, snapshot-priced cost, and latency).</sub>
</p>

---

polyrouter sits between your AI agents and your LLM providers. Agents talk to **one**
endpoint with **one** key; polyrouter routes each request to the right model across your
providers (BYOK API keys, custom OpenAI/Anthropic-compatible endpoints, local models),
retries down a fallback chain when a provider fails, enforces budgets, and records what
every request actually cost — storing **metadata only** by default, never your prompt or
response bodies unless you opt in.

## Features

**Routing & reliability**

- **Explicit-first routing** — naming a model always works; that's the reliable core.
  On top of it: per-request **tier pinning** (`x-polyrouter-tier: fast`), configurable
  **tier chains** (primary + ordered fallbacks, drag-to-reorder in the dashboard), and
  opt-in smart layers for `model: "auto"` — **L1 structural** (sub-millisecond local
  features; harness system prompts are fingerprinted and subtracted so a huge boilerplate
  prompt can't force everything into the top tier) and **L3 cascade** (try the cheap
  model, escalate on a failed quality check). Every smart layer **degrades to
  explicit/default** — a request never fails because routing tried to be clever.
  Every `auto` request Layer 1 evaluates also records a **workload** class (`code` /
  `vision` / `structured` / `none`) from the same structural features, and a
  **Workload target** (an `auto_workload` rule: class → tier or model) sends that class
  straight to its own chain, ahead of band targets, L2, and the cascade — classification
  alone changes nothing; only a configured target routes. Structural detection covers
  code, vision, and structured output within L1's bounded scan; when the flag-gated semantic
  module is loaded, a **semantic workload source** detects `research` / `writing` for
  structural-`none` requests (embedding vs bundled per-class anchors — one bounded embed per
  such request, reused by Layer 2; never keywords) and the same Workload targets route them.
- **Safe mid-stream semantics** — fallbacks happen freely _before_ the first token; once
  streaming has begun the model is committed, and an upstream failure terminates the
  stream with a clear error. Models are **never silently swapped mid-response**.
- **Per-provider circuit breakers** (Redis-backed, shared across instances) with
  half-open probes that survive long LLM streams; hung connects and stalled reads trip
  them cleanly.

**Protocols**

- **OpenAI-compatible** `/v1/chat/completions` + `/v1/models` and **Anthropic-compatible**
  `/v1/messages`, streaming and non-streaming — any SDK that accepts a base URL works
  unchanged. Cross-protocol requests (OpenAI client → Anthropic provider and vice versa)
  go through a dedicated translation core covering multi-turn tool calls, system prompts,
  cache-control passthrough, stop reasons, and usage — locked by golden-file and
  request-fidelity contract suites.

**Cost & limits**

- **Immutable cost records** — every request stores its **unit-price snapshot** at request
  time; later catalog updates never rewrite history. Missing provider usage is flagged as
  estimated (`~est`), never silently nulled. Prices come from a bundled versioned catalog
  (auto-refreshed daily from LiteLLM's — one env line opts out), with per-model overrides
  for custom/local endpoints. When the catalog has no exact match, polyrouter falls back to
  an adjacent native-family rate, then to the provider's own **listed** price — each
  snapshotted as a clearly-marked estimate that never overrides a real catalog price.
- **Budgets that actually block** — day/week/month windows, global or per-agent,
  alert-or-block at the threshold, enforced via **atomic Redis counters** that stay
  correct across multiple proxy instances.
- **Async notifications** — SMTP and/or [Apprise](https://github.com/caronc/apprise)
  channels for budget alerts/blocks, provider-down, and failure spikes; deliveries are
  queued off the request path, deduplicated, and a failing channel never blocks a request
  or budget enforcement.

**Dashboard**

- SolidJS + uPlot: overview KPIs and request charts, cost breakdowns by
  model/provider/agent, per-agent usage with one-click key rotation, provider health &
  catalog sync, routing configuration, and the **decision inspector** — every request
  shows its decision layer and human-readable routing reason, tokens, snapshot-priced
  cost, and latency (plus its **workload** class when `auto` classified it, marked `routed`
  when a Workload target claimed it). The Routing page's **Workload targets** card binds
  each detected class to a tier or model (the `research` / `writing` rows are live exactly when
  the semantic workload source is effective, read-only otherwise — naming which half is missing),
  and its **Auto performance** card adds a **Workload mix** block — what kinds of work `auto`
  carried, how many of each a Workload target routed, and what each cost, with unpriced /
  coverage / classifier-revision disclosures.
- **Accessible by design**: fully keyboard-operable (real buttons, visible focus, honest
  dialog semantics), WCAG-checked contrast, `prefers-reduced-motion` support — all
  enforced by regression test suites, with the visual language pinned in
  [`STYLESEED.md`](./STYLESEED.md).

**Security & privacy**

- **Metadata only by default** — prompt/response bodies are never persisted unless you
  explicitly opt in (self-host only, off by default, stored encrypted at rest with
  retention controls). Provider and channel credentials are **encrypted at rest**.
- **First-signup-wins, then invite-only** — the first account becomes the admin and
  public registration closes; teammates join via single-use, 72-hour, hash-stored
  invite links (emailed when SMTP is configured). Admins manage users, roles, and the
  registration mode from the dashboard; **disabling a user revokes sessions and agent
  keys in one stroke**, and the last enabled admin is undeletable. See
  [Users & registration](#users--registration).
- **Two credential planes** — dashboard sessions (Better Auth: email/password +
  optional Google/GitHub/Discord OAuth, slow-hashed) vs. agent API keys
  (`poly_…`, **HMAC-SHA256 + prefix lookup** — fast per-request verification, never
  bcrypt on the hot path).
- **SSRF-guarded egress** — every user-supplied URL the server fetches (provider base
  URLs, webhook/Apprise targets) is resolved and checked against private/loopback/
  link-local/metadata ranges, IPv6 included, with DNS-rebinding defense; loopback is
  allowed only for local models in self-host mode.
- **Tenant isolation everywhere** — every entity access is ownership-scoped through a
  central guard; covered by a dedicated e2e suite alongside the SSRF, protocol-contract,
  and cost-immutability suites.
- **OpenRouter app attribution** — requests to an `openrouter.ai` provider carry polyrouter's
  identity headers (`HTTP-Referer: https://polyrouter.app`, `X-OpenRouter-Title: polyrouter`)
  so the project appears in [OpenRouter's rankings](https://openrouter.ai/rankings). They are
  non-secret (an app URL and name — never prompts, keys, or user data), sent **only** to
  OpenRouter (every other provider gets neither), and never affect authentication.

**Operations**

- **One container** serves the SPA, the API, and the proxy on one port, next to
  PostgreSQL 16 + Redis; graceful shutdown **drains in-flight streams**; streaming applies
  backpressure. Prometheus `/metrics` + opt-in OpenTelemetry traces.
- **CI/CD** — every push runs build/lint/typecheck, the unit suites, and e2e against real
  Postgres + Redis; tagged releases publish a **multi-arch (amd64+arm64) image** to
  [`ghcr.io/izzoa/polyrouter`](https://github.com/izzoa/polyrouter/pkgs/container/polyrouter).

## How a request is routed

Precedence order, first match wins:

1. **Explicit model** in the request body — always honored.
2. **`x-polyrouter-tier` header** → that tier's chain.
3. **Dashboard header rules** on other headers → their target tier or model.
4. **`model: "auto"`** → enabled smart layers — they engage only once nothing above
   matched, in this order: a **Workload target** for the request's detected class (if one
   is configured and resolves), then L1 structural band targets → L2 semantic (optional)
   → L3 cascade.
5. **`default` tier** — the guaranteed catch-all.

Whatever layer decides, the tier's fallback chain applies on provider failure, budgets are
enforced, and the decision (`decision_layer` + `routing_reason`) is recorded for the
inspector. If a smart layer is unavailable, `auto` silently degrades to the default tier.
Every `auto` request Layer 1 evaluates additionally records a **workload** class
(`code` / `vision` / `structured` / `none`) beside the decision. The class itself routes
nothing; a **Workload target** you configure for it does — the request is then served by
that tier or model with `decision_layer = workload`, and its band verdict is still recorded
but never acted on. Without a target (or with an unusable one) the request follows the
band / cascade / default path exactly as before; `none` is never routable; and an explicit
`model: <tier-key>` (e.g. a `coding` tier you created) keeps working as it always did. With the
semantic module loaded (`SEMANTIC_MODEL_PATH` + `semantic` in `ROUTING_AUTO_LAYERS`, and the
tenant's semantic layer on), a structural-`none` `auto` request is embedded once and compared to
bundled per-class anchors: it records `research` / `writing` (source `semantic`) — and routes
through its Workload target — only when that class beats every other class by
`SEMANTIC_WORKLOAD_MARGIN` and clears `SEMANTIC_WORKLOAD_MIN_SIM`; otherwise it records `none`.
The structural source always wins when it found a class, the semantic source never emits the
structural classes (so prose-only coding questions usually record `none`), and the same vector
serves Layer 2's band classification — a request is never embedded twice.

## Architecture

```mermaid
flowchart LR
  A["Agents<br/>(any OpenAI / Anthropic SDK)"] -- "/v1 + poly_ key" --> P
  subgraph S["polyrouter — one container"]
    P["Inference proxy<br/>route · fallback · budget"] --- T["Protocol<br/>translation"]
    D["Dashboard SPA + API"]
  end
  T --> O["OpenAI-compatible<br/>providers"]
  T --> C["Anthropic-compatible<br/>providers"]
  P -.->|"atomic counters · breakers"| R[("Redis")]
  P -->|"RequestLog + price snapshots"| PG[("PostgreSQL")]
  D --> PG
```

The smart routing layers all run **inside** the proxy (not as separate services): L1
structural and L3 cascade ship in the baseline; the optional **L2 semantic** embedder and
its background learning loop — which adapts the classifier's centroids (its routing
bands) from recorded cascade outcomes — are
a flag-gated add-on that reuses the same Redis/PostgreSQL, **never** in the baseline image
(see [the semantic embedder](#optional-the-semantic-embedder-layer-2-foundation)).

Monorepo (Turborepo + npm workspaces): `packages/shared` (types),
`packages/control-plane` (NestJS — dashboard API, auth, CRUD, analytics, and the `/v1`
proxy endpoints), `packages/data-plane` (the proxy engine the control plane hosts:
routing, translation, adapters, recording),
`packages/frontend` (SolidJS SPA). Architecture overview: the code wiki in
[`openwiki/`](./openwiki/); release history: [`CHANGELOG.md`](./CHANGELOG.md).

## Self-hosting

Requirements: Docker with **Compose v2**.

```bash
# One-liner (inspect it first if you prefer — see below):
curl -fsSL https://raw.githubusercontent.com/izzoa/polyrouter/main/install.sh | sh

# Or from a checkout (uses your working tree, downloads nothing):
git clone https://github.com/izzoa/polyrouter.git && cd polyrouter && ./install.sh
```

> The one-liner executes a remote script. To inspect first: download `install.sh`,
> read it, then run it — or use the checkout path.

The script checks Docker, fetches one pinned source archive (compose file and build
context always the same commit), generates secrets into a mode-600 `.env` (**never**
overwritten on re-run), and boots `docker compose -p polyrouter-selfhost up -d --build`.
The first build takes a few minutes. Manual alternative: copy `.env` values by hand
(four 32-byte-hex secrets via `openssl rand -hex 32`, plus `POSTGRES_PASSWORD`) and run
the same compose command from the repo. Re-running the installer from **inside** the
created `polyrouter/` directory is safe — it refreshes the source and keeps `.env`.

### Self-host from the prebuilt image

No checkout, no local build — pull the published multi-arch (amd64 + arm64) image and run
it next to Postgres + Redis. Make a directory with two files.

**`docker-compose.yml`** — pin a version (or use `:latest`):

```yaml
name: polyrouter-selfhost

services:
  app:
    image: ghcr.io/izzoa/polyrouter:0.14.0 # or :latest — pin the current release
    restart: unless-stopped
    ports:
      - '${POLYROUTER_HOST:-127.0.0.1}:${POLYROUTER_PORT:-3001}:3001' # loopback by default
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    stop_grace_period: 45s # drain in-flight streams on stop
    env_file: .env # optional tunables from the .env reference reach the container
    environment:
      NODE_ENV: production
      MODE: selfhosted
      BIND_ADDRESS: 0.0.0.0 # bind inside the container; host exposure is `ports`
      PORT: '3001'
      DATABASE_URL: postgresql://polyrouter:${POSTGRES_PASSWORD}@postgres:5432/polyrouter
      REDIS_URL: redis://redis:6379
      BETTER_AUTH_URL: ${APP_URL:-http://localhost:${POLYROUTER_PORT:-3001}}
      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:?set in .env}
      API_KEY_HMAC_SECRET: ${API_KEY_HMAC_SECRET:?set in .env}
      PROVIDER_CREDENTIAL_KEY: ${PROVIDER_CREDENTIAL_KEY:?set in .env}
      NOTIFY_CREDENTIALS_SECRET: ${NOTIFY_CREDENTIALS_SECRET:?set in .env}

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: polyrouter
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set in .env}
      POSTGRES_DB: polyrouter
    volumes: ['polyrouter-pg:/var/lib/postgresql/data']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U polyrouter -d polyrouter']
      interval: 5s
      timeout: 3s
      retries: 12

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes: ['polyrouter-redis:/data']
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 3s
      retries: 12

  apprise: # optional notification fan-out (see below)
    image: caronc/apprise:latest
    profiles: ['apprise'] # only starts with `--profile apprise`
    restart: unless-stopped
    volumes: ['polyrouter-apprise:/config']

networks:
  default:
    ipam:
      config:
        - subnet: ${POLYROUTER_SUBNET:-172.28.5.0/24} # deterministic CIDR for NOTIFY_ALLOWED_ENDPOINTS

volumes:
  polyrouter-pg:
  polyrouter-redis:
  polyrouter-apprise:
```

**`.env`** — the app aborts at boot if any of the five secrets is missing. Generate real
values straight into the file (compose does **not** run shell substitution inside `.env`, so
these must be literal), then lock it down:

```bash
{
  for k in BETTER_AUTH_SECRET API_KEY_HMAC_SECRET PROVIDER_CREDENTIAL_KEY \
           NOTIFY_CREDENTIALS_SECRET POSTGRES_PASSWORD; do
    echo "$k=$(openssl rand -hex 32)"
  done
} > .env
chmod 600 .env
```

Then boot it — migrations run on start, no build step:

```bash
docker compose up -d
docker compose logs -f app       # watch it come up, then sign up at http://localhost:3001
```

Upgrade by bumping the `image:` tag (or tracking `:latest`) and pulling:

```bash
docker compose pull && docker compose up -d      # migrations run on boot
```

> This is the repo's `docker-compose.yml` with two doc-friendly changes: a pinned `image:`
> tag instead of a local `build:`, and the long list of optional pass-through vars collapsed
> into `env_file: .env`. The service names, volumes, pinned subnet, and `apprise` profile all
> match, so the **Operations** and **Apprise** notes below apply unchanged — every variable in
> the `.env` reference defaults when unset
> (the five secrets are required either way). To go public, expose the port and
> set `APP_URL` as in **Claim the instance** below.
>
> If `docker compose pull` returns `unauthorized`/`denied`, run `docker login ghcr.io`
> first — on a fork, the fork's own GHCR package may also not be public yet.

> **Already used the installer or a checkout?** Skip the local build by setting
> `POLYROUTER_IMAGE=ghcr.io/izzoa/polyrouter:latest` (or a pinned `:X.Y.Z`) in `.env` and
> running the compose command **without** `--build`. On a **fetch install** the compose
> flags go **before** the subcommand, exactly as the installer prints:
> `docker compose -p polyrouter-selfhost --env-file .env -f src/docker-compose.yml
--project-directory src pull`.

> **Compose commands below — checkout vs. one-line install.** The bare
> `docker compose -p polyrouter-selfhost …` form shown below assumes a **checkout**
> (compose file at the repo root). A **one-line (fetch) install** keeps the compose
> file under `src/` with `.env` beside it, so run the commands from inside the
> `polyrouter/` directory with the `--env-file .env -f src/docker-compose.yml
--project-directory src` flags placed before the subcommand — exactly the manage
> command the installer prints when it finishes.

**Claim the instance, then expose it.** The app publishes on **loopback only** by
default and the **first account to sign up becomes the admin** — sign up at
`http://localhost:3001` before exposing anything. To go public, set in `.env`:

```bash
POLYROUTER_HOST=0.0.0.0        # or keep loopback and use a reverse proxy
POLYROUTER_PORT=3001
APP_URL=https://polyrouter.example.com   # the real origin (auth callbacks/cookies)
```

then `docker compose -p polyrouter-selfhost up -d`. Put TLS and access control in
front with your reverse proxy — **`/api/health` and `/metrics` are unauthenticated
by design** (orchestration + Prometheus); restrict them at the proxy if the port is
public, or set `METRICS_ENABLED=false`.

**Container health probe:** the image's own `HEALTHCHECK` targets `/api/health` on
the configured `PORT` (default `3001`) — the identical exec-form Node probe on both
the baseline and `-semantic` variants, with **no `wget`/`curl` dependency** — so
changing `PORT` needs no healthcheck override, and the documented Node probe form
below runs unchanged on both variants. An override that shells out to base-image
utilities is **outside that guarantee**: a `wget` check works on the Alpine baseline
and breaks on the `-semantic` image's Debian-slim base. If your orchestrator defines
its own check anyway, use this form — shown as a compose override; a Kubernetes
`livenessProbe.exec.command` takes the same `["node", "-e", …]` array without the
leading `CMD`:

```yaml
healthcheck:
  test:
    [
      'CMD',
      'node',
      '-e',
      "const p=process.env.PORT||3001;require('http').get('http://127.0.0.1:'+p+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))",
    ]
```

### `.env` reference

| Variable                                                                                                  | Default                               | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`, `API_KEY_HMAC_SECRET`, `PROVIDER_CREDENTIAL_KEY`, `NOTIFY_CREDENTIALS_SECRET`       | generated                             | Required 32-byte-hex secrets (sessions, agent-key HMAC, credential + channel encryption at rest)                                                                                                                                                                                                                                                                                                                                                                                                              |
| `POSTGRES_PASSWORD`                                                                                       | generated                             | Database password — **initialization-only**: changing it later does NOT rotate the role password in postgres                                                                                                                                                                                                                                                                                                                                                                                                  |
| `POLYROUTER_HOST` / `POLYROUTER_PORT`                                                                     | `127.0.0.1` / `3001`                  | Host interface/port the app is published on                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `APP_URL`                                                                                                 | `http://localhost:3001`               | Public origin (Better Auth base URL) — set it when exposing. Also gates **links in notification emails**: a loopback value omits them (see Notification emails)                                                                                                                                                                                                                                                                                                                                               |
| `METRICS_ENABLED`                                                                                         | `true`                                | Prometheus `/metrics` (404 when `false`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `OTEL_ENABLED` / `OTEL_EXPORTER_OTLP_ENDPOINT`                                                            | `false` / SDK default                 | OpenTelemetry traces for the proxy path (batched OTLP/HTTP export)                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `GOOGLE_/GITHUB_/DISCORD_CLIENT_ID`+`_SECRET`                                                             | unset                                 | Optional OAuth sign-in providers                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `APPRISE_API_URL` + `NOTIFY_ALLOWED_ENDPOINTS`                                                            | unset                                 | Optional Apprise fan-out — see below                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` / `SMTP_SECURE`                       | unset (`PORT` 587, `SECURE` starttls) | Server-wide SMTP for password-reset **and invite** email — **active only when both `SMTP_HOST` and `SMTP_FROM` are set; otherwise password reset silently never sends and invites must be delivered by copying the link.** Rely on OAuth if you don't set it                                                                                                                                                                                                                                                  |
| `ROUTING_AUTO_LAYERS`                                                                                     | `structural`                          | Which smart-routing layers are on. **Cascade (cheap→escalate) is OFF until you set `structural,cascade`** — the dashboard toggle just shows it greyed out otherwise                                                                                                                                                                                                                                                                                                                                           |
| `ROUTING_STRUCTURAL_WEIGHTS`                                                                              | built-ins                             | JSON override for the Layer-1 classifier. Ambient keys (`size` `code` `tools` `schema` `depth` `multimodal` `maxTokens`) merge over the defaults and normalize to sum 1; the `reasoning` key is the declared-hint adjustment magnitude in `[0, 0.5]` (default `0.1`), NOT normalized. A declared `reasoning_effort`/`thinking` steers the score; a maximal declaration routes `auto_high` directly                                                                                                            |
| `ROUTING_WORKLOAD_THRESHOLDS`                                                                             | built-ins                             | JSON override for the structural **workload** classifier (detection only — routing happens through a configured Workload target): `codeShare` in `(0, 1]` (default `0.3`) and integer `codeMinChars ≥ 0` (default `200`). An `auto` request records workload `code` when fenced code is at least that share of the scanned window AND at least that many chars; `vision` (an image block) and `structured` (a declared JSON output format) are binary. Unknown keys / out-of-range values fail boot.          |
| `CALIBRATION_SCHED_ENABLED` / `CALIBRATION_SCHED_CRON`                                                    | `true` / `0 4 * * *`                  | The per-tenant threshold-calibration sweep (opt-in PER TENANT from the Routing page; this pair gates the background worker instance-wide)                                                                                                                                                                                                                                                                                                                                                                     |
| `CALIBRATION_WINDOW_DAYS` / `CALIBRATION_MIN_EDGE_SAMPLES` / `CALIBRATION_STEP` / `CALIBRATION_MAX_DRIFT` | `14` / `50` / `0.02` / `0.1`          | Calibration rails: evidence window, minimum fresh edge-zone samples (hard floor 50 — only raisable), bounded per-run step, and the max total drift from the instance thresholds. Every move is audited and one click from reverted                                                                                                                                                                                                                                                                            |
| `BUDGET_FAIL_OPEN`                                                                                        | `true`                                | On a Redis/enforcement fault, block budgets **admit** the request (availability-first). Set `false` for a hard cap that returns `503` instead                                                                                                                                                                                                                                                                                                                                                                 |
| `TRUSTED_PROXY_CIDRS`                                                                                     | unset                                 | CIDRs of reverse proxies allowed to set `X-Forwarded-For` (rate-limit client-IP trust) — set it when behind a proxy                                                                                                                                                                                                                                                                                                                                                                                           |
| `NOTIFY_APPRISE_EGRESS_CONFIRMED`                                                                         | `false`                               | Cloud-mode (`MODE=cloud`) acknowledgement before Apprise delivery runs — the SSRF allowlist (`NOTIFY_ALLOWED_ENDPOINTS`) is still enforced independently                                                                                                                                                                                                                                                                                                                                                      |
| `PRICING_REFRESH_URL`                                                                                     | LiteLLM catalog                       | Source for pricing refreshes (a bundled snapshot ships by default; the Settings page shows catalog status + a Refresh-now button for admins)                                                                                                                                                                                                                                                                                                                                                                  |
| `PRICING_REFRESH_SCHED_ENABLED` / `PRICING_REFRESH_SCHED_CRON`                                            | `true` / `30 4 * * *`                 | **Daily automatic pricing refresh — ON by default** (self-host only): one outbound GET of LiteLLM's public price catalog per day; no tenant data is sent. Set `PRICING_REFRESH_SCHED_ENABLED=false` to opt out; manual refresh keeps working                                                                                                                                                                                                                                                                  |
| `PROXY_FIRST_EVENT_TIMEOUT_MS` / `PROXY_IDLE_TIMEOUT_MS`                                                  | `30000` / `30000`                     | Time-to-first-token / buffered-read idle bound — **raise both for slow local models** (a 30s prefill would otherwise 503 and trip the breaker). For ONE slow provider in a mixed chain, prefer its per-provider override (the provider form's "Advanced — patience for slow models") over raising the instance default: timeouts trip that provider's breaker, and while its recovery probe runs with doubled patience, a provider slower than 2× its bound stays in a skip loop until its patience is raised |
| `SEMANTIC_MODEL_PATH`                                                                                     | unset                                 | Opt-in **Layer 2 semantic embedder**: path to a local model bundle (see the semantic-layer section) — pair it with `semantic` in `ROUTING_AUTO_LAYERS`. Unset = the module is absent entirely; a set-but-broken path fails boot loudly                                                                                                                                                                                                                                                                        |
| `EVENTS_ENABLED`                                                                                          | `true`                                | Dashboard live event stream (`GET /api/events`). `false` turns it off entirely and the dashboard stays on its normal polling refresh — no feature is lost, only push                                                                                                                                                                                                                                                                                                                                          |
| `EVENTS_HEARTBEAT_MS`                                                                                     | `25000`                               | Keep-alive interval; must stay under your proxy's idle-reap window (boot fails if ≥ 60s). Also bounds how fast a revoked session's open stream is closed                                                                                                                                                                                                                                                                                                                                                      |
| `SEMANTIC_TIMEOUT_MS` / `SEMANTIC_MAX_INPUT_CHARS` / `SEMANTIC_CONCURRENCY`                               | `50` / `2000` / `2`                   | Embedder bounds: per-embed hard timeout, input cap before tokenization, concurrent-inference cap (saturation skips the layer for that request). Out-of-bounds values reject boot                                                                                                                                                                                                                                                                                                                              |
| `SEMANTIC_WORKLOAD_MARGIN` / `SEMANTIC_WORKLOAD_MIN_SIM`                                                  | `0.05` / `0.20`                       | Semantic **workload** rails (need the semantic module): a structural-`none` `auto` request records `research` / `writing` only when the winning class leads the runner-up by ≥ `MARGIN` (the discriminating rail) and its cosine is ≥ `MIN_SIM` (a near-orthogonal guard; the spike showed 0.30 cost recall for no precision). Both ≤ 4 decimals, both part of the `semantic/…` workload revision, so a change never silently mixes two populations                                                           |
| `POLYROUTER_SUBNET` / `POLYROUTER_IMAGE`                                                                  | `172.28.5.0/24` / built               | Compose network CIDR (change on a collision) / prebuilt image override                                                                                                                                                                                                                                                                                                                                                                                                                                        |

> The optional tunables above are compose pass-through: set one in `.env` and it reaches
> the container (the compose file sets the deploy-invariant ones — bind address, mode,
> `NODE_ENV`, DB/Redis URLs — itself). In the repo's `docker-compose.yml` (checkout and
> installer installs) that hand-off is an **explicit allowlist**: the app service's
> `environment:` block is the list of what actually crosses into the container, and a key
> you put in `.env` without adding it there is silently ignored. The prebuilt-image example
> above passes everything through instead (`env_file: .env`), so it has no such filter. The `SEMANTIC_*` knobs are the one deliberate exception —
> they are declared in `docker-compose.semantic.yml`, so layer that override file to tune
> them (`SEMANTIC_MODEL_PATH` is baked into the `-semantic` image, so the embedder loads
> either way — but semantic routing also needs `semantic` in `ROUTING_AUTO_LAYERS`, which
> the override file sets; without it the layer silently stays off). The config registry in the source
> (`packages/*/src/**` config schemas) is the exhaustive list — defaults,
> required-in-production secrets, and dev fallbacks are declared there.

**Secret rotation caveat:** `PROVIDER_CREDENTIAL_KEY` and `NOTIFY_CREDENTIALS_SECRET`
encrypt stored provider/channel credentials — rotating them orphans those rows (you
would re-enter the credentials). This is why the installer never regenerates `.env`.

### Optional: the semantic embedder (Layer 2 foundation)

The optional semantic stack embeds request text locally (CPU ONNX, ~5–20 ms)
so the auto-router can classify what the structural layer finds ambiguous.
It is **never part of the baseline install**: the runtime is an optional peer
dependency and no model ships in the baseline image (CI asserts this). The
routing behavior that consumes it arrives with the semantic-routing
capability; a **batteries-included `-semantic` image variant** (runtime +
reference model pre-baked) ships with the semantic dashboard change.

#### Batteries-included: the `-semantic` image (zero setup)

Every tagged release also publishes a multi-arch `-semantic` image with the
ONNX runtime **and** the reference embedding model
(`sentence-transformers/all-MiniLM-L6-v2`, Apache-2.0, 384-dim) baked in at
build time. **The image presets only `SEMANTIC_MODEL_PATH` — the model half.**
The layer's capability is a pair, so the dashboard's L2 row stays "off
instance-wide" (and names which half is missing) until `ROUTING_AUTO_LAYERS`
also lists `semantic`. Nothing is downloaded at runtime. The zero-setup path
is the overlay compose, which sets that env for you:

```sh
docker compose -f docker-compose.yml -f docker-compose.semantic.yml up -d
```

Running the published image directly? Set the flag yourself — otherwise L2
stays off even though the boot log shows the embedder loading:

```sh
docker run … -e ROUTING_AUTO_LAYERS=structural,semantic,cascade \
  ghcr.io/izzoa/polyrouter:latest-semantic
```

The baseline image is unchanged — it carries no ONNX runtime and no model
files, and CI gates that on every build. The model's weights are the glibc
build's only reason for a Debian base (the runtime's prebuilt binaries do not
run on Alpine/musl).

**Bring your own model:** mount a bundle over the baked one and repoint the env
— the same fail-fast boot contract applies:

```sh
# in .env
SEMANTIC_MODEL_DIR=/abs/path/to/your/bundle   # holds model.onnx + vocab + manifest.json
SEMANTIC_MODEL_PATH=/app/models/custom
# then uncomment the `volumes:` mount in docker-compose.semantic.yml
```

To enable it on a source install instead:

```sh
npm install onnxruntime-node@1.27.0        # the optional peer, exact-pinned
```

Then set BOTH the model path and the capability flag (`semanticAvailable`
requires the layer token as well as a loaded bundle):

```sh
SEMANTIC_MODEL_PATH=/path/to/models/minilm
ROUTING_AUTO_LAYERS=structural,semantic
```

The **model bundle** directory looks like:

```
models/minilm/
  manifest.json    # the v1 bundle contract (below)
  vocab.txt        # WordPiece vocabulary, one token per line
  model.onnx       # the embedding model (MiniLM/bge-small class, 384-dim)
```

```json
{
  "schemaVersion": 1,
  "tokenizer": {
    "type": "wordpiece",
    "vocabFile": "vocab.txt",
    "lowercase": true,
    "unkToken": "[UNK]",
    "clsToken": "[CLS]",
    "sepToken": "[SEP]",
    "padToken": "[PAD]",
    "maxTokens": 256
  },
  "model": {
    "file": "model.onnx",
    "inputNames": {
      "inputIds": "input_ids",
      "attentionMask": "attention_mask",
      "tokenTypeIds": "token_type_ids"
    },
    "outputName": "last_hidden_state",
    "outputKind": "token_embeddings",
    "dims": 384,
    "pooling": "mean",
    "normalize": true
  }
}
```

Boot semantics: unset path → module absent, zero overhead; valid bundle →
load + warmup at startup (requests never pay first-inference JIT); broken
bundle → **boot fails fast** naming the file and reason (an explicit opt-in
never runs silently degraded). Nothing is fetched over the network at boot or
runtime. A request's embedded text and vector are never logged or persisted; the opt-in
learning loop stores only cohort-aggregated sums, never a single request's embedding.

### Optional: Apprise notifications

```bash
docker compose -p polyrouter-selfhost --profile apprise up -d
```

and add **both** lines to `.env` (the SSRF guard requires an allowlist entry for a
private-range host; the port bound is optional but keep it — by design, spec §10.1):

```bash
APPRISE_API_URL=http://apprise:8000
NOTIFY_ALLOWED_ENDPOINTS=apprise,172.28.5.0/24,8000
```

The compose network is pinned to `172.28.5.0/24` so that CIDR is deterministic;
change both places if it collides with your network.

### Notification emails and their links

Emails are sent as both plain text and branded HTML — a text-only client sees
the same wording it always did; an HTML client gets a laid-out message with a
button through to the relevant page (a provider alert opens Providers, a budget
alert opens Limits, and so on). The layout is deliberately **asset-free**: no
images, web fonts, or externally hosted anything, so it renders identically on
an instance that isn't publicly reachable and triggers no remote fetches.

**Those buttons appear only when `APP_URL` is an address your recipients can
actually reach.** With the default (`http://localhost:3001`) the link is omitted
entirely rather than sending a `127.0.0.1` URL that would be dead in someone's
inbox — or worse, on a phone, resolve to the phone. Setting `APP_URL` to a
loopback value explicitly does the same thing; that is deliberate, not a bug.

| `APP_URL`                                                  | Links in email                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| unset, or `http://localhost:3001` (default)                | omitted                                                                   |
| any `localhost` / `127.0.0.1` / `[::1]` value              | omitted                                                                   |
| `http://192.168.1.50:3001`, `http://polyrouter.local:3001` | **yes** — a LAN address is often exactly right for a self-hosted instance |
| `https://polyrouter.example.com`                           | **yes**                                                                   |
| a value carrying credentials, or a non-`http(s)` scheme    | omitted (it is never rendered as a link)                                  |

Two practical notes: the value is read **at boot**, so restart after changing it
(`docker compose -p polyrouter-selfhost up -d`); and only the _origin_ is used, so
an `APP_URL` with a path (`https://host/polyrouter/`) produces links at the domain
root. Serving the dashboard under a subpath is not currently supported for email
links.

Chat channels (Apprise) additionally carry a per-event severity, so a
provider-down or budget-block notification is visually distinct from an
informational summary at the target, with the page link on its own line.

### Operations

- **Upgrade:** pull/re-download the source, then `docker compose -p polyrouter-selfhost up -d --build` — or, on the prebuilt image, `docker compose -p polyrouter-selfhost pull && docker compose -p polyrouter-selfhost up -d`. Migrations run on boot either way.
- **Backup:** the `polyrouter-pg` volume is the data; `docker compose exec postgres pg_dump -U polyrouter polyrouter > backup.sql`.
- **Stop/restart:** in-flight streaming responses are drained on `docker stop` — new inference is refused and the app waits up to **15s** for open streams to finish (`streamDrainDeadlineMs`), aborting any still running at that deadline; Compose separately allows 45s (`stop_grace_period`) before SIGKILL. Deploys don't sever live completions that finish within the drain window.
- **One app replica only:** boot migrations take no advisory lock — do not `--scale app`. The dashboard's live event stream also fans out **in-process** for this reason; multi-instance fanout (Redis pub/sub) is a documented graduation, not a supported topology today.
- **Reverse proxies must not buffer `/api/events`.** The dashboard receives live updates over Server-Sent Events on that one path. polyrouter already sends `X-Accel-Buffering: no` and `Cache-Control: no-cache, no-transform` and heartbeats every 25s (under the usual ~60s idle-reap), but if you front it with nginx/Traefik/Cloudflare you may need to disable response buffering and raise the read timeout for it (nginx: `proxy_buffering off;`). If the stream is blocked the dashboard says **Polling** instead of **Live** and keeps working on its normal refresh — you lose push, never function.
- **Verify an install:** `scripts/selfhost-smoke.sh` runs the end-to-end smoke pass (health, admin bootstrap, live-stream drain, metadata-only persistence) against a throwaway stack.
- **Compliance note:** using flat-rate consumer _subscriptions_ (ChatGPT Plus, Claude Max) programmatically likely violates those providers' ToS — polyrouter supports the provider kind but surfaces the risk; BYOK API keys and local models don't carry it.

### Subscriptions (OAuth)

Subscription providers can connect through a guided **OAuth wizard** instead of pasting a
token by hand: pick a preset (**Claude Pro/Max** or **ChatGPT Plus/Pro**), sign in at the
provider's link, and paste the redirect URL — or the `code#state` string it shows — back
into the dashboard. polyrouter verifies the `state`, exchanges the code (PKCE), and stores
the access + refresh tokens **encrypted at rest**. Tokens **auto-refresh** before expiry
(safe across multiple requests and instances); if the provider revokes the grant, the card
flags the expired sign-in with a **Reauthorize** button that reopens the connect wizard, and your fallback chain keeps
serving traffic meanwhile.

Honest caveats:

- **These integrations ride undocumented contracts.** The OAuth endpoints and what the
  provider accepts from subscription tokens are ecosystem-known, not published APIs — the
  provider can change them at any time. Each preset ships enabled only after its own live
  verification — both passed on 2026-07-18 (`scripts/verify-claude-oauth.md`,
  `scripts/verify-chatgpt-oauth.md` record the runs and the pinned constants);
  failures surface as a clear provider error, and polyrouter **never impersonates the
  first-party client** beyond the documented headers — no client-fingerprint headers and no
  imitation system prompts, even if that means a preset stays disabled.
- **ChatGPT specifics:** the ChatGPT preset speaks the backend's **Responses API** with
  `store: false` on every call (nothing is retained server-side by request), and any
  reasoning items the backend emits are **dropped, never persisted or replayed** — a
  deliberate metadata-only trade that can reduce multi-turn tool-use quality on
  reasoning-heavy models. The backend also **rejects `max_tokens` and sampling
  parameters** (`temperature`/`top_p`) — requests through this provider ignore them
  (verified live; usage is flat-rate, so no billing surprise), and it only serves
  streaming upstream (polyrouter buffers transparently for non-streaming clients).
- **The ToS compliance note above applies** — pair a subscription with a pay-per-token
  fallback provider.
- **Key rotation:** changing `PROVIDER_CREDENTIAL_KEY` invalidates stored credentials;
  OAuth-connected providers will then ask to be reauthorized.

### Users & registration

The **first account to sign up owns the instance**: it becomes the admin and
registration immediately closes to **invite-only** (racing sign-ups during that
first moment are refused — exactly one bootstrap winner). Everything after that
is managed from the admin-only **Users** page (account menu, bottom of the
sidebar):

- **Invites** — single-use links pinned to an email, expiring after 72 h. With
  server SMTP configured (`SMTP_HOST` + `SMTP_FROM`) the invite is emailed
  automatically; without it, copy the link from the dashboard and deliver it
  yourself — issuing never depends on SMTP. Only a token hash is stored (plus a short lookup
  prefix — never the full token), and the raw token travels in the link's `#fragment`, which browsers never send to
  servers or proxies.
- **Roles** — promote/demote admins. The last _enabled_ admin can never be
  deleted, demoted, or disabled (the API refuses with `409`).
- **Disable** — cuts both credential planes at once: dashboard sessions are
  revoked immediately and every agent API key the user owns stops working on
  `/v1`. Re-enabling requires a fresh sign-in.
- **Registration mode** — reopen public sign-up (`open`) or keep it
  `invite_only`, live from the dashboard.

**Upgrading an existing instance closes public sign-up** (the migration seeds
`invite_only`); reopen it under Users → Registration if you want walk-in
sign-ups back. Break-glass if you ever lock yourself out (no enabled admin
left): fix the row directly in Postgres, then sign in again —

```sql
UPDATE "user" SET disabled = false, role = 'admin' WHERE email = 'you@example.com';
```

## Connect an agent

polyrouter speaks the OpenAI and Anthropic wire protocols, so any tool that lets you
set a **base URL** and **API key** works with no other changes. Create an agent key in
the dashboard (**Agents → New** — it looks like `poly_…` and is shown once), then point
your client at your instance:

- **Base URL:** an **OpenAI** SDK/client uses `https://<your-instance>/v1`; an **Anthropic** SDK uses
  `https://<your-instance>` (it appends `/v1/messages` itself). The raw endpoints are
  `/v1/chat/completions`, `/v1/messages`, and `/v1/models`
- **API key:** the `poly_…` key from the dashboard (sent as `Authorization: Bearer poly_…`)
- **Model:** an explicit model id (e.g. `gpt-4o`), `auto` (let the router pick), or a tier
  via the `x-polyrouter-tier` header — a tier you've created under Routing (only `default`
  exists out of the box; an unknown tier value falls back to default routing)

```bash
# OpenAI-compatible
curl https://<your-instance>/v1/chat/completions \
  -H "Authorization: Bearer poly_your_key" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}'

# Anthropic-compatible
curl https://<your-instance>/v1/messages \
  -H "Authorization: Bearer poly_your_key" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-3-5-sonnet","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'

# Pin a routing tier instead of a model:
#   -H "x-polyrouter-tier: fast"   (with "model":"auto")
```

The router applies your configured fallbacks, spend limits, and cost tracking on every
call. Explicit routing (a named model) is the reliable core; `auto` and tier routing are
opt-in and always degrade back to explicit/default.

### Terminal agents (OpenClaw, Hermes)

Terminal-native agents are configured with a **config file** rather than SDK code.
Both speak the OpenAI-compatible endpoint, so point their `base_url` at
`https://<your-instance>/v1` with your `poly_…` key and let the router pick the model
(`auto`). The dashboard's **Agents → New** picks the harness and shows the exact block once;
the equivalents are:

**OpenClaw** — `~/.openclaw/openclaw.json` (JSON5): register the router as a provider and
make it the default —

```json5
{
  models: {
    providers: {
      polyrouter: {
        baseUrl: 'https://<your-instance>/v1',
        apiKey: 'poly_your_key',
        api: 'openai-completions',
        models: [{ id: 'auto' }],
      },
    },
  },
  agents: { defaults: { model: { primary: 'polyrouter/auto' } } },
}
```

**[Hermes Agent](https://github.com/NousResearch/hermes-agent)** — `~/.hermes/config.yaml`:

```yaml
model:
  default: auto
  provider: custom
  base_url: 'https://<your-instance>/v1'
  api_key: 'poly_your_key'
```

Prefer to keep the key out of the YAML? Hermes supports env substitution — use
`api_key: ${POLYROUTER_KEY}` in `~/.hermes/config.yaml` and put `POLYROUTER_KEY=poly_your_key`
in `~/.hermes/.env`.

### Max-tokens field for OpenAI-compatible providers

Each **OpenAI-compatible** provider has a `maxTokensSpelling` setting (DB `max_tokens_spelling`)
that controls which wire field polyrouter sends the output-token cap under:

- `auto` (default) — kind-derived: a **local** provider emits `max_tokens` (older self-hosted
  runtimes like llama.cpp / LM Studio accept only that and **silently ignore** the newer field,
  which would drop your cap); every other kind emits `max_completion_tokens`, required by
  OpenAI's o-series and other reasoning models.
- `max_completion_tokens` / `max_tokens` — force one field. Set `max_tokens` for a **custom**
  endpoint that only understands the legacy field; `max_completion_tokens` for a reasoning
  endpoint reached through a custom `base_url`.

It only applies to OpenAI-compatible providers (Anthropic-compatible always uses `max_tokens`),
and is set on the provider create/update API (a dashboard control is a follow-up).

## Development

Requirements: **Node.js 24.x** (see `.nvmrc`), npm 10–11, Docker (for the dev database).

```bash
# 1. dependencies
npm ci

# 2. dev infrastructure (PostgreSQL 16 + Redis 7)
docker compose -f docker-compose.dev.yml up -d

# 3. run: control-plane API on :3001, dashboard (Vite) on :3000
npm run dev
```

On a fresh self-hosted instance the first account you sign up becomes the admin.
For a pre-seeded dev admin, boot with `SEED_DATA=true` (loopback-bound, non-production,
self-hosted only) — it creates `admin@polyrouter.local` with password `changeme-dev-admin`
(change it immediately). Auth secrets (`BETTER_AUTH_SECRET`, `API_KEY_HMAC_SECRET`,
32-byte hex) are required for any network-reachable or production instance.

Useful commands (see [`CLAUDE.md`](./CLAUDE.md) for the full set):

| Command                                      | What it does                                        |
| -------------------------------------------- | --------------------------------------------------- |
| `npm run dev`                                | control-plane (watch) + frontend together           |
| `npm run build`                              | production build via Turborepo                      |
| `npm start`                                  | production server (SPA + API + proxy, one port)     |
| `npm test -w packages/<pkg>`                 | unit tests for one package                          |
| `npm run test:e2e -w packages/control-plane` | e2e suites (needs the dev compose up)               |
| `npm run db:generate` / `npm run db:migrate` | Drizzle migrations (also run automatically on boot) |
| `npm run lint` / `npm run format`            | ESLint / Prettier                                   |

Development is **spec-driven** (OpenSpec change proposals):
[`CLAUDE.md`](./CLAUDE.md) pins the stack and the non-negotiable invariants,
[`CHANGELOG.md`](./CHANGELOG.md) records every user-facing change (each release links its
GitHub notes), and [`STYLESEED.md`](./STYLESEED.md) locks the dashboard's visual language
(UI changes must pass its `/ss-score` gate). CI enforces build, lint, typecheck, the unit suites (including
the golden-file protocol-contract tests), and e2e — including the SSRF, tenant-isolation,
and cost-immutability suites — on every push.

An auto-generated **code wiki** lives in [`openwiki/`](./openwiki/): start at
[`openwiki/quickstart.md`](./openwiki/quickstart.md) for the architecture overview,
source maps, request flow, and runbook notes. The scheduled
[OpenWiki workflow](./.github/workflows/openwiki-update.yml) regenerates it daily and
opens a PR with the refresh — don't hand-edit generated wiki pages; change the source and
let the next run regenerate them. (Maintainer: the workflow needs the
`OPENROUTER_API_KEY` repo secret.)

## License

[AGPL-3.0](./LICENSE.md). Run it, self-host it, fork it — if you offer a **modified**
polyrouter as a network service, the AGPL asks you to offer its users your modified
source.
