---
type: Playbook
title: Deployment & Operations
description: How to deploy polyrouter — Docker Compose setup, environment variables, install script, the `-semantic` image variant, the Layer-2 semantic embedder bundle contract, configuration validation, and operational runbook including semantic learning sweep.
tags: [deployment, docker, operations, configuration, environment, semantic, layer-2]
resource: docker-compose.yml
---

# Deployment & Operations

Polyrouter is designed for self-hosting with Docker Compose. A one-command installer bootstraps the full stack, and the prebuilt multi-arch image is published to GHCR. A batteries-included `-semantic` image variant ships Layer 2 with the ONNX runtime and reference model pre-baked.

## Quick Install (Baseline)

```bash
curl -fsSL https://raw.githubusercontent.com/izzoa/polyrouter/main/install.sh | sh
```

This script:

1. Verifies Docker and Compose v2 are installed
2. Downloads the source archive
3. Generates cryptographic secrets into `.env`
4. Boots the stack via `docker compose up -d`

The install is **idempotent** — re-running refreshes the source while preserving your `.env` and data. Migrations run on boot.

## Docker Compose Stack

```yaml
# docker-compose.yml (baseline — the self-host product stack)
name: polyrouter-selfhost

services:
  app:
    image: ghcr.io/izzoa/polyrouter:latest
    ports:
      - '${POLYROUTER_HOST:-127.0.0.1}:${POLYROUTER_PORT:-3001}:3001'
    depends_on:
      postgres: { condition: service_healthy }
      redis:    { condition: service_healthy }
    stop_grace_period: 45s   # drain in-flight streams on SIGTERM
    environment:
      NODE_ENV: production
      MODE: selfhosted
      # ... (full list below)

  postgres:
    image: postgres:16-alpine
    healthcheck: { test: ['CMD-SHELL', 'pg_isready -U polyrouter -d polyrouter'], interval: 5s, ... }

  redis:
    image: redis:7-alpine
    healthcheck: { test: ['CMD', 'redis-cli', 'ping'], interval: 5s, ... }

  # Optional URL-based notification fan-out (opt-in profile)
  apprise:
    image: caronc/apprise:latest
    profiles: ['apprise']
```

### Network Security

- **Loopback-only** — the app binds to `127.0.0.1` by default; expose externally only behind a reverse proxy
- **Pinned subnet** — the Compose network uses a deterministic `172.28.5.0/24` (override via `POLYROUTER_SUBNET`) so the documented `NOTIFY_ALLOWED_ENDPOINTS` CIDR is stable
- **SSRF guard** — every outbound provider URL, Apprise target, and webhook URL is checked against private/loopback/link-local/metadata ranges; loopback is allowed only for `local` provider kind in self-host mode

## Prebuilt Image

Multi-arch images (amd64 + arm64) are published to GHCR on release tags:

```
ghcr.io/izzoa/polyrouter:latest
ghcr.io/izzoa/polyrouter:v0.8.0
ghcr.io/izzoa/polyrouter:latest-semantic    # Layer-2 batteries-included variant
ghcr.io/izzoa/polyrouter:v0.8.0-semantic
```

## Optional: Layer 2 (semantic) image variant

The optional semantic stack embeds request text locally (CPU ONNX, ~5–20 ms) so the auto-router can classify what the structural layer finds ambiguous. It is **never part of the baseline install**:

- The runtime (`onnxruntime-node@1.27.0`) is an exact-pinned optional peer dependency, imported only when `SEMANTIC_MODEL_PATH` is set.
- No model ships in the baseline image. CI asserts this on every build (`runtime` target carries zero ONNX artifacts).
- A **batteries-included `-semantic` image** ships with the ONNX runtime and the reference embedding model (`sentence-transformers/all-MiniLM-L6-v2`, Apache-2.0, 384-dim) baked in at build time, with `SEMANTIC_MODEL_PATH` preset.

### Run the batteries-included `-semantic` image

