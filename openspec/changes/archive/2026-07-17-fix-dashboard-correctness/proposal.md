## Why

The SPA's key handling and XSS posture are exemplary, but four correctness/UX defects lose a
shown-once key, strand an expired session, wipe routing config, or copy a wrong endpoint (FABLE_AUDIT
E12):

- **A mid-session 401 strands the user.** 401 is handled only during `bootstrap()`. After
  `authView==='ready'`, every loader/mutation funnels its error through `errMessage` (status discarded),
  so a cloud user whose session expires is stuck in a shell where every action fails with an
  unexplained "Unauthorized" and the 15s poll paints a permanent red banner whose Retry can never
  succeed.
- **`copy()` claims success when the clipboard write failed.** It fires
  `navigator.clipboard.writeText(txt).catch(()=>undefined)` and **unconditionally** toasts
  "Copied"/"Key copied". On a non-secure origin (self-host over plain http on a LAN IP — very common)
  `navigator.clipboard` is undefined; the user sees "Key copied", clicks Done (which wipes the
  shown-once key), and the key is gone — forcing a rotate.
- **The displayed/copied endpoint is a hardcoded dev URL.** `BASE_URL = 'http://127.0.0.1:3001/v1'`
  is a build-time constant behind the endpoint chip, Settings "Endpoint", the Agents instructions, and
  the sidebar footer. The server-minted snippets derive from the real origin, so any instance behind a
  non-default host **displays and copies an endpoint that contradicts the snippet beside it**.
- **The setup guide wipes an existing default-tier chain.** `obConnectProvider` unconditionally calls
  `replaceTierEntries(def.id, [first.id])` — an atomic full replace. The guide card is always visible,
  so a user who already configured `default = [primary, …fallbacks]` and later walks the guide to add a
  provider gets their whole chain replaced by a single model, no warning — silent routing-config loss.

## What Changes

- **E12.1** Add a central 401 reroute in the shared error path: when `isApiError(e) && e.status===401 &&
  authView==='ready'`, re-probe via `bootstrap()` (which flips to the login gate and reloads
  login-config). Guarded on `ready` so bootstrap/login 401s don't recurse.
- **E12.2** Make the clipboard write authoritative: await `writeText` (treat a missing API as failure)
  and toast a distinct "Copy failed — select the text manually" on failure, never a false "Copied". The
  public `copy` signature stays `=> void` (internal async) so no caller/handler changes.
- **E12.3** Derive the displayed endpoint from the runtime origin (`${location.origin}/v1`) so it
  matches how the instance is actually served and agrees with the key-reveal snippet; fix the sidebar
  host literal too.
- **E12.4** Read the default tier's entries first; **replace only when empty**, otherwise append the new
  model within the 5-cap (existing primary + fallbacks preserved), and no-op when the model is already
  routed. The fresh-instance onboarding path (empty default) is unchanged.

## Capabilities

### Modified Capabilities

- `dashboard-core`: a mid-session 401 re-probes to the login gate (never strands the shell); a failed
  clipboard copy surfaces a distinct failure (never a false success that costs the shown-once key); the
  onboarding guide appends to a non-empty default tier instead of replacing it; and the displayed
  connection endpoint is derived from the serving origin.

## Impact

- **Code (frontend only):** `state/appState.ts` (central `err()` 401 reroute + `copy()` await +
  `obConnectProvider` read-before-replace), `data/catalog.ts` (`BASE_URL` from `location.origin`),
  `components/Sidebar.tsx` (host literal → origin). No consumer signature changes.
- **Tests (Vitest):** a ready store gets a loader 401 → `authView==='gate'`; `copy` with
  `navigator.clipboard` undefined/rejecting → failure toast, not "Key copied"; `obConnectProvider` on a
  seeded 2-entry default preserves the existing modelIds (appends, not replaces); a fresh default still
  gets `[first]`. **No backend change, no migration, no schema change.** Changeset: user-facing.
- Backlog A-26..A-31 (duplicate-provider retry, double-submit guards, body-logging no-op, Agents
  placeholder copy, hardcoded version string, timeseries zero-fill) are out of scope.
