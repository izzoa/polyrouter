# agent-keys Specification

## Purpose
TBD - created by archiving change add-auth-and-identity. Update Purpose after archive.
## Requirements
### Requirement: Agent keys are minted shown-once and stored as HMAC + prefix
Agent API keys SHALL use the `poly_` prefix format (spec §16 branding) with a payload of 24 cryptographically-random bytes (base64url), and be returned **exactly once** — in the create or rotate response, which SHALL carry `Cache-Control: no-store`. The stored `api_key_prefix` SHALL be `poly_` plus the first 12 payload characters (≈72 bits, effectively collision-free and unique-indexed; mint retries on the rare collision). Storage SHALL be `api_key_hash = HMAC-SHA256(key, API_KEY_HMAC_SECRET)` plus the prefix; the full key SHALL never be persisted or logged (invariants 7, 8). Rotation SHALL invalidate the previous key immediately.

#### Scenario: Key appears only once
- **WHEN** an agent is created or its key rotated
- **THEN** the response contains the full `poly_…` key, a connection snippet, and `Cache-Control: no-store`, while the stored row holds only hash + prefix and every other read returns the prefix alone

#### Scenario: The stored hash never reaches responses or logs
- **WHEN** any agent endpoint responds and during key verification
- **THEN** neither the full key nor the `api_key_hash` appears in any response body or log line

#### Scenario: Rotation invalidates the old key
- **WHEN** an agent's key is rotated
- **THEN** the previous key stops authenticating immediately and the new one works

### Requirement: Bearer verification is fast and constant-time
The `AgentApiKeyGuard` SHALL resolve `Authorization: Bearer <key>` by prefix lookup and constant-time HMAC comparison — **no slow hash on the hot path** (invariant 7; §3.2.3) — rejecting unknown prefixes, wrong keys, and malformed headers with a uniform 401, and stamping the agent's `last_used_at` **coalesced** (per-agent throttle, `.catch`-guarded, non-blocking — never one write per request, never an unhandled rejection). Key resolution is identity-plane: it uses the enumerated `IdentityPort.agentAuth` accessor, not tenant-scoped repositories.

#### Scenario: No KDF is on the verification path
- **WHEN** the verification code path is exercised
- **THEN** it invokes only HMAC-SHA256 and a constant-time comparison — asserted deterministically (by construction/spy), not merely by timing — with a non-gating benchmark as corroboration

#### Scenario: Invalid credentials are rejected uniformly
- **WHEN** a request presents an unknown prefix, a wrong key with a known prefix, or a malformed header
- **THEN** the response is 401 without distinguishing the cause

#### Scenario: Usage is stamped off the hot path without unbounded writes
- **WHEN** a valid key authenticates repeatedly in quick succession
- **THEN** `last_used_at` updates eventually (coalesced) without the request waiting on the write and without one database write per request

### Requirement: Agents CRUD is tenant-scoped with shared harness snippets
`/api/agents` SHALL provide list/create/rotate-key/delete for the session principal through the scoped repository (§6.2, §11.1): list never exposes hashes; create validates its `harness` field against the canonical harness list in `@polyrouter/shared`; create/rotate responses include the per-harness connection snippet built by the shared snippet module (§2.1) — the same module the dashboard consumes. Cross-tenant access by id SHALL be not-found.

#### Scenario: Connect-an-agent flow
- **WHEN** a user creates an agent named for their harness
- **THEN** the response carries the shown-once key and a copy-paste snippet pointing `base_url` at the router with that key

#### Scenario: Cross-tenant agent access fails closed
- **WHEN** user A calls rotate-key or DELETE on user B's agent id, or B's agent never appears in A's list
- **THEN** the mutating calls return 404 and B's agent (and its key) are unchanged

### Requirement: The agent-key guard is provable ahead of the proxy
The `AgentApiKeyGuard` SHALL be demonstrable at this change's position in the build (before the proxy, #10) via a **test-only probe route on a `/v1`-style path** guarded by it, so the guard's accept/reject behavior and plane separation are verified without shipping proxy endpoints.

#### Scenario: Minted key authenticates the probe route
- **WHEN** a key minted through `/api/agents` is presented as `Bearer` to the guarded `/v1` probe route
- **THEN** the probe route executes; a session cookie presented to the same route does not authenticate it

