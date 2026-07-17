# dashboard-core Specification

## Purpose
TBD - created by archiving change add-dashboard-core. Update Purpose after archive.
## Requirements
### Requirement: The dashboard authorizes via a current-user probe and gates on it

The SPA SHALL determine authorization on load by calling a session-guarded **`GET /api/me`** (not Better Auth `get-session`, which is null under localhost auto-login): a `200` with the principal renders the dashboard; a `401` renders a login/sign-up gate. `GET /api/me` SHALL return the current principal's `{ userId, email, name, role, mode }` and MUST be owner-scoped to the caller (a user never sees another user's identity). Because the global `SessionGuard`'s localhost auto-login authorizes `/api/*` **without issuing a session cookie**, `GET /api/me` SHALL succeed for the auto-logged-in admin on a self-host loopback instance. A **mid-session** `401` (any loader or mutation returning `401` after the SPA has reached the ready state) SHALL re-run the authorization probe (re-gating to login and reloading `login-config`) rather than surfacing an unexplained per-action error, so an expired session is never left stranding the dashboard shell where every action fails and the background poll paints a permanent, unretryable error.

#### Scenario: Self-host loopback lands straight in the dashboard

- WHEN a `MODE=selfhosted` loopback instance serves the SPA and an admin user exists, with no session cookie present
- THEN `GET /api/me` returns 200 with the admin's identity (via auto-login) and the SPA renders the dashboard without a login screen

#### Scenario: An unauthenticated non-loopback request is gated to login

- WHEN `GET /api/me` is called with no valid session and the request is not auto-login-eligible (cloud, or non-loopback)
- THEN it returns 401 and the SPA renders the login/sign-up gate instead of the dashboard

#### Scenario: A mid-session 401 re-gates to login

- WHEN the SPA is in the ready (authorized) state and a subsequent loader or mutation returns `401` (the session expired)
- THEN the SPA re-probes `/api/me` and transitions to the login gate (with the current `login-config`), rather than leaving the user in a shell where every action fails with an unexplained error

### Requirement: The login gate reflects the instance's configured auth methods

A `@Public()` **`GET /api/login-config`** (named outside the `/api/auth*` prefix, which the raw Better Auth middleware intercepts before Nest) SHALL return `{ mode, emailPassword, oauthProviders }` where `oauthProviders` lists only the OAuth providers whose client id AND secret are both configured. The login gate SHALL render email/password sign-in + sign-up (via `/api/auth/*`; sign-up collects `name` + email + password) and exactly one button per listed OAuth provider (which navigates to the `url` returned by `/api/auth/sign-in/social`). The response MUST NOT contain any secret.

#### Scenario: Only configured OAuth providers are offered

- WHEN GitHub's client id+secret are set but Google's and Discord's are not
- THEN `GET /api/login-config` lists `["github"]` and the login gate shows a GitHub button and no Google/Discord button, and the response carries no client secret

#### Scenario: After signing in, the dashboard loads

- WHEN a user submits valid email/password to the gate (or completes an OAuth round-trip) and a session is established
- THEN re-running the bootstrap `GET /api/me` returns 200 and the SPA transitions from the gate to the dashboard

### Requirement: Agents are managed from the dashboard with the key shown once

The Agents page SHALL list/create/rotate/delete agents against the owner-scoped `/api/agents`. The raw agent key and its connection snippet SHALL be shown **exactly once** — from the create/rotate response — held only in transient memory, **never persisted** (no `localStorage`), and cleared on dismissal/sign-out; it is not re-fetchable or displayable again (only the key prefix is listed afterward, and re-obtaining a key is a rotate). A **copy-to-clipboard** action for the shown-once key (or any copied value) SHALL confirm success only when the clipboard write actually succeeded: when the clipboard API is unavailable (e.g. a non-secure origin) or the write rejects, the UI SHALL surface a distinct failure message prompting manual selection, and SHALL NOT display a success ("Copied"/"Key copied") toast — so a user does not dismiss the one-time key reveal believing a copy that never happened.

#### Scenario: Creating an agent reveals the key once

- WHEN a user creates an agent
- THEN the create response's `key` + `snippet` are shown in a reveal modal, and after dismissal the agent lists with only its prefix (the key is not retrievable again)

#### Scenario: Agent management is tenant-isolated

- WHEN the page lists or mutates agents
- THEN only the current principal's agents are returned/affected (a by-id action on another user's agent is a 404)

#### Scenario: A failed clipboard copy does not claim success

- WHEN the copy action runs but `navigator.clipboard` is unavailable or `writeText` rejects
- THEN the toast is a distinct failure ("Copy failed — select the text manually"), not "Copied"/"Key copied", so the user knows the shown-once key was not captured before dismissing the reveal

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

