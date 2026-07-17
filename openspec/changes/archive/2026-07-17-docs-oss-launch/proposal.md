## Why

The repo is a self-described open-source router that is not actually launchable (FABLE_AUDIT E8): it
declares `"license": "MIT"` but ships **no LICENSE grant** (a legal blocker for any adopter/fork), it
documents install + development but **never shows how to connect an agent** (the product's core pitch,
spec §15's first criterion), its reference `spec.md` §12 config section lists ~15 of the 50+ registered
env vars (missing the required-in-prod `PROVIDER_CREDENTIAL_KEY`, `BUDGET_FAIL_OPEN`, etc. — the
reference "loses" to the code it's supposed to define), several sharp-edged operator tunables are
documented only in source comments, and the compose env allowlist silently drops registered vars so
setting them in `.env` does nothing.

## What Changes

- **E8.1** Add a real `/LICENSE` (MIT, correct holder + year) and `"license": "MIT"` to the four
  workspace `package.json` files.
- **E8.2** Add a README "Connect an agent" section: `base_url = <instance>/v1`, a `poly_…` dashboard
  key, `model` = explicit | `auto` | tier via `x-polyrouter-tier`, one curl per protocol.
- **E8.3** Regenerate `spec.md` §12 from the config registry — grouped by namespace, every registered
  var with its default, required-in-production secrets marked, dev fallbacks noted; drop the stale
  cloud-only vars and fix the wrong `ROUTING_AUTO_LAYERS` default.
- **E8.4** Extend the README `.env` reference with the sharp-edged tunables (`SMTP_*` — absence
  silently disables password reset; `BUDGET_FAIL_OPEN` — default admits on fault; `ROUTING_AUTO_LAYERS`
  — cascade off until set; `TRUSTED_PROXY_CIDRS`, `PRICING_REFRESH_URL`,
  `NOTIFY_APPRISE_EGRESS_CONFIRMED`, the proxy timeout knobs, `POLYROUTER_SUBNET`/`IMAGE`).
- **E8.5** Append the missing registered vars to the compose `app.environment` pass-through allowlist
  so `.env` actually reaches the container.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `packaging`: the repo SHALL include a LICENSE and the README SHALL document connecting an agent and
  the sharp-edged operator tunables; the product compose SHALL pass through every registered optional
  env var.

## Impact

- **Docs/config only:** `LICENSE` (new), `README.md`, `spec.md` §12, `docker-compose.yml`,
  four `packages/*/package.json`. No source/runtime code change, no migration.
- **Verification:** grep assertions per task (LICENSE header, `x-polyrouter-tier`/`/v1/chat/completions`
  in README, `PROVIDER_CREDENTIAL_KEY`/`BUDGET_FAIL_OPEN` in spec.md, `SMTP_HOST`/`BUDGET_FAIL_OPEN` in
  README), and `docker compose config` rendering a newly-passed var. Changeset added (user-facing docs).
- Backlog A-20..A-24 (SECURITY.md/CONTRIBUTING.md, repo metadata, expose/upgrade command forms,
  archived-spec drift) are out of scope for this change.
