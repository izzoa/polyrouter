## 1. E8.1 — LICENSE

- [x] 1.1 Add `/LICENSE` (standard MIT text, `Copyright (c) 2026 Anthony Izzo`).
- [x] 1.2 Add `"license": "MIT"` to the four `packages/*/package.json` (root already declares it).

## 2. E8.2 — README "Connect an agent"

- [x] 2.1 Add a section (after Self-hosting) covering `base_url = <instance>/v1`, the `poly_…` dashboard key, `model` = explicit | `auto` | tier via `x-polyrouter-tier`, and a curl per protocol (`/v1/chat/completions`, `/v1/messages`).

## 3. E8.3 — Refresh spec.md §12 from the config registry

- [x] 3.1 Rewrite spec.md §12 grouped by namespace (core/auth/proxy/routing/budgets/pricing/notifications/observability), listing every registered var with its default; mark the four required-in-prod hex secrets and the localhost-default `DATABASE_URL`/`REDIS_URL`; note the loopback-dev fallbacks; drop the cloud-only `EMBEDDING_MODEL_PATH`/`CONTROL_PLANE_URL`; fix `ROUTING_AUTO_LAYERS` (default `structural`, not `explicit,structural`) and call out the sharp edges (`BUDGET_FAIL_OPEN`, SMTP-both-or-nothing, cascade-off default).

## 4. E8.4 — README .env sharp-edge tunables

- [x] 4.1 Extend the README `.env` table with `SMTP_*` (absence silently disables password reset), `BUDGET_FAIL_OPEN` (default admits on fault), `ROUTING_AUTO_LAYERS` (cascade off until set), `TRUSTED_PROXY_CIDRS`, `PRICING_REFRESH_URL`, `NOTIFY_APPRISE_EGRESS_CONFIRMED`, the proxy timeout knobs, `POLYROUTER_SUBNET`/`IMAGE`, plus a pointer to spec.md §12 for the exhaustive list.

## 5. E8.5 — Compose pass-through

- [x] 5.1 Append the registered-but-missing vars to `docker-compose.yml` `app.environment` (`NOTIFY_WEEKLY_*`, `NOTIFY_FAILURE_*`, `BUDGET_SCHED_ENABLED`, `BUDGET_REDIS_TIMEOUT_MS`, `BUDGET_RECONCILE_TIMEOUT_MS`, `BUDGET_CACHE_*`, `BUDGET_STALE_MS`, `PRICING_FETCH_TIMEOUT_MS`, `PRICING_MAX_BYTES`, the `PROXY_*`/`BREAKER_REDIS_TIMEOUT_MS` knobs).

## 6. Verification & wrap-up

- [x] 6.1 Grep checks: `head -1 LICENSE | grep -qi 'MIT License'`; `grep -q 'x-polyrouter-tier' README.md && grep -q '/v1/chat/completions' README.md`; `grep -q PROVIDER_CREDENTIAL_KEY spec.md && grep -q BUDGET_FAIL_OPEN spec.md`; `grep -q SMTP_HOST README.md && grep -q BUDGET_FAIL_OPEN README.md`.
- [x] 6.2 `docker compose -p polyrouter-selfhost config` renders a newly-passed var (e.g. `NOTIFY_WEEKLY_ENABLED`) on the app service (if docker available; else the YAML is valid and the key is present).
- [x] 6.3 `npm run build` still passes (package.json edits are well-formed); changeset added (user-facing docs).
- [x] 6.4 Update `TODOS.md` board + mark E8 tasks ✅ in `FABLE_AUDIT.md` after archive.
