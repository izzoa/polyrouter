---
"@polyrouter/control-plane": minor
"@polyrouter/frontend": minor
"@polyrouter/shared": minor
"@polyrouter/data-plane": minor
---

feat(providers): real subscription OAuth — connect wizard, token lifecycle, Claude preset

The `subscription` provider kind is now a real capability instead of a label:

- **Connect wizard** (Manifest-style paste-back): pick a preset, sign in at the provider's
  authorize link, paste the redirect URL or `code#state` string back — polyrouter verifies
  `state` (required on every paste form), exchanges the code (PKCE S256) at the preset's fixed
  token endpoint, and creates the provider with a pinned base URL/protocol. Sessions are
  server-held (Redis, ~10 min TTL), single-use (atomically consumed before the exchange),
  bound to your login session, and rate-limited per user and per IP.
- **Token lifecycle**: access + refresh tokens live in a typed encrypted envelope (plain pasted
  credentials are now wrapped in the same envelope — legacy stored credentials keep working).
  Tokens auto-refresh before expiry with cross-instance single-flight (advisory lock + in-lock
  re-read; refresh-token rotation can't be clobbered), transient IdP outages back off and keep
  serving the still-valid token, and a revoked grant becomes a durable **"reauthorize
  required"** state with a one-click reconnect on the provider card. Credential failures are
  breaker-neutral; only a successful reauthorization resets the provider's breaker.
- **Anthropic OAuth wire support**: subscription providers with OAuth credentials authenticate
  with `Authorization: Bearer` + the required `anthropic-beta` value (not `x-api-key`).
- **Claude Pro/Max preset** ships **disabled** pending live verification against a real
  account (`scripts/verify-claude-oauth.md`): the preset's endpoints are ecosystem-known, not
  a documented contract — polyrouter never ships an enabled-but-unverified preset, sends only
  the documented headers, and never imitates the first-party client beyond them. The ToS
  caution for flat-rate subscription reuse still applies and is shown in the UI.

Migration 0010 adds non-secret provider columns (`oauth_preset`, `credential_expires_at`,
`credential_error`). Rotating `PROVIDER_CREDENTIAL_KEY` invalidates stored envelopes; OAuth
providers then require reauthorization.
