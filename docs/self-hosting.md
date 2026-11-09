# Self-hosting

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
    image: ghcr.io/izzoa/polyrouter:0.29.0 # or :latest — pin the current release
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

| Variable                                                                                                  | Default                               | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`, `API_KEY_HMAC_SECRET`, `PROVIDER_CREDENTIAL_KEY`, `NOTIFY_CREDENTIALS_SECRET`       | generated                             | Required 32-byte-hex secrets (sessions, agent-key HMAC, credential + channel encryption at rest)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `POSTGRES_PASSWORD`                                                                                       | generated                             | Database password — **initialization-only**: changing it later does NOT rotate the role password in postgres                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `POLYROUTER_HOST` / `POLYROUTER_PORT`                                                                     | `127.0.0.1` / `3001`                  | Host interface/port the app is published on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `APP_URL`                                                                                                 | `http://localhost:3001`               | Public origin (Better Auth base URL) — set it when exposing. Also gates **links in notification emails**: a loopback value omits them (see Notification emails)                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `METRICS_ENABLED`                                                                                         | `true`                                | Prometheus `/metrics` (404 when `false`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `OTEL_ENABLED` / `OTEL_EXPORTER_OTLP_ENDPOINT`                                                            | `false` / SDK default                 | OpenTelemetry traces for the proxy path (batched OTLP/HTTP export)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `GOOGLE_/GITHUB_/DISCORD_CLIENT_ID`+`_SECRET`                                                             | unset                                 | Optional OAuth sign-in providers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `APPRISE_API_URL` + `NOTIFY_ALLOWED_ENDPOINTS`                                                            | unset                                 | Optional Apprise fan-out — see below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` / `SMTP_SECURE`                       | unset (`PORT` 587, `SECURE` starttls) | Server-wide SMTP for password-reset **and invite** email — **active only when both `SMTP_HOST` and `SMTP_FROM` are set; otherwise password reset silently never sends and invites must be delivered by copying the link.** Rely on OAuth if you don't set it                                                                                                                                                                                                                                                                                                                                                           |
| `ROUTING_AUTO_LAYERS`                                                                                     | `structural`                          | Which smart-routing layers are on. **Cascade (cheap→escalate) is OFF until you set `structural,cascade`** — the dashboard toggle just shows it greyed out otherwise                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ROUTING_STRUCTURAL_WEIGHTS`                                                                              | built-ins                             | JSON override for the Layer-1 classifier. Ambient keys (`size` `code` `tools` `schema` `depth` `multimodal` `maxTokens`) merge over the defaults and normalize to sum 1; the `reasoning` key is the declared-hint adjustment magnitude in `[0, 0.5]` (default `0.1`), NOT normalized. A declared `reasoning_effort`/`thinking` steers the score; a maximal declaration routes `auto_high` directly                                                                                                                                                                                                                     |
| `ROUTING_WORKLOAD_THRESHOLDS`                                                                             | built-ins                             | JSON override for the structural **workload** classifier (detection only — routing happens through a configured Workload target): `codeShare` in `(0, 1]` (default `0.3`) and integer `codeMinChars ≥ 0` (default `200`). An `auto` request records workload `code` when fenced code is at least that share of the scanned window AND at least that many chars; `vision` (an image block) and `structured` (a declared JSON output format) are binary. Unknown keys / out-of-range values fail boot.                                                                                                                   |
| `CALIBRATION_SCHED_ENABLED` / `CALIBRATION_SCHED_CRON`                                                    | `true` / `0 4 * * *`                  | The per-tenant threshold-calibration sweep (opt-in PER TENANT from the Routing page; this pair gates the background worker instance-wide)                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `CALIBRATION_WINDOW_DAYS` / `CALIBRATION_MIN_EDGE_SAMPLES` / `CALIBRATION_STEP` / `CALIBRATION_MAX_DRIFT` | `14` / `50` / `0.02` / `0.1`          | Calibration rails: evidence window, minimum fresh edge-zone samples (hard floor 50 — only raisable), bounded per-run step, and the max total drift from the instance thresholds. Every move is audited and one click from reverted                                                                                                                                                                                                                                                                                                                                                                                     |
| `BUDGET_FAIL_OPEN`                                                                                        | `true`                                | On a Redis/enforcement fault, block budgets **admit** the request (availability-first). Set `false` for a hard cap that returns `503` instead                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `TRUSTED_PROXY_CIDRS`                                                                                     | unset                                 | CIDRs of reverse proxies allowed to set `X-Forwarded-For` (rate-limit client-IP trust) — set it when behind a proxy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `NOTIFY_APPRISE_EGRESS_CONFIRMED`                                                                         | `false`                               | Cloud-mode (`MODE=cloud`) acknowledgement before Apprise delivery runs — the SSRF allowlist (`NOTIFY_ALLOWED_ENDPOINTS`) is still enforced independently                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `PRICING_REFRESH_URL`                                                                                     | LiteLLM catalog                       | Source for pricing refreshes (a bundled snapshot ships by default; the Settings page shows catalog status + a Refresh-now button for admins)                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PRICING_REFRESH_SCHED_ENABLED` / `PRICING_REFRESH_SCHED_CRON`                                            | `true` / `30 4 * * *`                 | **Daily automatic pricing refresh — ON by default** (self-host only): one outbound GET of LiteLLM's public price catalog per day; no tenant data is sent. Set `PRICING_REFRESH_SCHED_ENABLED=false` to opt out; manual refresh keeps working                                                                                                                                                                                                                                                                                                                                                                           |
| `PROXY_FIRST_EVENT_TIMEOUT_MS` / `PROXY_IDLE_TIMEOUT_MS`                                                  | `30000` / `30000`                     | Time-to-first-token / buffered-read idle bound — **raise both for slow local models** (a 30s prefill would otherwise 503 and trip the breaker). For ONE slow provider in a mixed chain, prefer its per-provider override (the provider form's "Advanced — patience for slow models") over raising the instance default: timeouts trip that provider's breaker, and while its recovery probe runs with doubled patience, a provider slower than 2× its bound stays in a skip loop until its patience is raised                                                                                                          |
| `PROXY_STREAM_HEARTBEAT_MS` / `PROXY_STREAM_EARLY_COMMIT_MS`                                              | `15000` / `20000`                     | Stream keepalives: a keepalive after this much client-facing silence on a streaming response, and an early `200` + SSE headers (then keepalives) when no first token has arrived by the second value — so a CDN/proxy idle limit (Cloudflare ~100s) never drops a slow or thinking stream. Each must be `0` (off) or below 60000. With the early commit on, a stream that fails **after** it gets its error inside the stream instead of an HTTP status; `PROXY_STREAM_EARLY_COMMIT_MS=0` restores status codes for every pre-first-token failure. See [Behind a reverse proxy or CDN](#behind-a-reverse-proxy-or-cdn) |
| `SEMANTIC_MODEL_PATH`                                                                                     | unset                                 | Opt-in **Layer 2 semantic embedder**: path to a local model bundle (see the semantic-layer section) — pair it with `semantic` in `ROUTING_AUTO_LAYERS`. Also enables the semantic **workload** source (`research` / `writing`). Unset = the module is absent entirely; a set-but-broken path fails boot loudly                                                                                                                                                                                                                                                                                                         |
| `EVENTS_ENABLED`                                                                                          | `true`                                | Dashboard live event stream (`GET /api/events`). `false` turns it off entirely and the dashboard stays on its normal polling refresh — no feature is lost, only push                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `EVENTS_HEARTBEAT_MS`                                                                                     | `25000`                               | Keep-alive interval; must stay under your proxy's idle-reap window (boot fails if ≥ 60s). Also bounds how fast a revoked session's open stream is closed                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `SEMANTIC_TIMEOUT_MS` / `SEMANTIC_MAX_INPUT_CHARS` / `SEMANTIC_CONCURRENCY`                               | `50` / `2000` / `2`                   | Embedder bounds: per-embed hard timeout, input cap before tokenization, concurrent-inference cap (saturation skips the layer for that request). Out-of-bounds values reject boot                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `SEMANTIC_WORKLOAD_MARGIN` / `SEMANTIC_WORKLOAD_MIN_SIM`                                                  | `0.05` / `0.20`                       | Semantic **workload** rails (need the semantic module): a structural-`none` `auto` request records `research` / `writing` only when the winning class leads the runner-up by ≥ `MARGIN` (the discriminating rail) and its cosine is ≥ `MIN_SIM` (a near-orthogonal guard; the spike showed 0.30 cost recall for no precision). Both ≤ 4 decimals, both part of the `semantic/…` workload revision, so a change never silently mixes two populations                                                                                                                                                                    |
| `POLYROUTER_SUBNET` / `POLYROUTER_IMAGE`                                                                  | `172.28.5.0/24` / built               | Compose network CIDR (change on a collision) / prebuilt image override                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

> **Outbound identity.** polyrouter identifies itself to every upstream it contacts (your
> providers, their OAuth token endpoints, the pricing source and the Apprise sidecar) as
> `User-Agent: polyrouter/<version>`, where `<version>` is the release version the dashboard
> shows. It never forwards a calling agent's `User-Agent`, and the value is not configurable.

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

### Behind a reverse proxy or CDN

Reverse proxies, load balancers, and CDNs close a connection their origin leaves silent
for too long — Cloudflare after about **100 seconds**, nginx's default `proxy_read_timeout`
after 60. An LLM stream can easily be that quiet: a cascade's cheap first attempt runs
buffered, a large prompt takes a while to reach its first token, and a thinking model's
reasoning isn't forwarded. polyrouter keeps streaming responses alive on its own:

- **After the first token**, whenever `PROXY_STREAM_HEARTBEAT_MS` (15s) passes with nothing
  sent, it writes a keepalive — an SSE comment line (`: keep-alive`) for OpenAI clients, and
  Anthropic's own `event: ping` for `/v1/messages` clients. Keepalives are never model
  output and never count toward tokens or cost.
- **Before the first token**, if none has arrived after `PROXY_STREAM_EARLY_COMMIT_MS`
  (20s), it sends `200` and the SSE headers early and keeps the connection alive with
  comment keepalives. Fallback and cascade still run exactly as before until the first
  token — only the HTTP response has started, not a model. If every model then fails, the
  error arrives **inside the stream** (the same error type and message, in your protocol's
  streaming-error shape) rather than as an HTTP status; set `PROXY_STREAM_EARLY_COMMIT_MS=0`
  if your client needs status codes for those late failures.
- Streams send `X-Accel-Buffering: no`, so nginx-style buffering doesn't hold keepalives
  back.

Limits: keepalives reset **idle** timers, not a hard cap on total request time, and
**non-streaming** requests can't carry them — use `stream: true` for calls that may take
longer than your proxy's limit.

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

**What the module enables** (all local; each opt-in per tenant in the dashboard): Layer-2
band classification for the requests Layer 1 finds ambiguous; the optional learning loop
that adapts its centroids from recorded cascade outcomes; and the **semantic workload
source** — `research` / `writing` detection for structural-`none` `auto` requests (see
[Workload routing](routing.md#workload-routing)). The workload anchors are plain bundled data in the
package — no extra files, nothing downloaded — and boot behind their own readiness check,
so the auto-layers view reports "semantic workload" separately from L2 and names what is
missing. Rails: `SEMANTIC_WORKLOAD_MARGIN` / `SEMANTIC_WORKLOAD_MIN_SIM`.

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
- **Compliance note:** using flat-rate consumer _subscriptions_ (ChatGPT Plus, Claude Max) programmatically likely violates those providers' ToS — polyrouter supports the provider kind but surfaces the risk. Coding-plan API keys (OpenCode Go, MiniMax M Plan, Kimi Code, Z.ai GLM Coding Plan) carry their plan's own terms risk, stated per plan when you connect ([below](#subscriptions-api-key-presets)); pay-per-token API keys and local models don't carry subscription terms risk.

### Subscriptions (OAuth)

Subscription providers can connect through a guided **OAuth wizard** instead of pasting a
token by hand: pick a preset (**Claude Pro/Max** or **ChatGPT Plus/Pro**), sign in at the
provider's link, and paste the redirect URL — or the `code#state` string it shows — back
into the dashboard. polyrouter verifies the `state`, exchanges the code (PKCE), and stores
the access + refresh tokens **encrypted at rest**. Tokens renew **in the background**, safe
across multiple requests and instances:

- **Near expiry** — a scheduled sweep (every 15 minutes) renews any sign-in within an hour of
  expiring, so an idle provider never lapses; a request arriving first renews it on the spot.
- **Daily liveness check** — each sign-in is also re-verified about once a day, so a grant the
  provider has **revoked** turns into "reconnect" on its own, without waiting for traffic to
  hit it. These checks are budgeted per sweep, so a first deploy (when nothing is marked
  verified yet) spreads them over several sweeps instead of dialling every provider at once.
- **A live 401** — when the provider rejects a sign-in that should still be valid, polyrouter
  makes **one** background renewal attempt (at most once per 10 minutes per credential); the
  rejected request itself falls back through your chain exactly as before.

The sweep only ever calls each provider's **token endpoint** — it never sends a model request,
so it spends none of your plan.

**Models come from the provider, never from polyrouter.** Both presets list their models from
the provider's own authenticated catalog, and **Test is that listing** — it names no model, so a
model the provider retires can never turn Test red. The daily model-list refresh
([below](#model-lists-stay-current)) keeps subscriptions current like every other provider.

Every OAuth card has a **Reconnect** action at any time (not only after a revoked sign-in): it
reopens the connect wizard and renews the same provider in place, keeping its models and routing
entries. The card shows one status line — the most recent of your
last check (Test, Sync) and what live traffic observed — with the reason and how long ago.

Honest caveats:

- **These integrations ride undocumented contracts.** The OAuth endpoints and what the
  provider accepts from subscription tokens are ecosystem-known, not published APIs — the
  provider can change them at any time. Each preset ships enabled only after its own live
  verification — both passed on 2026-07-18 (`scripts/verify-claude-oauth.md`,
  `scripts/verify-chatgpt-oauth.md` record the runs and the pinned constants);
  failures surface as a clear provider error. A subscription preset may declare a client
  identity; it is sent only after you turn on that provider's identity-imitation switch
  (off by default), and doing so likely violates the provider's terms.
- **Upgrading existing Claude and ChatGPT connections.** From this release their traffic
  announces `User-Agent: polyrouter/<version>` instead of the HTTP library's name. An
  upstream could single that out; if one rejects it, the rejection shows as the provider
  error on the connection's card.
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
  OAuth-connected providers will then ask to be reconnected.

### Subscriptions (API-key presets)

Four coding plans connect with a **static API key** instead of a sign-in: **OpenCode Go**,
**MiniMax M Plan**, **Kimi Code** and **Z.ai GLM Coding Plan**. On **Add provider** →
**Subscription**, the dialog widens into one list of every plan — the sign-in plans (Claude,
ChatGPT) under **Sign in with your account**, the four coding plans under **Coding-plan API
key** — with the chosen plan's detail beside it. Choose a plan, keep or change the region
(MiniMax, Kimi and Z.ai each have an international and a China host; the first is preselected
and its host is shown), paste the key, and press **Connect** (the button names the plan). On a phone the list
and the detail are two steps. The endpoint and protocol are
pinned by the preset, so there is no URL to type or mistype, and the key is stored
**encrypted at rest** and never shown again. Then **Sync models**: the preset carries no model
ids, the models come from the provider's own listing, and Test is that listing.

- **Terms risk is stated per plan.** The list names each plan's level (low, medium or high),
  and its detail shows a plain summary of the provider's terms and a link to them. OpenCode Go and MiniMax allow
  other clients. Kimi Code is meant for interactive use and forbids reverse-proxy sharing,
  non-interactive automation and altering its client identity. **Z.ai is high risk:** its
  terms forbid aggregate and proxy use unless you hold a separate written agreement, so
  Connect needs you to tick an acknowledgement (the server enforces it too).
- **A key-type warning, never a block.** A key that does not match the plan's expected
  prefix shows a caution that it may be a pay-as-you-go key, which bills your account balance
  instead of the plan. You can still connect.
- **Locked endpoint, editable everything else.** Edit shows the endpoint, kind and
  protocol read-only. You can rename, rotate or clear the key, and change timeouts and
  auto-prune. To change region, delete the provider and connect again.
- **Honest User-Agent by default.** Every call announces `User-Agent: polyrouter/<version>`.
  Kimi Code and Z.ai also declare an optional **Claude Code** identity that is sent only when
  you turn on that provider's **identity imitation** switch — in the plan's detail when you
  connect it, or later in Edit (off by default either way; it warns and asks you to confirm,
  and likely violates the provider's terms). If a region only
  works with imitation, its list entry and detail say so and the preset is rated high risk.
- **Cost.** Subscription rows are counted as notional spend, never cash. Z.ai (international)
  and MiniMax (international) map to the bundled price catalog, so a model the catalog prices
  records a catalog-based notional cost; any other model falls back to a marked listed-price
  estimate, or to unknown cost. OpenCode Go, Kimi and the China hosts have no catalog
  mapping, so their cost is recorded as unknown and flagged, never guessed (unless the
  provider's own listing carried a price, in which case a marked estimate is recorded).
- **Every plan is listed, and none has had a live run yet.** All four presets and their
  regions are offered on every install. Their pinned endpoints follow each provider's
  documentation, but some details (a listing path, a token-cap field, the China hosts) have not
  been confirmed with a real key, so if one is wrong, **Test** or **Sync models** reports a
  typed provider error naming the failure — nothing is ever sent to any host other than the
  pinned one. The runbooks (`scripts/verify-opencode-go-key.md`,
  `scripts/verify-minimax-key.md`, `scripts/verify-kimi-key.md`, `scripts/verify-zai-key.md`)
  are optional QA for confirming them with your own key; a region found broken is withdrawn in
  a release, and rows already connected from it keep working. **Other subscription (paste a
  credential)** stays available for anything else.
- **The compliance note above applies**: pair a plan with a pay-per-token fallback.

#### Plan limits and pauses

A coding plan answers with its own error when it runs out of allowance, and polyrouter reads
that error instead of treating it as a generic rate limit. This applies to the key presets only:
the classification keys on the provider's documented error codes or message templates, on the
preset's pinned host, and never on a URL you typed. There are four kinds:

| Kind                                                  | What the provider said                                                     | What polyrouter does                                      |
| ----------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------- |
| Plan usage limit reached (`quota_exhausted`)          | The 5-hour, weekly, monthly or credit allowance is used up                 | Pauses that provider                                      |
| Provider throttled the account (`risk_control`)       | A fair-use, concurrency or risk-control limit that usually needs an appeal | Pauses that provider                                      |
| No active plan for this key (`plan_inactive`)         | The plan expired or was cancelled, or the key is not a plan key            | Pauses that provider                                      |
| Plan does not include this model (`plan_entitlement`) | The plan's tier excludes the requested model                               | Falls back, no pause: other models on the plan still work |

- **A pause skips the provider, then the request moves on.** While a provider is paused, every
  chain that lists it skips it without contacting it and tries the next member, exactly as a
  fallback does. If every member is paused, the request fails at once with `429
plan_quota_exhausted` or `429 plan_risk_control` (HTTP 429, as `rate_limited` was), or
  `502 plan_inactive`. Clients that branch on the status see no change; clients that read the
  `code` see the new, more specific one. polyrouter never waits out a pause.
- **A recognised exhaustion no longer raises `provider_down`.** These failures do not count
  toward the circuit breaker, so a plan that is simply out of allowance does not trip the
  breaker or send a provider-down notification. A genuine outage (a 5xx, a timeout, a refused
  connection) still does.
- **How long.** If the provider states when the allowance resets, polyrouter pauses until then
  (Z.ai states it in the message; a `Retry-After` is honoured as well). Otherwise it uses a
  default: 15 minutes for a short window (5 hours), 60 minutes for a long one (weekly, monthly,
  credit), 30 minutes for a risk-control throttle, 60 minutes for an inactive plan. Every pause
  is held between 1 minute and 7 days, so a malformed time can neither cause a retry storm nor
  park a provider for weeks. The pause is shared through Redis, so every polyrouter instance
  agrees on it, and it never outlives its end time.
- **The card says so.** A paused provider's card shows one amber line that leads with the account
  condition and the time, for example `Plan usage limit reached — resets at 18:00 UTC`, or
  `… polyrouter retries at 18:00 UTC` when polyrouter chose the time. The line returns to the
  provider's health at that time without a reload. The Request inspector's route trace marks a
  skipped member `skipped — plan paused (provider not contacted)`.
- **Resume now** lifts a pause at once, from the card. For a risk-control pause it asks first:
  sending again early may make the provider restrict your account further, so the dialog
  explains that and commits with **Resume provider**. Test and Sync models still call a paused
  provider, which is how you check it. If the shared store is unreachable the lift answers 503
  and says so, rather than reporting a resume that did not happen.
- **Rotating the key lifts the pause**, because a new key may belong to another plan. Deleting a
  provider does not need to: its pause expires within 7 days and the id is never reused.
- **What is classified.** Z.ai, MiniMax and Kimi Code in their international regions, and Kimi
  Code's China region (its error reference uses the same English messages). **OpenCode Go
  has none** until a real error response is captured. **The Z.ai and MiniMax China regions
  have none either**: their error references are in Chinese or on separate documentation, so
  their shapes are unverified; their errors keep the generic mapping (a 429 is a plain
  `rate_limited`), as does an "Other subscription" row, a drifted base URL and any OAuth row.
- **Kimi's membership 403 stays a plain permission failure.** "We're unable to verify your
  membership benefits at this time" is documented as transient (it says to wait and retry), so
  it is not read as a plan problem.
- **Kimi's "engine is currently overloaded" 429 reads as unavailable**, because Kimi documents it
  as unrelated to your quota. There is one open question: community reports say Kimi also sends
  an overload answer, or a 403 "only available for Coding Agents", to a User-Agent that is not
  on its allow-list, and polyrouter's honest `polyrouter/<version>` User-Agent may be one of
  them. The runbook (`scripts/verify-kimi-key.md`, "Error-shape evidence") records whether that
  happens, and if it does the label will change in a later release. This is not decided here.
- **Not covered yet:** a notification when a plan pauses and `Retry-After` handling for providers
  without a preset. How much of a plan's allowance is left is shown on the card, as described
  next.

#### Plan usage on the card

A subscription card can show one neutral usage line, for example `5h 2% · resets 14:00 · weekly
74% · resets Mon 09:00 · as of 13:41 UTC`. It is display only: it never changes routing, the
fallback order, the circuit breaker, a plan pause, health, cost, budgets or notifications, it is
never forwarded to your agents (the quota headers are read here and not passed on), and missing
or stale data blocks nothing. polyrouter stores only parsed numbers and enums, never a header or
a response body, in Redis (the snapshot expires within 32 days). A Redis flush shows `unknown`
until the next response or refresh. A figure that is not known reads `unknown`, never `0%`.

Where the numbers come from:

| Plan                         | Source                                                                                                         | Refresh usage |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------- |
| Claude Pro/Max               | The `anthropic-ratelimit-unified-*` headers on replies polyrouter already gets                                 | No            |
| ChatGPT Plus/Pro             | The `x-codex-*` headers on replies polyrouter already gets                                                     | No            |
| OpenCode Go                  | `usage.opencode.billing_source` on replies (the billing state only), and `https://opencode.ai/zen/go/v1/usage` | Yes           |
| MiniMax M Plan (intl)        | `https://api.minimax.io/v1/token_plan/remains`                                                                 | Yes           |
| Kimi Code (intl)             | `https://api.kimi.ai/coding/v1/usages`                                                                         | Yes           |
| Kimi Code (China)            | `https://api.kimi.com/coding/v1/usages`                                                                        | Yes           |
| Z.ai GLM Coding Plan (intl)  | `https://api.z.ai/api/monitor/usage/quota/limit`                                                               | Yes           |
| Z.ai GLM Coding Plan (China) | `https://open.bigmodel.cn/api/monitor/usage/quota/limit`                                                       | Yes           |

The MiniMax China region has no usage endpoint, so it shows nothing. An "Other subscription" row,
a pay-as-you-go row on a preset's host and a row whose endpoint no longer matches its preset show
no usage line and offer no refresh.

- **Passive capture costs nothing.** Claude, ChatGPT and OpenCode Go usage is read from the
  replies of requests you already send, from **Test** and from a manual **Sync models**. The
  scheduled daily model-list refresh captures nothing. Each instance writes a provider's snapshot
  only when a whole-percent figure, a reset minute or the billing state changes, or at most once a
  minute while traffic continues, so a steady stream makes no extra Redis call.
- **There is no Refresh usage for Claude or ChatGPT.** Their usage comes only from their own
  traffic, Test and sync. polyrouter never calls Anthropic's `/api/oauth/usage` or ChatGPT's
  `/wham/` endpoints.
- **Refresh usage is attended and rate limited.** For the key plans above it is a button on the
  card; nothing calls a usage endpoint on a schedule, from traffic, from the OAuth sweep or from
  the catalog refresh. A press claims a **5-minute cooldown shared through Redis** before it calls,
  so two presses (even on two instances) make one read, a failed read still uses the cooldown, and
  a usage endpoint's own `Retry-After` extends it (to at most one hour). If Redis is unreachable
  the refresh is refused (503) rather than sent unthrottled. The read is a plain `GET` of the
  endpoint in the table with your key and `User-Agent: polyrouter/<version>`: it never sends the
  imitation identity, whatever the provider's switch says.
- **Each region's endpoint ships disabled.** A usage endpoint is switched on only after its
  section of `scripts/verify-plan-usage.md` (9.3 OpenCode Go, 9.4 MiniMax, 9.5 Kimi, 9.6 Z.ai;
  9.7 enables the verified probes) has passed against a real plan key. The per-preset
  `verify-*-key.md` runbooks remain the connect-time checks.
  Until then that region's card offers no Refresh usage and a refresh request for it answers 422
  without a call. Claude and ChatGPT usage needs no such check: it only reads replies.
- **Numbers are account-wide.** A plan's allowance is per account and shared with every other tool
  you use on it, so the line shows what the provider reports for the account, never polyrouter's
  share. Two providers on one account each keep their own snapshot and cooldown.
- **"Now billing extra usage."** When a reply says the plan has spilled into paid overflow
  (Claude usage credits, OpenCode Go's balance) the line says so; for ChatGPT, where this is an
  inference from a full window and credits on the account, it says credits _may_ be in use. That
  spend is not metered by your cash budgets.
- **Rotating a key or reconnecting starts from unknown.** Changing the credential, or reconnecting
  an OAuth provider, discards its snapshot (the new credential may belong to another account) and
  ignores any read still in flight from the old one. The refresh cooldown is kept, so re-sending
  the same key never skips it.
- **Kimi's terms and its 403.** Kimi Code forbids reverse-proxy sharing and non-interactive
  automation, and Moonshot has not answered whether a third-party reader of the usage endpoint is
  acceptable (kimi-code#2937). The 5-minute cooldown is the conservative reading, and the read is
  user-clicked only. Kimi can also answer **403 when a plan is used up**, so an exhausted Kimi plan
  may show the credential-style status line beside a full usage line (the plan-limit
  classification above reads Kimi quota texts on a 429 only), and a refused Kimi usage read is
  worded as ambiguous: the plan may be used up or the key may lack access.
- **Z.ai's terms.** Z.ai's terms forbid aggregate and proxy use without a separate written
  agreement. The usage read is a single account-level `GET` that you press, but the high-risk
  acknowledgement that Connect asks for still applies.

### Model lists stay current

polyrouter **re-lists every provider's models about once a day** in the background — API-key,
custom, local, and subscription providers alike (anything with a credential, or a local server;
a provider waiting to be reconnected is skipped; local servers only on a self-hosted instance).
It only calls the provider's model listing — never a chat or a Test — spreads the work
round-robin over hourly ticks, backs off from an endpoint that keeps failing (1h, 2h, 4h … up to
a day), and a listing's success or failure never changes the provider's status. (Getting a
listing still renews an expiring sign-in as any request would, so a sign-in the provider has
revoked is still recorded as "reconnect".) New models appear on their own. A model the provider **stops listing** is
marked **"no longer offered"** — on the Providers page, in the model picker, and on every tier
entry or rule that routes to it — rather than silently kept or deleted. Routing still sends to it
(a rejection falls through your chain as usual); once you've moved your routing off it,
**Remove** deletes it, after telling you which tier entries and rules it affects. **Sync models**
still refreshes a provider on demand.

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
