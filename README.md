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
  <a href="#quickstart"><b>Quickstart</b></a> ·
  <a href="./docs/self-hosting.md"><b>Self-hosting</b></a> ·
  <a href="./docs/connect-an-agent.md"><b>Connect an agent</b></a> ·
  <a href="./docs/routing.md"><b>Routing</b></a> ·
  <a href="./ROADMAP.md"><b>Roadmap</b></a> ·
  <a href="./CHANGELOG.md"><b>Changelog</b></a> ·
  <a href="./CONTRIBUTING.md"><b>Contributing</b></a>
</p>

<p align="center">
  <a href="https://polyrouter.app"><img src="assets/dashboard-preview.svg" width="900" alt="polyrouter dashboard — the overview: KPI tiles for requests, spend, tokens and success rate; a requests-over-time chart; spend by model; and the live request log"></a>
</p>

---

polyrouter sits between your AI agents and your LLM providers. Agents use **one** endpoint
and **one** key. polyrouter picks the model, falls back when a provider fails, enforces
budgets, and records what each request cost. It stores **metadata only** — never prompt or
response bodies unless you opt in.

## Quickstart

Needs Docker with Compose v2. About 5 minutes (first build is the slow part).

1. Start it. Pick one:

   **A. Installer** (builds from source):

   ```bash
   curl -fsSL https://raw.githubusercontent.com/izzoa/polyrouter/main/install.sh | sh
   ```

   Prefer to read it first? Clone the repo and run `./install.sh`.

   **B. Prebuilt image** (no build). In an empty folder, generate secrets, save the compose file, boot:

   ```bash
   { for k in BETTER_AUTH_SECRET API_KEY_HMAC_SECRET PROVIDER_CREDENTIAL_KEY \
              NOTIFY_CREDENTIALS_SECRET POSTGRES_PASSWORD; do
       echo "$k=$(openssl rand -hex 32)"
     done; } > .env && chmod 600 .env
   ```

   `docker-compose.yml`:

   ```yaml
   name: polyrouter-selfhost

   services:
     app:
       image: ghcr.io/izzoa/polyrouter:0.27.1 # or :latest
       restart: unless-stopped
       ports:
         - '127.0.0.1:3001:3001' # loopback only until you claim the instance
       depends_on:
         postgres: { condition: service_healthy }
         redis: { condition: service_healthy }
       stop_grace_period: 45s # drains in-flight streams
       env_file: .env
       environment:
         NODE_ENV: production
         MODE: selfhosted
         BIND_ADDRESS: 0.0.0.0
         PORT: '3001'
         DATABASE_URL: postgresql://polyrouter:${POSTGRES_PASSWORD}@postgres:5432/polyrouter
         REDIS_URL: redis://redis:6379
         BETTER_AUTH_URL: http://localhost:3001
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

   ```bash
   docker compose up -d   # migrations run on boot
   ```

   Upgrade: bump the tag, then `docker compose pull && docker compose up -d`. Going public
   (`APP_URL`, reverse proxy, Apprise): see [Self-hosting](./docs/self-hosting.md).

2. Open `http://localhost:3001` and sign up. **The first account becomes the admin.**
3. Add a provider (**Providers**) and create an agent key (**Agents → New**, shown once, `poly_…`).
4. Point your client at it:

   ```bash
   curl http://localhost:3001/v1/chat/completions \
     -H "Authorization: Bearer poly_your_key" \
     -H "Content-Type: application/json" \
     -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}'
   ```

Next: [connect a real agent](./docs/connect-an-agent.md) (OpenAI SDK, Anthropic SDK, OpenClaw, Hermes).

## What you get

- **Two protocols, one key.** OpenAI `/v1/chat/completions` + `/v1/models` and Anthropic
  `/v1/messages`, streaming or not. Cross-protocol requests are translated.
- **Explicit-first routing.** A named model always works. Optional extras: tier headers,
  fallback chains, and `model: "auto"` smart layers. Every smart layer degrades to the
  default — routing never fails a request. → [Routing](./docs/routing.md)
- **No silent model swaps.** Fallback happens before the first token. After that the model
  is committed; a failure ends the stream with a clear error.
