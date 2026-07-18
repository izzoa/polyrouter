# @polyrouter/shared

## 0.2.0

### Minor Changes

- 14fe461: Add **Hermes Agent** (Nous Research) as a supported harness, alongside OpenClaw. It now appears in the dashboard's **Agents → New** harness picker and gets a correct copy-paste connection snippet on create/rotate — a `~/.hermes/config.yaml` `model:` block (`provider: custom`, the router's OpenAI-compatible `/v1` base URL, the minted `poly_…` key, `default: auto` so polyrouter routes). The snippet's `base_url`/`api_key` are emitted as escaped scalars so an unusual endpoint URL can't corrupt the YAML. The harness field is presentational metadata only (label + snippet) — no routing/cost/proxy behavior changes and no migration (`harness_type` is a free-form text column). A new golden-snippet test in `@polyrouter/shared` pins every harness's output. The README "Connect an agent" section gains a terminal-coding-agents subsection documenting both OpenClaw and Hermes, including Hermes' `~/.hermes/.env` env-substitution alternative for keeping the key out of the YAML.
- ed0d35c: Add **user administration**: first-signup-wins bootstrap, invite-only registration, and admin user management.

  The first account to sign up on a fresh instance wins an atomic bootstrap claim, becomes the admin, and registration **closes to `invite_only`** — subsequent public sign-ups are refused (403) until an admin reopens them. Admins get a new **Users** page (sidebar, admin-only): list users, promote/demote admins, disable/enable, delete, issue and revoke invites, and switch the registration mode between `invite_only` and `open`. A **last-enabled-admin guard** (advisory-locked) refuses any delete/demote/disable that would leave the instance without an enabled admin (409).

  **Invites** are single-use, expire after 72 hours, and are pinned to the invited email. Only a SHA-256 hash + 12-char prefix is stored — the raw token rides once in the returned link's **URL fragment** (`/accept-invite#token=…`, never in the query string, so it can't leak into access logs or Referer headers). If server SMTP (`SMTP_*` env) is configured the invite is emailed automatically; otherwise the dashboard shows the copyable link — issuing always works without SMTP. The public `/accept-invite` page collects name + password and lands the new user signed in; `/api/invites/accept` is rate-limited per-IP and answers every bad/expired/replayed token with the same uniform error.

  **Disabling a user cuts both credential planes at once**: their dashboard sessions are revoked in the same transaction (and again on re-enable, so no raced session can resurface), new sign-ins are refused, and every agent API key they own stops authenticating on `/v1` immediately.

  The signed-in identity now lives in a **account menu** at the bottom of the sidebar (avatar + email): Settings, theme toggle, Users (admins), and Log out — replacing the standalone theme button and the Settings-page Log out.

  **Upgrade note (deliberate behavior change):** migration 0008 seeds existing instances to `invite_only` — on upgrade, public sign-up closes until an admin reopens it under **Users → Registration**. Existing accounts are untouched. Break-glass (locked out with no enabled admin): re-enable directly in Postgres — `UPDATE "user" SET disabled = false WHERE email = '<you>';` (and `role = 'admin'` if needed) — then sign in again.
