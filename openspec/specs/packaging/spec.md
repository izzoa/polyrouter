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

The repository SHALL provide a product `docker-compose.yml` (explicit project name distinct from the dev-infra compose's implicit one) defining `app` (built from source, image-tagged), `postgres` and `redis` (pinned images, named volumes, healthchecks the app waits on), and an optional `apprise` (`caronc/apprise`) service behind a compose profile. The compose SHALL set the containerized runtime env itself — `BIND_ADDRESS=0.0.0.0` (the loopback default would break the published port), `MODE=selfhosted`, `NODE_ENV=production`, service-network `DATABASE_URL`/`REDIS_URL` — SHALL source all secrets from a `.env` file (never committed files), SHALL pass optional vars through as bare keys (unset stays unset — several reject empty strings), and SHALL publish the app port **on loopback by default** so the unauthenticated first-sign-up window and `/metrics` are never network-exposed before the operator claims the instance and opts in.

#### Scenario: clean-machine compose up works
- **WHEN** `docker compose up -d --build` runs from the repository with a populated `.env`
- **THEN** postgres and redis become healthy first, the app becomes healthy, and the loopback-published port serves the SPA, `/api/health`, and (by default) `/metrics`, with the first sign-up becoming the admin, a second sign-up NOT becoming admin, and no prompt/response bodies persisted by default

#### Scenario: apprise stays opt-in and actually works when enabled
- **WHEN** the stack starts without the apprise profile
- **THEN** no apprise container runs
- **WHEN** the operator enables the profile and sets the documented `APPRISE_API_URL` + `NOTIFY_ALLOWED_ENDPOINTS` pair
- **THEN** the app boots with the private-range Apprise endpoint admitted by the port-bounded allowlist (the SSRF guard stays intact rather than being bypassed)

### Requirement: The install script bootstraps secrets and boots the stack

The repository SHALL provide an `install.sh` that verifies `curl`, `tar`, a reachable Docker daemon, and Compose v2 (no legacy fallback); fetches ONE pinned source archive and uses the compose file from inside it (compose and build context always the same commit; a checkout uses the working tree); generates the four required 32-byte-hex secrets (`BETTER_AUTH_SECRET`, `API_KEY_HMAC_SECRET`, `PROVIDER_CREDENTIAL_KEY`, `NOTIFY_CREDENTIALS_SECRET`) and a database password into a mode-600 `.env` written atomically under `umask 077`; and starts the stack under the product project name. The script SHALL be idempotent: an existing `.env` is NEVER overwritten or rotated (rotating the encryption keys would orphan encrypted provider/channel credentials — the script says so), and re-extraction stages cleanly. Secret values SHALL never be echoed to the terminal or logs.

#### Scenario: first run generates, second run preserves
- **WHEN** the script runs on a machine without a prior install and then runs again
- **THEN** the first run creates `.env` (600) with four distinct 32-byte-hex secrets and boots the stack, and the second run leaves `.env` byte-identical while re-applying the stack

### Requirement: Self-host documentation covers install, configuration, and the security posture

The README SHALL document: the one-line install (with its pipe-to-sh trust note and an inspect-first/clone alternative) and the manual compose path; the `.env` reference (secrets, `POLYROUTER_HOST`/`POLYROUTER_PORT`/`APP_URL`, `METRICS_ENABLED`, `OTEL_ENABLED` + OTLP endpoint, OAuth client vars, the apprise pair); that `/api/health` and `/metrics` are unauthenticated by design and that exposing beyond loopback is an explicit step taken AFTER claiming the admin account (reverse-proxy/TLS guidance); first-sign-up-is-admin; upgrade (rebuild — migrations run on boot) and backup (postgres volume) basics; the key-rotation caveat for the two encryption secrets; the `POSTGRES_PASSWORD`-is-initialization-only caveat; that scaling beyond one app replica is unsupported (boot migrations are not advisory-locked); and the §16 ToS caveat for subscription-kind providers.

#### Scenario: an operator can self-serve
- **WHEN** an operator follows only the README's self-hosting section on a machine with Docker
- **THEN** they reach a working, secret-provisioned, loopback-published instance and know how to claim admin, expose it safely, change port/origin, enable apprise, scrape metrics, upgrade, and back up