- **Immutable cost records.** Each request stores its price snapshot. Later price updates
  never rewrite history. Estimates are flagged.
- **Budgets that block.** Day/week/month, global or per-agent, enforced with atomic Redis
  counters across instances.
- **Async alerts.** SMTP and [Apprise](https://github.com/caronc/apprise). A failing
  channel never blocks a request.
- **Dashboard.** Costs, per-agent usage, provider health, routing config, and a decision
  inspector showing why each request went where it did.

## Security

- Metadata-only by default; credentials encrypted at rest.
- Agent keys are HMAC-SHA256 (fast); dashboard passwords use a slow hash. Separate planes.
- Every user-supplied URL is SSRF-checked (loopback allowed only for local models in self-host mode).
- Every entity is tenant-scoped through one central guard.
- First signup wins, then invite-only. Disabling a user revokes their sessions and keys.

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

Monorepo (Turborepo + npm workspaces): `packages/shared`, `packages/control-plane`
(NestJS API + `/v1` endpoints), `packages/data-plane` (routing, translation, adapters),
`packages/frontend` (SolidJS). Code wiki: [`openwiki/`](./openwiki/).

## Docs

| Need                                              | Read                                                        |
| ------------------------------------------------- | ----------------------------------------------------------- |
| Run it: Docker, prebuilt image, `.env`, upgrades  | [Self-hosting](./docs/self-hosting.md)                      |
| Wire up an SDK or terminal agent                  | [Connect an agent](./docs/connect-an-agent.md)              |
| Routing precedence, workload classes, auto layers | [Routing](./docs/routing.md)                                |
| Budget progress semantics                         | [Budgets API](packages/control-plane/src/budgets/README.md) |
| Release history                                   | [CHANGELOG](./CHANGELOG.md)                                 |

`docs/self-hosting.md` also covers the reverse proxy / CDN setup, the optional semantic
embedder, Apprise, subscription (OAuth) providers, and users & registration.

## Development

Needs Node.js 24.x (`.nvmrc`), npm 10–11, Docker.

```bash
npm ci
docker compose -f docker-compose.dev.yml up -d   # PostgreSQL 16 + Redis 7
npm run dev                                      # API :3001, dashboard :3000
```

| Command                                      | What it does                     |
| -------------------------------------------- | -------------------------------- |
| `npm run build`                              | Production build (Turborepo)     |
| `npm test -w packages/<pkg>`                 | Unit tests for one package       |
| `npm run test:e2e -w packages/control-plane` | E2E (needs dev compose up)       |
| `npm run db:generate` / `npm run db:migrate` | Drizzle migrations (run on boot) |
| `npm run lint` / `npm run format`            | ESLint / Prettier                |

For a seeded dev admin, boot with `SEED_DATA=true` (loopback, non-production, self-hosted
only): `admin@polyrouter.local` / `changeme-dev-admin`. Change it immediately.

Work is spec-driven (OpenSpec). Read [`CLAUDE.md`](./CLAUDE.md) for the stack and
invariants, and [`STYLESEED.md`](./STYLESEED.md) for UI rules.

## Compliance note

Using flat-rate consumer subscriptions (ChatGPT Plus, Claude Max) programmatically likely
violates those providers' ToS. polyrouter supports the provider kind but flags the risk.
The coding plans (OpenCode Go, MiniMax M Plan, Kimi Code, Z.ai GLM Coding Plan) are
connected with an API key, but that key carries its plan's own terms: Z.ai forbids proxy and
aggregate use, and Kimi forbids automation and altering its client identity. polyrouter
states each plan's risk before you connect, and when a MiniMax, Kimi Code or Z.ai plan runs
out of allowance it pauses that provider until the reset time, skips it in routing and falls
back, without tripping the circuit breaker; OpenCode Go keeps the generic error mapping (see [Plan limits and pauses](./docs/self-hosting.md#plan-limits-and-pauses)).
Pay-per-token API keys and local models don't carry subscription terms risk.

## License

[AGPL-3.0](./LICENSE.md). If you offer a **modified** polyrouter as a network service, you
must offer its users your modified source.
