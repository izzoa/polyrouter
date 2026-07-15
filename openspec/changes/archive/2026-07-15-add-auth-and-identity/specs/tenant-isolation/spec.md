# tenant-isolation — delta

## MODIFIED Requirements

### Requirement: Raw database handles stay private to the persistence module
The database module SHALL export only: the scoped `PersistencePort` token (repositories, join-scoped accessors, `ensureDefaultTier`) exactly as before; a separate **`IdentityPort` token** with **semantic identity-plane methods only** — `ensureFirstAdmin()` (advisory-locked promote-earliest-if-none, returns the admin id), `findAdminUserId()`, `provisionDefaultTier(userId)`, `provisionMissingDefaultTiers()` (advisory-locked; heals every user lacking a `default` tier, so boot reconciliation can recover a later user's crashed hook), and `agentAuth` (`findByPrefix` → id/owner/hash/prefix, `touchLastUsed`) — none of which returns a query builder or raw handle; an **opaque `AUTH_ADAPTER` token** (the Better Auth drizzle adapter, constructed inside this module over its private pool restricted to the four identity tables, so the auth plane needs no raw handle of its own); and the two privileged facilities `withTransaction`/`withAdvisoryLock` whose callbacks receive a transaction-bound `PersistencePort`, never a raw handle. The raw Pool and drizzle instance providers SHALL NOT be exported, and no exported surface SHALL expose `query`/`execute`/Pool/drizzle members; unscoped SQL is unwritable outside the persistence module.

#### Scenario: Raw providers do not resolve outside the module
- **WHEN** a test module importing the database module attempts to inject the raw drizzle/Pool providers
- **THEN** resolution fails, while the persistence port, identity port, auth adapter, and privileged facilities resolve normally

#### Scenario: Privileged facilities stay scoped
- **WHEN** code runs inside `withTransaction` or `withAdvisoryLock`
- **THEN** the callback argument is a transaction-bound `PersistencePort` exposing no `query`/`execute`/Pool/drizzle member (asserted structurally in a test)

#### Scenario: The data-plane seam resolves by token
- **WHEN** a consumer module (importing only `@polyrouter/shared/server` for the token) is composed with the database module
- **THEN** it receives the scoped `PersistencePort` via the token — the pattern #10/#11's data-plane module uses without importing control-plane

#### Scenario: Identity surfaces expose no tenant-data escape
- **WHEN** the `IdentityPort` methods or the `AUTH_ADAPTER` are used
- **THEN** they operate only on identity concerns (first-admin promotion, admin lookup, default-tier provisioning, agent lookup/last-used, Better-Auth-adapter operations over the four identity tables) and expose no query builder, raw Pool, or drizzle handle for arbitrary tenant-table SQL