The 3-step onboarding SHALL persist real state: create an agent (minting a key), add a provider and sync its models, assign the first synced model to the `default` tier (`PUT /api/routing/tiers/:defaultId/entries`, position 0 = primary), and finally issue a real proxied request (`model:"auto"`) with the minted agent key and display the upstream response. Because the setup guide is always available (not only on a fresh instance), the model-assignment step SHALL be **non-destructive**: it SHALL read the default tier's current entries and full-replace **only when the tier is empty**; when the tier already has entries it SHALL append the new model within the position cap (preserving the existing primary and fallbacks) and no-op when the model is already routed, so re-walking the guide never silently wipes an existing routing chain.

#### Scenario: A new user reaches a working proxied call

- WHEN a new user completes the three steps on a fresh instance (empty default tier)
- THEN an agent is created, a provider is synced, the first model is assigned to the empty `default` tier as position 0, and a real `model:"auto"` request returns an upstream completion shown in the UI

#### Scenario: Re-walking the guide does not wipe an existing default-tier chain

- WHEN the `default` tier already holds a multi-model chain and the user walks the setup guide to add another provider/model
- THEN the guide appends the new model within the position cap (the existing primary and fallbacks are preserved), rather than replacing the whole chain with a single-element list; a model already in the chain is left unchanged

### Requirement: The displayed connection endpoint is derived from the serving origin

The endpoint the dashboard **displays and copies** (the topbar endpoint chip, the Settings "Endpoint"
field, the Agents connection instructions, the sidebar footer host, and the client-side `snippetFor`
fallback) SHALL be derived from the SPA's runtime origin (`${location.origin}/v1`), not a build-time
constant. Because the app is served same-origin in production, this makes the shown endpoint correct for
any host the instance runs behind and consistent with the server-minted key-reveal snippet (which
derives from the real origin). The value is display-only and never fetched (the ApiClient uses
origin-relative bases).

#### Scenario: The endpoint matches the origin the instance is served from

- WHEN the dashboard is served from a non-default origin (e.g. behind a configured host)
- THEN the displayed/copied endpoint is `${that origin}/v1` and agrees with the key-reveal snippet, rather than a hardcoded `127.0.0.1` dev URL

### Requirement: Create/add mutations are single-flight and onboarding never duplicates

Every dashboard mutation that CREATES a resource (create agent, add provider, create tier,
create rule, and the onboarding connect-provider step) SHALL be **single-flight**: a second
invocation while one is in flight SHALL be ignored (guarded on the form's `busy` flag), so a
double-click or an impatient re-submit cannot POST twice and create duplicate resources. The
onboarding flow, which creates a provider and then performs follow-up steps (model sync, tier
assignment), SHALL NOT mint a **second** provider when a later step fails and the user retries:
it SHALL reuse the provider already created for that onboarding attempt and resume the
follow-up steps from there.

#### Scenario: A double-submit creates one resource, not two

- WHEN a create/add mutation is invoked twice in rapid succession (the second before the first
  completes)
- THEN only one create request is sent and one resource is created — the second invocation is a
  no-op while the first is in flight

#### Scenario: Retrying onboarding after a downstream failure reuses the created provider

- WHEN onboarding creates a provider and then a follow-up step (model sync or tier assignment)
  fails, and the user retries the step
- THEN the retry reuses the already-created provider (resuming the follow-up steps) rather than
  creating a second provider for the same onboarding attempt

### Requirement: Dashboard controls reflect real state, never inert or fabricated display

Dashboard controls and displayed facts SHALL correspond to real, honest state. A control SHALL
NOT present an affordance for a capability that does not exist or that it does not actually
effect: because the system stores **metadata only** and has no prompt/response-body persistence
mechanism (invariant 8), the settings surface SHALL NOT offer an interactive "log bodies" toggle
that changes nothing — it SHALL instead state, read-only, that bodies are never stored. Displayed
version/build information SHALL be the instance's **real** value (injected at build), not a
hard-coded placeholder, and the dashboard SHALL NOT display backend component versions (e.g.
database/cache versions) it cannot actually observe.

#### Scenario: No inert body-logging toggle

- WHEN a user views the settings surface
- THEN there is no interactive toggle implying prompt/response bodies can be logged; the surface
  states read-only that the system is metadata-only (bodies are never stored)

#### Scenario: The version shown is real, not fabricated

- WHEN the settings surface displays the instance version
- THEN it shows the real build version (injected from the package version) and does not display a
  hard-coded version string or backend component versions the browser cannot know

