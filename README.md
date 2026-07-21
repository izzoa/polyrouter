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

---

polyrouter sits between your AI agents and your LLM providers. Agents talk to **one**
endpoint with **one** key; polyrouter routes each request to the right model across your
providers (BYOK API keys, custom OpenAI/Anthropic-compatible endpoints, local models),
retries down a fallback chain when a provider fails, enforces budgets, and records what
every request actually cost — while storing **metadata only**, never your prompts.

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
- **Safe mid-stream semantics** — fallbacks happen freely *before* the first token; once
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
  cache-control passthrough, stop reasons, and usage — locked by a **golden-file contract
  suite**.

**Cost & limits**

- **Immutable cost records** — every request stores its **unit-price snapshot** at request
  time; later catalog updates never rewrite history. Missing provider usage is flagged
  `~estimated`, never silently nulled. Prices come from a bundled versioned catalog
  (auto-refreshed daily from LiteLLM's — one env line opts out), with per-model
  overrides for custom/local endpoints.
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
  cost, and latency.
- **Accessible by design**: fully keyboard-operable (real buttons, visible focus, honest
  dialog semantics), WCAG-checked contrast, `prefers-reduced-motion` support — all
  enforced by regression test suites, with the visual language pinned in
  [`STYLESEED.md`](./STYLESEED.md).

**Security & privacy**

- **Metadata only** — prompt/response bodies are never persisted (a property of the
  build, not a setting). Provider and channel credentials are **encrypted at rest**.
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
3. **`model: "auto"`** → enabled smart layers (L1 structural → L3 cascade).
4. **`default` tier** — the guaranteed catch-all.

Whatever layer decides, the tier's fallback chain applies on provider failure, budgets are
enforced, and the decision (`decision_layer` + `routing_reason`) is recorded for the
inspector. If a smart layer is unavailable, `auto` silently degrades to the default tier.

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

Monorepo (Turborepo + npm workspaces): `packages/shared` (types),
`packages/control-plane` (NestJS — dashboard API, auth, CRUD, analytics),
`packages/data-plane` (the proxy: routing, translation, recording),
`packages/frontend` (SolidJS SPA). Architecture overview: the code wiki in
[`openwiki/`](./openwiki/); build history: [`TODOS.md`](./TODOS.md).

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
    image: ghcr.io/izzoa/polyrouter:0.1.0        # or :latest
    restart: unless-stopped
    ports:
      - '${POLYROUTER_HOST:-127.0.0.1}:${POLYROUTER_PORT:-3001}:3001'  # loopback by default
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    stop_grace_period: 45s                        # drain in-flight streams on stop
    environment:
      NODE_ENV: production
      MODE: selfhosted
      BIND_ADDRESS: 0.0.0.0                        # bind inside the container; host exposure is `ports`
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

volumes:
  polyrouter-pg:
  polyrouter-redis:
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

> These are the same service definitions as the repo's `docker-compose.yml`, trimmed to the
> **required** env — every other variable is optional and defaults when unset (see the
> `.env` reference below), and the volume/name match so the **Operations** notes below
> (backup, drain, one-replica) apply unchanged. To go public, expose the port and set
> `APP_URL` as in **Claim the instance** below.
>
> If `docker compose pull` returns `unauthorized`/`denied`, the image is private — either
> the maintainer hasn't flipped the GHCR package to public yet, or run
> `docker login ghcr.io` first.

> **Already used the installer or a checkout?** Skip the local build by setting
> `POLYROUTER_IMAGE=ghcr.io/izzoa/polyrouter:latest` (or a pinned `:X.Y.Z`) in `.env` and
> running the compose command **without** `--build`. On a **fetch install** the compose
> flags go **before** the subcommand, exactly as the installer prints:
> `docker compose -p polyrouter-selfhost --env-file .env -f src/docker-compose.yml
> --project-directory src pull`.
>
> Maintainer note (one-time, first release): GHCR packages are created **private** by
> default — after the first `v*` tag publishes, set the `polyrouter` package to public
> (package settings → Danger zone → Change visibility) or anonymous pulls will fail.

> **Compose commands below — checkout vs. one-line install.** The bare
> `docker compose -p polyrouter-selfhost …` form shown below assumes a **checkout**
> (compose file at the repo root). A **one-line (fetch) install** keeps the compose
> file under `src/` with `.env` beside it, so run the commands from inside the
> `polyrouter/` directory with the `--env-file .env -f src/docker-compose.yml
> --project-directory src` flags placed before the subcommand — exactly the manage
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

### `.env` reference

| Variable                                                                                            | Default                 | Purpose                                                                                                      |
| --------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `BETTER_AUTH_SECRET`, `API_KEY_HMAC_SECRET`, `PROVIDER_CREDENTIAL_KEY`, `NOTIFY_CREDENTIALS_SECRET` | generated               | Required 32-byte-hex secrets (sessions, agent-key HMAC, credential + channel encryption at rest)             |
| `POSTGRES_PASSWORD`                                                                                 | generated               | Database password — **initialization-only**: changing it later does NOT rotate the role password in postgres |
| `POLYROUTER_HOST` / `POLYROUTER_PORT`                                                               | `127.0.0.1` / `3001`    | Host interface/port the app is published on                                                                  |
| `APP_URL`                                                                                           | `http://localhost:3001` | Public origin (Better Auth base URL) — set it when exposing                                                  |
| `METRICS_ENABLED`                                                                                   | `true`                  | Prometheus `/metrics` (404 when `false`)                                                                     |
| `OTEL_ENABLED` / `OTEL_EXPORTER_OTLP_ENDPOINT`                                                      | `false` / SDK default   | OpenTelemetry traces for the proxy path (batched OTLP/HTTP export)                                           |
| `GOOGLE_/GITHUB_/DISCORD_CLIENT_ID`+`_SECRET`                                                       | unset                   | Optional OAuth sign-in providers                                                                             |
| `APPRISE_API_URL` + `NOTIFY_ALLOWED_ENDPOINTS`                                                      | unset                   | Optional Apprise fan-out — see below                                                                         |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` / `SMTP_SECURE`                 | unset (`PORT` 587, `SECURE` starttls) | Server-wide SMTP for password-reset **and invite** email — **active only when both `SMTP_HOST` and `SMTP_FROM` are set; otherwise password reset silently never sends and invites must be delivered by copying the link.** Rely on OAuth if you don't set it |
| `ROUTING_AUTO_LAYERS`                                                                               | `structural`            | Which smart-routing layers are on. **Cascade (cheap→escalate) is OFF until you set `structural,cascade`** — the dashboard toggle just shows it greyed out otherwise |
| `ROUTING_STRUCTURAL_WEIGHTS`                                                                        | built-ins               | JSON override for the Layer-1 classifier. Ambient keys (`size` `code` `tools` `schema` `depth` `multimodal` `maxTokens`) merge over the defaults and normalize to sum 1; the `reasoning` key is the declared-hint adjustment magnitude in `[0, 0.5]` (default `0.1`), NOT normalized. A declared `reasoning_effort`/`thinking` steers the score; a maximal declaration routes `auto_high` directly |
| `CALIBRATION_SCHED_ENABLED` / `CALIBRATION_SCHED_CRON`                                              | `true` / `0 4 * * *`    | The per-tenant threshold-calibration sweep (opt-in PER TENANT from the Routing page; this pair gates the background worker instance-wide) |
| `CALIBRATION_WINDOW_DAYS` / `CALIBRATION_MIN_EDGE_SAMPLES` / `CALIBRATION_STEP` / `CALIBRATION_MAX_DRIFT` | `14` / `50` / `0.02` / `0.1` | Calibration rails: evidence window, minimum fresh edge-zone samples (hard floor 50 — only raisable), bounded per-run step, and the max total drift from the instance thresholds. Every move is audited and one click from reverted |
| `BUDGET_FAIL_OPEN`                                                                                  | `true`                  | On a Redis/enforcement fault, block budgets **admit** the request (availability-first). Set `false` for a hard cap that returns `503` instead |
| `TRUSTED_PROXY_CIDRS`                                                                               | unset                   | CIDRs of reverse proxies allowed to set `X-Forwarded-For` (rate-limit client-IP trust) — set it when behind a proxy |
| `NOTIFY_APPRISE_EGRESS_CONFIRMED`                                                                   | `false`                 | Cloud-mode (`MODE=cloud`) acknowledgement before Apprise delivery runs — the SSRF allowlist (`NOTIFY_ALLOWED_ENDPOINTS`) is still enforced independently |
| `PRICING_REFRESH_URL`                                                                               | LiteLLM catalog         | Source for pricing refreshes (a bundled snapshot ships by default; the Settings page shows catalog status + a Refresh-now button for admins) |
| `PRICING_REFRESH_SCHED_ENABLED` / `PRICING_REFRESH_SCHED_CRON`                                      | `true` / `30 4 * * *`   | **Daily automatic pricing refresh — ON by default** (self-host only): one outbound GET of LiteLLM's public price catalog per day; no tenant data is sent. Set `PRICING_REFRESH_SCHED_ENABLED=false` to opt out; manual refresh keeps working |
| `PROXY_FIRST_EVENT_TIMEOUT_MS` / `PROXY_IDLE_TIMEOUT_MS`                                            | `30000` / `30000`       | Time-to-first-token / buffered-read idle bound — **raise both for slow local models** (a 30s prefill would otherwise 503 and trip the breaker) |
| `SEMANTIC_MODEL_PATH`                                                                               | unset                   | Opt-in **Layer 2 semantic embedder**: path to a local model bundle (see the semantic-layer section) — pair it with `semantic` in `ROUTING_AUTO_LAYERS`. Unset = the module is absent entirely; a set-but-broken path fails boot loudly |
| `SEMANTIC_TIMEOUT_MS` / `SEMANTIC_MAX_INPUT_CHARS` / `SEMANTIC_CONCURRENCY`                         | `50` / `2000` / `2`     | Embedder bounds: per-embed hard timeout, input cap before tokenization, concurrent-inference cap (saturation skips the layer for that request). Out-of-bounds values reject boot |
| `POLYROUTER_SUBNET` / `POLYROUTER_IMAGE`                                                            | `172.28.5.0/24` / built | Compose network CIDR (change on a collision) / prebuilt image override                                       |

> The optional tunables are compose pass-through: set one in `.env` and it reaches the
> container (the compose file sets the deploy-invariant ones — bind address, mode,
> `NODE_ENV`, DB/Redis URLs — itself). The config registry in the source
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

To enable it on a source install today:

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
    "type": "wordpiece", "vocabFile": "vocab.txt", "lowercase": true,
    "unkToken": "[UNK]", "clsToken": "[CLS]", "sepToken": "[SEP]",
    "padToken": "[PAD]", "maxTokens": 256
  },
  "model": {
    "file": "model.onnx",
    "inputNames": { "inputIds": "input_ids", "attentionMask": "attention_mask", "tokenTypeIds": "token_type_ids" },
    "outputName": "last_hidden_state", "outputKind": "token_embeddings",
    "dims": 384, "pooling": "mean", "normalize": true
  }
}
```

Boot semantics: unset path → module absent, zero overhead; valid bundle →
load + warmup at startup (requests never pay first-inference JIT); broken
bundle → **boot fails fast** naming the file and reason (an explicit opt-in
never runs silently degraded). Nothing is fetched over the network at boot or
runtime; embedded text and vectors are never logged or persisted.

### Optional: Apprise notifications

```bash
docker compose -p polyrouter-selfhost --profile apprise up -d
```

and add **both** lines to `.env` (the SSRF guard requires a port-bounded allowlist
entry for a private-range host — by design, spec §10.1):

```bash
APPRISE_API_URL=http://apprise:8000
NOTIFY_ALLOWED_ENDPOINTS=apprise,172.28.5.0/24,8000
```

The compose network is pinned to `172.28.5.0/24` so that CIDR is deterministic;
change both places if it collides with your network.

### Operations

- **Upgrade:** pull/re-download the source, then `docker compose -p polyrouter-selfhost up -d --build` — or, on the prebuilt image, `docker compose -p polyrouter-selfhost pull && docker compose -p polyrouter-selfhost up -d`. Migrations run on boot either way.
- **Backup:** the `polyrouter-pg` volume is the data; `docker compose exec postgres pg_dump -U polyrouter polyrouter > backup.sql`.
- **Stop/restart:** in-flight streaming responses are drained on `docker stop` (45s grace period) — deploys don't sever live completions.
- **One app replica only:** boot migrations take no advisory lock — do not `--scale app`.
- **Verify an install:** `scripts/selfhost-smoke.sh` runs the end-to-end smoke pass (health, admin bootstrap, live-stream drain, metadata-only persistence) against a throwaway stack.
- **Compliance note:** using flat-rate consumer _subscriptions_ (ChatGPT Plus, Claude Max) programmatically likely violates those providers' ToS — polyrouter supports the provider kind but surfaces the risk; BYOK API keys and local models don't carry it.

### Subscriptions (OAuth)

Subscription providers can connect through a guided **OAuth wizard** instead of pasting a
token by hand: pick a preset (**Claude Pro/Max** or **ChatGPT Plus/Pro**), sign in at the
provider's link, and paste the redirect URL — or the `code#state` string it shows — back
into the dashboard. polyrouter verifies the `state`, exchanges the code (PKCE), and stores
the access + refresh tokens **encrypted at rest**. Tokens **auto-refresh** before expiry
(safe across multiple requests and instances); if the provider revokes the grant, the card
shows **"reauthorize required"** with a one-click reconnect, and your fallback chain keeps
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
  yourself — issuing never depends on SMTP. Only a token hash is stored, and the
  raw token travels in the link's `#fragment`, which browsers never send to
  servers or proxies.
- **Roles** — promote/demote admins. The last *enabled* admin can never be
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
  via the `x-polyrouter-tier` header (e.g. `fast` / `heavy`)

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

### Terminal coding agents (OpenClaw, Hermes)

Terminal-native coding agents are configured with a **config file** rather than SDK code.
Both speak the OpenAI-compatible endpoint, so point their `base_url` at
`https://<your-instance>/v1` with your `poly_…` key and let the router pick the model
(`auto`). The dashboard's **Agents → New** picks the harness and shows the exact block once;
the equivalents are:

**OpenClaw** — `~/.openclaw/config.toml`:

```toml
[llm]
base_url = "https://<your-instance>/v1"
api_key  = "poly_your_key"
model    = "auto"
```

**[Hermes Agent](https://github.com/NousResearch/hermes-agent)** — `~/.hermes/config.yaml`:

```yaml
model:
  default: auto
  provider: custom
  base_url: "https://<your-instance>/v1"
  api_key: "poly_your_key"
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
[`TODOS.md`](./TODOS.md) records every shipped change with its review history, and
[`STYLESEED.md`](./STYLESEED.md) locks the dashboard's visual language (UI changes must
pass its `/ss-score` gate). CI enforces build, lint, typecheck, the unit suites, and e2e
— including the protocol-contract (golden files), SSRF, tenant-isolation, and
cost-immutability suites — on every push.

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