```sh
# Layer it over the base compose
docker compose -f docker-compose.yml -f docker-compose.semantic.yml up -d

# Or run the published image directly (set the capability so semanticAvailable is on)
docker run … -e ROUTING_AUTO_LAYERS=structural,semantic,cascade \
  ghcr.io/izzoa/polyrouter:latest-semantic
```

The baseline image is unchanged — it carries no ONNX runtime and no model files, and CI gates that on every build. The model's weights are the glibc build's only reason for a Debian base (the runtime's prebuilt binaries do not run on Alpine/musl).

### Bring-your-own-model

Mount a bundle over the baked one and repoint the env — the same fail-fast boot contract applies:

```sh
# in .env
SEMANTIC_MODEL_DIR=/abs/path/to/your/bundle   # holds model.onnx + vocab + manifest.json
SEMANTIC_MODEL_PATH=/app/models/custom
# then uncomment the `volumes:` mount in docker-compose.semantic.yml
```

### Bundle contract (v1)

```
models/minilm/
  manifest.json    # the v1 bundle contract (see below)
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

The manifest is a strict Zod schema with cross-field refinement (`vocabFile != model.file`; distinct input tensor names). Bundle loader is `packages/control-plane/src/semantic/bundle.ts`; tests in `bundle.spec.ts`.

### Boot semantics

| Bundle state | Behavior |
|--------------|----------|
| `SEMANTIC_MODEL_PATH` unset | Module absent entirely (no import, no capability). Zero overhead. |
| Valid bundle | Load + warmup at startup. Requests never pay first-inference JIT. |
| Broken bundle (manifest invalid, missing file, dims mismatch, non-cancelling anchors) | **Boot fails fast** naming the file and reason. An explicit opt-in never runs silently degraded. |
| Bundle present but no `semantic` token in `ROUTING_AUTO_LAYERS` | Embedder stays loaded (warm); capability honest-false (`semanticAvailable === false`). |

Nothing is fetched over the network at boot or runtime; embedded text and vectors are never logged or persisted. See [Semantic Stack](/openwiki/architecture/semantic-stack.md) for the full reference.

## Environment Variables

### Required Secrets

| Variable | Purpose |
|----------|---------|
| `BETTER_AUTH_SECRET` | Session signing key (auto-generated by installer) |
| `API_KEY_HMAC_SECRET` | Agent key HMAC key + per-tenant learning HMAC (auto-generated by installer) |
| `PROVIDER_CREDENTIAL_KEY` | AES-256-GCM key for provider credentials (plain API keys + OAuth envelopes) |
| `NOTIFY_CREDENTIALS_SECRET` | AES-256-GCM key for notification channel config |
| `POSTGRES_PASSWORD` | Database password (auto-generated by installer) |

### Database / Cache

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | `postgresql://polyrouter:${POSTGRES_PASSWORD}@postgres:5432/polyrouter` | PostgreSQL connection string |
| `REDIS_URL` | `redis://redis:6379` | Redis connection string |

### Application

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3001` | HTTP server port |
| `NODE_ENV` | `production` | Runtime environment |
| `LOG_LEVEL` | `info` | Logging verbosity |
| `CORS_ORIGIN` | (none) | Allowed CORS origins |
| `MODE` | `selfhosted` | `selfhosted` (default) or `cloud` — gates local-model / loopback / body-capture / localhost-login / SSRF-loopback-exception |
| `BIND_ADDRESS` | `127.0.0.1` | HTTP bind (set to `0.0.0.0` inside the container so published ports work; the host-side exposure is controlled by `ports`) |

### Observability

| Variable | Default | Purpose |
|----------|---------|---------|
| `OTEL_ENABLED` | `false` | OpenTelemetry tracing toggle |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | SDK default | OTLP/HTTP collector endpoint (batched) |
| `METRICS_ENABLED` | `true` | Prometheus `/metrics` toggle |

### Routing

| Variable | Default | Purpose |
|----------|---------|---------|
| `ROUTING_AUTO_LAYERS` | `structural` | Comma-separated layer tokens (`structural`, `cascade`, `semantic`). `cascade` and `semantic` imply `structural`. Unknown tokens reject boot. |
| `ROUTING_STRUCTURAL_HIGH_THRESHOLD` | `0.6` | Layer-1 high band threshold |
| `ROUTING_STRUCTURAL_LOW_THRESHOLD` | `0.25` | Layer-1 low band threshold |
| `ROUTING_STRUCTURAL_BASELINE_ALPHA` | `0.2` | Per-agent baseline EMA |
| `ROUTING_STRUCTURAL_WEIGHTS` | built-ins | JSON override for the Layer-1 classifier weights + `reasoning` adjustment |
| `ROUTING_CASCADE_QUALITY_THRESHOLD` | `0.5` | Cascade escalation threshold |
| `ROUTING_CASCADE_CHEAP_TIMEOUT_MS` | `30000` | Cascade cheap-tier timeout |
| `PROXY_FIRST_EVENT_TIMEOUT_MS` | `30000` | Global TTFT — raise for slow local models |
| `PROXY_IDLE_TIMEOUT_MS` | `30000` | Global idle — raise alongside TTFT |
| `PROXY_MAX_BODY_BYTES` | env-set | Maximum request body size |

### Per-Provider Timeouts (DB-backed)

Set on `provider.first_byte_timeout_ms` / `provider.idle_timeout_ms` (NULL = inherit env). Range `[1000, 3600000]` (1 s–1 h), enforced by both DB CHECK and Zod. Use for research-class models whose prefill exceeds the global defaults; the breaker uses the same per-call deadline, so a genuinely hung connect still trips cleanly.

### Calibration

| Variable | Default | Purpose |
|----------|---------|---------|
| `CALIBRATION_SCHED_ENABLED` | `true` | Enable the per-tenant calibration worker |
| `CALIBRATION_SCHED_CRON` | `0 4 * * *` | Sweep cron |
| `CALIBRATION_WINDOW_DAYS` | `14` | Evidence window |
| `CALIBRATION_MIN_EDGE_SAMPLES` | `50` | Minimum fresh edge-zone samples (hard floor 50) |
| `CALIBRATION_STEP` | `0.02` | Bounded per-run step |
| `CALIBRATION_MAX_DRIFT` | `0.1` | Max total drift from instance thresholds |

### Budgets

| Variable | Default | Purpose |
|----------|---------|---------|
| `BUDGET_FAIL_OPEN` | `true` | On a Redis/enforcement fault, block budgets admit the request. Set `false` for a hard cap returning `503`. |
| `BUDGET_SCHED_ENABLED` / `BUDGET_SCHED_CRON` | `true` / env | Budget reconciler |
| `BUDGET_REDIS_TIMEOUT_MS` / `BUDGET_RECONCILE_TIMEOUT_MS` / `BUDGET_CACHE_TTL_MS` / `BUDGET_CACHE_MAX` | env | Budget latency/cache knobs |

### Pricing Catalog

| Variable | Default | Purpose |
|----------|---------|---------|
| `PRICING_REFRESH_URL` | LiteLLM catalog | Source for pricing refreshes |
| `PRICING_REFRESH_SCHED_ENABLED` | `true` | Daily auto-refresh |
| `PRICING_REFRESH_SCHED_CRON` | `30 4 * * *` | Sweep cron |
| `PRICING_FETCH_TIMEOUT_MS` / `PRICING_MAX_BYTES` | env | Refresh transport caps |

### Notifications

| Variable | Default | Purpose |
|----------|---------|---------|
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` / `SMTP_SECURE` | unset | Server SMTP. Active only when both `SMTP_HOST` and `SMTP_FROM` are set. |
| `APPRISE_API_URL` + `NOTIFY_ALLOWED_ENDPOINTS` | unset | Optional Apprise fan-out — the SSRF guard requires the port-bounded allowlist entry for a private-range host |
| `NOTIFY_APPRISE_EGRESS_CONFIRMED` | `false` | Cloud-mode acknowledgement before Apprise delivery runs |
| `NOTIFY_WEEKLY_ENABLED` / `NOTIFY_WEEKLY_CRON` / `NOTIFY_FAILURE_THRESHOLD` / `NOTIFY_FAILURE_WINDOW_MS` | env | Weekly summary + failure-spike producer knobs |
| `TRUSTED_PROXY_CIDRS` | unset | CIDRs of reverse proxies allowed to set `X-Forwarded-For` |

### Layer 2 (Semantic) — Optional

| Variable | Default | Purpose |
|----------|---------|---------|
| `SEMANTIC_MODEL_PATH` | unset | Path to a local model bundle. **Unset = module absent.** Set + valid = L2 capability. Set + broken = boot fails. |
| `SEMANTIC_TIMEOUT_MS` | `50` | Per-embed hard timeout (ms). Out-of-range rejects boot. |
| `SEMANTIC_MAX_INPUT_CHARS` | `2000` | Input cap before tokenization (chars). |
| `SEMANTIC_CONCURRENCY` | `2` | Concurrent-inference cap. Saturation skips the layer for that request. |
| `SEMANTIC_HIGH_THRESHOLD` | `0.15` | L2 high-band threshold (score ≥ high → high) |
| `SEMANTIC_LOW_THRESHOLD` | `0.15` | L2 low-band threshold (score ≤ −low → low) |

### Layer 2 Learning (Optional)

| Variable | Default | Purpose |
|----------|---------|---------|
| `SEMANTIC_LEARNING_ALPHA` | `0.2` | EMA fold coefficient (`active' = (1-α)·active + α·pending`). Bounded (0, 0.5]. |
| `SEMANTIC_LEARNING_MAX_DRIFT` | `0.35` | Max cosine-distance clamp from bundled centroid (spherical SLERP). |
| `SEMANTIC_LEARNING_MIN_SAMPLES` | `50` | Per-label floor for sweep rotation. Must be ≥ `MIN_COHORT`. |
| `SEMANTIC_LEARNING_MIN_COHORT` | `8` | Minimum accumulated embeddings before a cohort may flush to Redis. |
| `SEMANTIC_LEARNING_MAX_COHORTS` | `4096` | Bounded per-process cohort map. |
| `SEMANTIC_LEARNING_COOLDOWN_H` | `24` | Cooldown between applies (must be < `STATE_TTL_D` × 24). |
| `SEMANTIC_LEARNING_STATE_TTL_D` | `30` | Learned active-state TTL in days. |
| `SEMANTIC_LEARNING_SCHED_ENABLED` | `true` | Enable the per-tenant learning sweep worker |
| `SEMANTIC_LEARNING_SCHED_CRON` | `0 3 * * *` | Sweep cron |

All config values are validated by Zod at startup. Missing or invalid values cause a **fail-fast boot error** with a descriptive message naming the env var and the constraint.

## Configuration Validation

Every config value is validated by Zod schemas defined in each module:

```typescript
// Example from routing.config.ts
const ROUTING_CONFIG = registerConfig('routing', z.object({
  ROUTING_AUTO_LAYERS: z.string().default('structural'),
  ROUTING_STRUCTURAL_HIGH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  ROUTING_STRUCTURAL_LOW_THRESHOLD: z.coerce.number().min(0).max(1).default(0.25),
  ...
}));
```

Cross-field validation runs in the loader:

- `LOW < HIGH` for structural thresholds (otherwise bands collapse)
- Both structural thresholds ≤ 4 decimal places (calibration rails)
- `AUTO_LAYERS` tokens validated against `{ structural, cascade, semantic }`; unknown tokens reject boot naming the offender
- `cascade` and `semantic` imply `structural`
- Semantic thresholds ≤ 4 decimal places
- `MIN_SAMPLES >= MIN_COHORT`, `COOLDOWN < STATE_TTL × 24` — out-of-range rejects boot

## Operational Runbook

### Checking Health

```bash
# App health
curl http://localhost:3001/api/health

# Database connectivity
docker compose exec postgres pg_isready

# Redis connectivity
docker compose exec redis redis-cli ping
```

### Viewing Logs

```bash
# All services
docker compose logs -f

# App only
docker compose logs -f app

# Last 100 lines
docker compose logs --tail 100 app

# Filter by logger (e.g. SemanticRuntime, SemanticLearning)
docker compose logs -f app 2>&1 | grep -E 'SemanticRuntime|SemanticLearning'
```

### Database Operations

```bash
# Connect to database
docker compose exec postgres psql -U polyrouter -d polyrouter

# Run migrations (inside container)
docker compose exec app npx drizzle-kit push

# Inspect the L2 audit history
docker compose exec postgres psql -U polyrouter -d polyrouter -c \
  "SELECT trigger, epoch, generation, high_samples, low_samples, reason, created_at
     FROM semantic_learning_event ORDER BY created_at DESC LIMIT 20;"

# Check semantic telemetry coverage
docker compose exec postgres psql -U polyrouter -d polyrouter -c \
  "SELECT decision_layer, semantic_band, COUNT(*)
     FROM request_log
     WHERE semantic_band IS NOT NULL
     GROUP BY 1, 2 ORDER BY 1, 2;"
```

### Backup

```bash
# PostgreSQL dump
docker compose exec postgres pg_dump -U polyrouter polyrouter > backup.sql

# Restore
docker compose exec -T postgres psql -U polyrouter polyrouter < backup.sql
```

### Updating

```bash
# Pull latest image
docker compose pull

# Restart with new image
docker compose up -d

# Or re-run the installer (preserves .env)
curl -fsSL https://raw.githubusercontent.com/izzoa/polyrouter/main/install.sh | sh
```

### Switching to the `-semantic` image variant

```bash
# Pull the variant
docker compose pull

# Run with the layered compose (overrides `build`/`image` to the -semantic target)
docker compose -f docker-compose.yml -f docker-compose.semantic.yml up -d

# Verify the runtime is loaded
docker compose logs app | grep -E 'SemanticRuntime|semantic classifier ready'
# expect: "semantic classifier ready: anchors=bundled-v1 high=30 low=30 revision=sha256:…"
```

### One-click Revert (Learning)

```bash
# Reverts the current tenant's learned centroids; idempotent.
curl -sX POST -b cookies.txt http://localhost:3001/api/routing/semantic-learning/revert | jq .

# Inspect the audit history
curl -s -b cookies.txt http://localhost:3001/api/routing/semantic-learning/status | jq .
```

See [Semantic Stack](/openwiki/architecture/semantic-stack.md#learning-loop) for the full revert protocol.

### Scaling Considerations

The current architecture is designed for **single-replica self-hosted deployment**. Key constraints:

- Circuit breaker state is in Redis (shared across replicas)
- Budget counters use Redis (shared across replicas)
- Notification queue uses BullMQ (supports multiple workers)
- Request recording uses a background writer (single-replica in current design)
- **Boot migrations take no advisory lock — do not `--scale app`.**
- The semantic learning sweep is per-tenant and idempotent (CAS + audit + promote); multiple workers are safe. The producer queue is always created so a disabled node can still remove a stale schedule.

Multi-replica deployment is possible but requires attention to the recording writer and rate limiter coordination.

## Development Setup

For local development:

```bash
# Install dependencies
npm install

# Start infrastructure (Postgres + Redis; the dev compose file lives at docker-compose.dev.yml)
docker compose -f docker-compose.dev.yml up -d

# Start all packages in dev mode
npm run dev
```

This starts:
- Frontend (Vite) on `:3000`
- Control Plane (NestJS) on `:3001`
- Data Plane builds alongside control plane

See [`CONTRIBUTING.md`](/CONTRIBUTING.md) for the full development workflow.