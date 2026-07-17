# packaging Specification

## Purpose
TBD - created by archiving change add-packaging. Update Purpose after archive.
## Requirements
### Requirement: One container image serves the whole product on one port

The repository SHALL build a single production Docker image in which the NestJS process serves the SPA, the dashboard API, and the inference proxy on one port, using the already-built workspace artifacts (monorepo layout preserved so the SPA dist and bundled migrations resolve unchanged). The image SHALL run as a non-root user with `NODE_ENV=production`, receive SIGTERM directly (exec-form entrypoint, no shell wrapper), apply migrations on boot before serving, and expose a container healthcheck against **`/api/health`** (the SPA fallback answers bare `/health` with HTML, which must never satisfy a health probe).

#### Scenario: the image boots the full product
- **WHEN** the image runs with valid required env against healthy postgres/redis
- **THEN** migrations apply before the port opens, `/api/health` returns 200 JSON, the SPA shell is served at `/`, and `/api` + `/v1` respond on the same port

#### Scenario: stopping the container drains an in-flight stream
- **WHEN** the container receives SIGTERM (e.g. `docker stop`) while a streamed completion is being served
- **THEN** the stream terminates cleanly for the client (drained, never severed mid-token without a terminal event), the writer and span exporter flush, and the container's inspected exit state is 0 within the grace period (never SIGKILLed)

### Requirement: The packaged SPA is self-contained

The built frontend SHALL load with zero third-party runtime fetches: the Geist/Geist Mono fonts are bundled locally (with their license) and no CDN `<link>`/import remains, so a self-hosted instance renders fully on an offline or egress-restricted network.

#### Scenario: no third-party fetch on load
- **WHEN** the packaged SPA loads in a browser with external egress blocked
- **THEN** the dashboard renders with its intended fonts, and the document references only same-origin assets

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

### Requirement: The install script bootstraps secrets and boots the stack

The repository SHALL provide an `install.sh` that verifies `curl`, `tar`, a reachable Docker daemon, and Compose v2 (no legacy fallback); fetches ONE pinned source archive and uses the compose file from inside it (compose and build context always the same commit; a checkout uses the working tree); generates the four required 32-byte-hex secrets (`BETTER_AUTH_SECRET`, `API_KEY_HMAC_SECRET`, `PROVIDER_CREDENTIAL_KEY`, `NOTIFY_CREDENTIALS_SECRET`) and a database password into a mode-600 `.env` written atomically under `umask 077`; and starts the stack under the product project name. The script SHALL be idempotent: an existing `.env` is NEVER overwritten or rotated (rotating the encryption keys would orphan encrypted provider/channel credentials — the script says so), and re-extraction stages cleanly. Idempotency SHALL hold for a **fetch** install re-run as well as a checkout: because a fetch install places the compose file under `src/` with `.env` beside it, re-running the installer from **inside** the created `polyrouter/` directory SHALL be recognized as a prior install — reusing the existing `.env` and refreshing `src/` **in place** — and SHALL NOT nest a `polyrouter/polyrouter/` tree, generate fresh secrets, or boot the fixed-name project against the existing volumes with a rotated `POSTGRES_PASSWORD`/`PROVIDER_CREDENTIAL_KEY`. A prior fetch install SHALL be identified by a **durable, polyrouter-specific marker** the fresh install writes into its root (not by a bare `src/docker-compose.yml`, which any unrelated project may have), so the installer SHALL NEVER treat an unrelated directory as one of its installs and replace that directory's `src/`; a directory without the marker is a fresh install (nested in a subdirectory) rather than a refresh. The source swap SHALL be failure-safe: the previous `src/` SHALL be preserved until the refreshed tree is in place, so an interrupted refresh recovers rather than losing the source. The no-rotation guarantee SHALL hold in **both** install modes (fetch and checkout): the script SHALL record — via a durable sentinel written beside `.env` — that secrets were generated in a directory, and SHALL REFUSE to regenerate (failing with guidance to restore `.env`) when that sentinel is present but `.env` is missing, so a `.env` deleted after a real install never causes a silent key rotation against the existing volumes. Secret values SHALL never be echoed to the terminal or logs.

#### Scenario: first run generates, second run preserves
- **WHEN** the script runs on a machine without a prior install and then runs again
- **THEN** the first run creates `.env` (600) with four distinct 32-byte-hex secrets and boots the stack, and the second run leaves `.env` byte-identical while re-applying the stack

#### Scenario: a fetch install re-run from inside the install directory preserves .env and does not nest
- **WHEN** the installer is run once in fetch mode (creating `polyrouter/{src/,.env}`) and then run again from **inside** that `polyrouter/` directory
- **THEN** no `polyrouter/polyrouter/` nesting is created, the existing `.env` is byte-identical (secrets are not rotated), `src/` is refreshed in place, and compose boots from `src/docker-compose.yml` under the same project name — so the running stack keeps authenticating against its existing volumes

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

### Requirement: The repository ships a security policy, a contributor guide, and complete metadata

The repository SHALL include a top-level `SECURITY.md` documenting a **private** vulnerability-disclosure
route (not a public issue) and the by-design sensitive areas (SSRF validation, credential handling,
tenant isolation, metadata-only privacy, and the loopback/`/metrics` exposure posture), and a top-level
`CONTRIBUTING.md` documenting local setup (Node 24 + Docker), the build/lint/typecheck/test commands, and
the OpenSpec spec-driven workflow with its definition of done. The root `package.json` SHALL carry a
`repository` field, and machine-generated migration artifacts SHALL be excluded from formatting checks so
`format:check` is not failed by generated output.

#### Scenario: an adopter finds the disclosure route and contributor guide

- **WHEN** someone evaluates or contributes to the repository
- **THEN** `SECURITY.md` gives a private disclosure route and `CONTRIBUTING.md` gives the setup, commands, and change workflow; the root `package.json` declares its `repository`; and `format:check` does not fail on drizzle-generated migration JSON

