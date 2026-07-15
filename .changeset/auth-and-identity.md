---
'@polyrouter/shared': minor
'@polyrouter/control-plane': minor
---

Add the two credential planes. Session plane: Better Auth (email/password + Google/GitHub/Discord OAuth) mounted at `/api/auth/*` with a `/api`-scoped session guard, server-owned admin role, race-safe first-admin promotion plus boot reconciliation, hardened loopback auto-login (self-host, loopback-bound only), a dev-admin seed, and atomic Redis rate limiting on the auth endpoints. Agent-key plane: `poly_…` keys minted shown-once and stored as HMAC-SHA256 + prefix (never bcrypt), a fast constant-time `/v1` Bearer guard with coalesced last-used stamping, and tenant-scoped `/api/agents` CRUD returning per-harness connection snippets from a shared module. The Better Auth adapter is built inside the database module (no second raw handle); password-reset email delivery is deferred to the notifications change.
