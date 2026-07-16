---
'@polyrouter/shared': minor
'@polyrouter/control-plane': minor
---

Wire the dashboard's management core to real APIs (#18, spec §2/§6.2/§9/§7.7/§11). The SolidJS SPA (built earlier against an in-memory simulator) now runs its **auth + Agents + Providers + onboarding + account** slice against the real, session-guarded `/api` backend; the observe (Overview/Requests/Costs) and config (Routing/Limits/Notifications) pages stay on the simulator behind a "preview — simulated" marker until #19/#20.

Backend gaps filled (owner-scoped, no new deps, no migration):

- **`GET /api/me`** (session-guarded) — the SPA's single authorization probe, resolving the principal under BOTH a session cookie and cookieless localhost auto-login (so it works on a self-host loopback instance where Better Auth `get-session` is null). Adds `IdentityPort.getIdentity`.
- **`GET /api/login-config`** (`@Public()`) — the login gate's bootstrap (`{ mode, emailPassword, oauthProviders }`), listing only OAuth providers whose id+secret are both configured. Named outside the `/api/auth*` prefix that the raw Better Auth middleware intercepts before Nest (an `/api/auth-config` route would be swallowed) — regression-guarded by an e2e that boots the real `mountAuth` ordering.
- **`PATCH /api/models/:id`** — user-entered prices for **custom/local** models (§7.7), routed through the owner-scoped model accessor (invariant 5). Rejects known-provider (`api_key`/`subscription`) models (the bundled catalog is authoritative for those), validates the request shape atomically (a price pair, or `{ isFree: true }`; a lone/half-set price is 422), and never rewrites historical cost — RequestLog snapshots are immutable (invariant 4). `SafeModel` (`GET /api/models`) now carries the model-own prices.

Frontend (private package): an injectable `ApiClient` (bare `fetch`, `credentials:'include'`, relative paths) + a Solid `AppProvider` context seam so tests inject a `FakeApiClient`; an auth gate (`GET /api/me` → dashboard, else email/password + OAuth login) with a retryable error state and auto-login-aware logout; real Agents CRUD (server key+snippet shown once, held transiently, never persisted); real Providers CRUD with create-then-test/sync and a custom/local price editor + subscription ToS nudge; and a failure-aware 3-step onboarding that ends in a real proxied `auto` completion. The two auth planes stay separate — the dashboard is cookie/session on `/api`, the proxy stays agent-key on `/v1`.
