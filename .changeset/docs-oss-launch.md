---
'@polyrouter/shared': patch
'@polyrouter/control-plane': patch
'@polyrouter/data-plane': patch
'@polyrouter/frontend': patch
---

OSS launch readiness: LICENSE, connect-an-agent docs, an accurate config reference, and a complete compose pass-through (FABLE_AUDIT E8).

- **LICENSE** — added a real MIT `LICENSE` file (the repo declared `"license": "MIT"` but shipped no grant); aligned the four workspace `package.json` license fields.
- **Connect an agent** — new README section showing the OpenAI/Anthropic base-URL convention, the `poly_…` dashboard key, and model selection (explicit / `auto` / tier via `x-polyrouter-tier`), with a curl example per protocol.
- **the spec §12** — regenerated from the config registry: every registered env var grouped by namespace with its default, the four required-in-production hex secrets and the localhost-default `DATABASE_URL`/`REDIS_URL` marked, the loopback dev-secret fallbacks noted, the stale cloud-only vars dropped, and the wrong `ROUTING_AUTO_LAYERS` default corrected.
- **README `.env` reference** — documented the sharp-edged operator tunables: `SMTP_*` (password reset is a no-op unless both `SMTP_HOST` and `SMTP_FROM` are set), `BUDGET_FAIL_OPEN` (defaults to admit-on-fault — flip for a hard cap), `ROUTING_AUTO_LAYERS` (cost-saving cascade is off until it lists `cascade`), and others.
- **docker-compose.yml** — the `app` env pass-through allowlist now covers the previously-missing registered vars (`NOTIFY_WEEKLY_*`, `NOTIFY_FAILURE_*`, all `BUDGET_*`, `PRICING_*`, the `PROXY_*` timeout knobs, `DASHBOARD_ORIGIN`, `SEED_DATA`), so setting them in `.env` actually reaches the container.

Docs and config only — no runtime code change, no migration.
