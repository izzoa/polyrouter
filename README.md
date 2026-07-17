# polyrouter

Self-hostable **LLM router / gateway** — one OpenAI- and Anthropic-compatible endpoint that
routes each request to the right model across your providers, with explicit-first routing,
fallbacks, spend limits, and metadata-only cost tracking. No markup, no third-party proxy:
your keys, your box.

> Under active spec-driven development — see [`spec.md`](./spec.md) (reference spec),
> [`TODOS.md`](./TODOS.md) (build plan), and [`openspec/`](./openspec/) (change history).

## Self-hosting

One Docker image runs everything (dashboard + API + proxy on one port) next to
PostgreSQL and Redis. Requirements: Docker with **Compose v2**.

```bash
# One-liner (inspect it first if you prefer — see below):
curl -fsSL https://raw.githubusercontent.com/OWNER/polyrouter/main/install.sh | sh

# Or from a checkout (uses your working tree, downloads nothing):
git clone <repo> polyrouter && cd polyrouter && ./install.sh
```

> The one-liner executes a remote script. To inspect first: download `install.sh`,
> read it, then run it — or use the checkout path. Until the project has a public
> repository, set `POLYROUTER_REPO=<owner>/<repo>` or use the checkout path.

The script checks Docker, fetches one pinned source archive (compose file and build
context always the same commit), generates secrets into a mode-600 `.env` (**never**
overwritten on re-run), and boots `docker compose -p polyrouter-selfhost up -d --build`.
The first build takes a few minutes. Manual alternative: copy `.env` values by hand
(four 32-byte-hex secrets via `openssl rand -hex 32`, plus `POSTGRES_PASSWORD`) and run
the same compose command from the repo.

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
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` / `SMTP_SECURE`                 | unset (`PORT` 587, `SECURE` starttls) | Server-wide SMTP for password-reset email — **active only when both `SMTP_HOST` and `SMTP_FROM` are set; otherwise password reset silently never sends.** Rely on OAuth if you don't set it |
| `ROUTING_AUTO_LAYERS`                                                                               | `structural`            | Which smart-routing layers are on. **Cascade (cheap→escalate) is OFF until you set `structural,cascade`** — the dashboard toggle just shows it greyed out otherwise |
| `BUDGET_FAIL_OPEN`                                                                                  | `true`                  | On a Redis/enforcement fault, block budgets **admit** the request (availability-first). Set `false` for a hard cap that returns `503` instead |
| `TRUSTED_PROXY_CIDRS`                                                                               | unset                   | CIDRs of reverse proxies allowed to set `X-Forwarded-For` (rate-limit client-IP trust) — set it when behind a proxy |
| `NOTIFY_APPRISE_EGRESS_CONFIRMED`                                                                   | `false`                 | Cloud-mode (`MODE=cloud`) acknowledgement before Apprise delivery runs — the SSRF allowlist (`NOTIFY_ALLOWED_ENDPOINTS`) is still enforced independently |
| `PRICING_REFRESH_URL`                                                                               | LiteLLM catalog         | Source for the admin pricing refresh (a bundled snapshot ships by default; refresh is opt-in from the dashboard) |
| `PROXY_FIRST_EVENT_TIMEOUT_MS` / `PROXY_IDLE_TIMEOUT_MS`                                            | `30000` / `30000`       | Time-to-first-token / buffered-read idle bound — **raise both for slow local models** (a 30s prefill would otherwise 503 and trip the breaker) |
| `POLYROUTER_SUBNET` / `POLYROUTER_IMAGE`                                                            | `172.28.5.0/24` / built | Compose network CIDR (change on a collision) / prebuilt image override                                       |

> The optional tunables are compose pass-through: set one in `.env` and it reaches the
> container (the compose file sets the deploy-invariant ones — bind address, mode,
> `NODE_ENV`, DB/Redis URLs — itself). See [`spec.md` §12](./spec.md#12-configuration--environment)
> for the exhaustive grouped list (defaults, required-in-production secrets, dev fallbacks).

**Secret rotation caveat:** `PROVIDER_CREDENTIAL_KEY` and `NOTIFY_CREDENTIALS_SECRET`
encrypt stored provider/channel credentials — rotating them orphans those rows (you
would re-enter the credentials). This is why the installer never regenerates `.env`.

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

- **Upgrade:** pull/re-download the source, then `docker compose -p polyrouter-selfhost up -d --build` — migrations run on boot.
- **Backup:** the `polyrouter-pg` volume is the data; `docker compose exec postgres pg_dump -U polyrouter polyrouter > backup.sql`.
- **Stop/restart:** in-flight streaming responses are drained on `docker stop` (45s grace period) — deploys don't sever live completions.
- **One app replica only:** boot migrations take no advisory lock — do not `--scale app`.
- **Verify an install:** `scripts/selfhost-smoke.sh` runs the end-to-end smoke pass (health, admin bootstrap, live-stream drain, metadata-only persistence) against a throwaway stack.
- **Compliance note:** using flat-rate consumer _subscriptions_ (ChatGPT Plus, Claude Max) programmatically likely violates those providers' ToS — polyrouter supports the provider kind but surfaces the risk; BYOK API keys and local models don't carry it.

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

## Development

Requirements: **Node.js 24.x** (see `.nvmrc`), npm 10–11, Docker (for the dev database).

```bash
# 1. dependencies
npm ci

# 2. dev infrastructure (PostgreSQL 16 + Redis 7 — required from the database change onward)
docker compose -f docker-compose.dev.yml up -d

# 3. run: control-plane API on :3001, dashboard (Vite) on :3000
npm run dev
```

On a fresh self-hosted instance the first account you sign up becomes the admin.
For a pre-seeded dev admin, boot with `SEED_DATA=true` (loopback-bound, non-production,
self-hosted only) — it creates `admin@polyrouter.local` with password `changeme-dev-admin`
(change it immediately). Auth secrets (`BETTER_AUTH_SECRET`, `API_KEY_HMAC_SECRET`,
32-byte hex) are required for any network-reachable or production instance.

Useful commands (see `CLAUDE.md` for the full set):

| Command                                      | What it does                                        |
| -------------------------------------------- | --------------------------------------------------- |
| `npm run dev`                                | control-plane (watch) + frontend together           |
| `npm run build`                              | production build via Turborepo                      |
| `npm start`                                  | production server (SPA + API + proxy, one port)     |
| `npm test -w packages/<pkg>`                 | unit tests for one package                          |
| `npm run test:e2e -w packages/control-plane` | e2e suites (needs the dev compose up)               |
| `npm run db:generate` / `npm run db:migrate` | Drizzle migrations (also run automatically on boot) |
| `npm run lint` / `npm run format`            | ESLint / Prettier                                   |

MIT licensed.
