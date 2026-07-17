## MODIFIED Requirements

### Requirement: The product compose yields a working instance with one command

The repository SHALL provide a product `docker-compose.yml` (explicit project name distinct from the dev-infra compose's implicit one) defining `app` (built from source, image-tagged), `postgres` and `redis` (pinned images, named volumes, healthchecks the app waits on), and an optional `apprise` (`caronc/apprise`) service behind a compose profile. The compose SHALL set the containerized runtime env itself — `BIND_ADDRESS=0.0.0.0` (the loopback default would break the published port), `MODE=selfhosted`, `NODE_ENV=production`, service-network `DATABASE_URL`/`REDIS_URL` — SHALL source all secrets from a `.env` file (never committed files), SHALL pass **every registered optional runtime var** through as bare keys (unset stays unset — several reject empty strings; a registered var that is NOT passed through cannot be set from `.env`, so the allowlist SHALL stay in sync with the config registry), and SHALL publish the app port **on loopback by default** so the unauthenticated first-sign-up window and `/metrics` are never network-exposed before the operator claims the instance and opts in.

#### Scenario: clean-machine compose up works
- **WHEN** `docker compose up -d --build` runs from the repository with a populated `.env`
- **THEN** postgres and redis become healthy first, the app becomes healthy, and the loopback-published port serves the SPA, `/api/health`, and (by default) `/metrics`, with the first sign-up becoming the admin, a second sign-up NOT becoming admin, and no prompt/response bodies persisted by default

#### Scenario: apprise stays opt-in and actually works when enabled
- **WHEN** the stack starts without the apprise profile
- **THEN** no apprise container runs
- **WHEN** the operator enables the profile and sets the documented `APPRISE_API_URL` + `NOTIFY_ALLOWED_ENDPOINTS` pair
- **THEN** the app boots with the private-range Apprise endpoint admitted by the port-bounded allowlist (the SSRF guard stays intact rather than being bypassed)

#### Scenario: a registered optional var set in .env reaches the container
- **WHEN** an operator sets a registered optional var (e.g. `NOTIFY_WEEKLY_ENABLED`, `BUDGET_STALE_MS`, or `PROXY_IDLE_TIMEOUT_MS`) in `.env`
- **THEN** `docker compose config` renders it on the `app` service (the compose pass-through allowlist covers it), so the documented `.env` mechanism actually takes effect in the packaged distribution

### Requirement: Self-host documentation covers install, configuration, and the security posture

The repository SHALL include a top-level `LICENSE` file with the license the packages declare (MIT), so adopters have an actual grant rather than a bare `"license"` field. The README SHALL document: the one-line install (with its pipe-to-sh trust note and an inspect-first/clone alternative) and the manual compose path; **how to connect an agent** — the OpenAI/Anthropic-compatible endpoints (`/v1/chat/completions`, `/v1/messages`, `/v1/models`) with the base URL convention per SDK (an OpenAI client uses `<instance>/v1`; an Anthropic SDK uses `<instance>` and appends `/v1/messages`), the `poly_…` dashboard key, and selecting a model explicitly, via `auto`, or by tier with the `x-polyrouter-tier` header, with a curl example per protocol; the `.env` reference (secrets, `POLYROUTER_HOST`/`POLYROUTER_PORT`/`APP_URL`, `METRICS_ENABLED`, `OTEL_ENABLED` + OTLP endpoint, OAuth client vars, the apprise pair) **plus the sharp-edged operator tunables** — `SMTP_*` (absence silently disables password-reset email), `BUDGET_FAIL_OPEN` (default admits requests on an enforcement fault — flip it for a hard cap), and `ROUTING_AUTO_LAYERS` (cost-saving cascade is off until it lists `cascade`); that `/api/health` and `/metrics` are unauthenticated by design and that exposing beyond loopback is an explicit step taken AFTER claiming the admin account (reverse-proxy/TLS guidance); first-sign-up-is-admin; upgrade (rebuild — migrations run on boot) and backup (postgres volume) basics; the key-rotation caveat for the two encryption secrets; the `POSTGRES_PASSWORD`-is-initialization-only caveat; that scaling beyond one app replica is unsupported (boot migrations are not advisory-locked); and the §16 ToS caveat for subscription-kind providers. The reference spec's configuration section SHALL be kept in sync with the config registry (every registered var, its default, and which are required in production).

#### Scenario: an operator can self-serve
- **WHEN** an operator follows only the README's self-hosting section on a machine with Docker
- **THEN** they reach a working, secret-provisioned, loopback-published instance and know how to claim admin, expose it safely, change port/origin, enable apprise, scrape metrics, upgrade, and back up

#### Scenario: an adopter has a license and can connect an agent
- **WHEN** someone evaluates the repository for adoption
- **THEN** a `LICENSE` file grants the declared (MIT) terms, and the README shows how to point an OpenAI/Anthropic-compatible client at the instance (`<instance>/v1` for an OpenAI client) with a `poly_…` key and `model: "auto"` (or a tier via `x-polyrouter-tier`)

#### Scenario: sharp-edged defaults are documented
- **WHEN** an operator reads the `.env` reference
- **THEN** they learn that password reset needs `SMTP_*`, that `BUDGET_FAIL_OPEN` defaults to allow-on-fault (and how to fail closed), and that cascade routing requires `ROUTING_AUTO_LAYERS=structural,cascade`
