# Spec delta: dashboard-core

## ADDED Requirements

### Requirement: The dashboard authorizes via a current-user probe and gates on it

The SPA SHALL determine authorization on load by calling a session-guarded **`GET /api/me`** (not Better Auth `get-session`, which is null under localhost auto-login): a `200` with the principal renders the dashboard; a `401` renders a login/sign-up gate. `GET /api/me` SHALL return the current principal's `{ userId, email, name, role, mode }` and MUST be owner-scoped to the caller (a user never sees another user's identity). Because the global `SessionGuard`'s localhost auto-login authorizes `/api/*` **without issuing a session cookie**, `GET /api/me` SHALL succeed for the auto-logged-in admin on a self-host loopback instance.

#### Scenario: Self-host loopback lands straight in the dashboard

- WHEN a `MODE=selfhosted` loopback instance serves the SPA and an admin user exists, with no session cookie present
- THEN `GET /api/me` returns 200 with the admin's identity (via auto-login) and the SPA renders the dashboard without a login screen

#### Scenario: An unauthenticated non-loopback request is gated to login

- WHEN `GET /api/me` is called with no valid session and the request is not auto-login-eligible (cloud, or non-loopback)
- THEN it returns 401 and the SPA renders the login/sign-up gate instead of the dashboard

### Requirement: The login gate reflects the instance's configured auth methods

A `@Public()` **`GET /api/login-config`** (named outside the `/api/auth*` prefix, which the raw Better Auth middleware intercepts before Nest) SHALL return `{ mode, emailPassword, oauthProviders }` where `oauthProviders` lists only the OAuth providers whose client id AND secret are both configured. The login gate SHALL render email/password sign-in + sign-up (via `/api/auth/*`; sign-up collects `name` + email + password) and exactly one button per listed OAuth provider (which navigates to the `url` returned by `/api/auth/sign-in/social`). The response MUST NOT contain any secret.

#### Scenario: Only configured OAuth providers are offered

- WHEN GitHub's client id+secret are set but Google's and Discord's are not
- THEN `GET /api/login-config` lists `["github"]` and the login gate shows a GitHub button and no Google/Discord button, and the response carries no client secret

#### Scenario: After signing in, the dashboard loads

- WHEN a user submits valid email/password to the gate (or completes an OAuth round-trip) and a session is established
- THEN re-running the bootstrap `GET /api/me` returns 200 and the SPA transitions from the gate to the dashboard

### Requirement: Agents are managed from the dashboard with the key shown once

The Agents page SHALL list/create/rotate/delete agents against the owner-scoped `/api/agents`. The raw agent key and its connection snippet SHALL be shown **exactly once** — from the create/rotate response — held only in transient memory, **never persisted** (no `localStorage`), and cleared on dismissal/sign-out; it is not re-fetchable or displayable again (only the key prefix is listed afterward, and re-obtaining a key is a rotate).

#### Scenario: Creating an agent reveals the key once

- WHEN a user creates an agent
- THEN the create response's `key` + `snippet` are shown in a reveal modal, and after dismissal the agent lists with only its prefix (the key is not retrievable again)

#### Scenario: Agent management is tenant-isolated

- WHEN the page lists or mutates agents
- THEN only the current principal's agents are returned/affected (a by-id action on another user's agent is a 404)

### Requirement: Providers are managed with create-then-verify and user-entered custom/local pricing

The Providers page SHALL add all four kinds (`api_key`/`subscription`/`custom`/`local`), then **test-connection** and **sync-models** against the created provider (the backend acts on an existing id, so create precedes test/sync). Provider credentials SHALL be write-only — submitted but never displayed or returned (only `hasCredential`). For **custom and local** models the user SHALL be able to set per-token prices via an owner-scoped **`PATCH /api/models/:id`** — accepting a *price pair* (both input and output together) or *free* (normalized to 0/0/free), rejecting a half-set price; this sets the model's current price without rewriting any historical RequestLog cost. The endpoint SHALL reject (422) a model whose provider is a known kind (`api_key`/`subscription`), because model-own price is the highest-precedence source and would otherwise bypass the bundled catalog. A **subscription**-kind provider SHALL surface the flat-plan-reuse ToS risk and nudge adding a pay-per-token fallback.

#### Scenario: A provider is created, then tested and synced

- WHEN a user adds a provider and triggers test-connection and sync-models
- THEN the provider is created first, the two actions run against its id, and their sanitized results update the provider's health status and model list — with the submitted credential never echoed back

#### Scenario: A user sets a custom/local model's price

- WHEN a user enters input+output per-1M prices (or marks free) for a custom or local model
- THEN `PATCH /api/models/:id` (owner-scoped) stores them on that model, subsequent requests price against them, and previously-recorded request costs are unchanged; a half-set price is rejected (422), a known-provider (api_key/subscription) model is rejected (422), and a cross-tenant edit by id is rejected (404)

#### Scenario: A subscription provider surfaces the ToS risk

- WHEN a user selects the `subscription` kind
- THEN the UI shows the flat-rate-reuse risk note and nudges adding a pay-per-token fallback provider

### Requirement: Onboarding runs end to end to a real proxied completion

The 3-step onboarding SHALL persist real state: create an agent (minting a key), add a provider and sync its models, assign the first synced model to the `default` tier (`PUT /api/routing/tiers/:defaultId/entries`, position 0 = primary), and finally issue a real proxied request (`model:"auto"`) with the minted agent key and display the upstream response.

#### Scenario: A new user reaches a working proxied call

- WHEN a new user completes onboarding (create agent → add+sync provider → assign default model → send a test message)
- THEN the first synced model is assigned to the `default` tier and the `auto` test request is proxied to the provider and its completion is shown — the connected agent works immediately
