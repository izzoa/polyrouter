## ADDED Requirements

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

## MODIFIED Requirements

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

### Requirement: Onboarding runs end to end to a real proxied completion

The 3-step onboarding SHALL persist real state: create an agent (minting a key), add a provider and sync its models, assign the first synced model to the `default` tier (`PUT /api/routing/tiers/:defaultId/entries`, position 0 = primary), and finally issue a real proxied request (`model:"auto"`) with the minted agent key and display the upstream response. Because the setup guide is always available (not only on a fresh instance), the model-assignment step SHALL be **non-destructive**: it SHALL read the default tier's current entries and full-replace **only when the tier is empty**; when the tier already has entries it SHALL append the new model within the position cap (preserving the existing primary and fallbacks) and no-op when the model is already routed, so re-walking the guide never silently wipes an existing routing chain.

#### Scenario: A new user reaches a working proxied call

- WHEN a new user completes the three steps on a fresh instance (empty default tier)
- THEN an agent is created, a provider is synced, the first model is assigned to the empty `default` tier as position 0, and a real `model:"auto"` request returns an upstream completion shown in the UI

#### Scenario: Re-walking the guide does not wipe an existing default-tier chain

- WHEN the `default` tier already holds a multi-model chain and the user walks the setup guide to add another provider/model
- THEN the guide appends the new model within the position cap (the existing primary and fallbacks are preserved), rather than replacing the whole chain with a single-element list; a model already in the chain is left unchanged
