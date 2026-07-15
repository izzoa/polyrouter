# tenant-isolation Specification

## Purpose
TBD - created by archiving change add-database-and-tenancy. Update Purpose after archive.
## Requirements
### Requirement: Principal abstraction with honest user-only scoping
A `Principal` union type (`@polyrouter/shared/server`) SHALL represent the authenticated owner — `{ kind: 'user' }` implemented now, `{ kind: 'org' }` reserved so downstream signatures never change (spec §11.1). The ownership predicate SHALL be derived from the principal in exactly one shared helper; org principals SHALL throw with a pointer to the deferred org change (which owns the ownership-union schema migration and predicate branch — no false org-readiness).

#### Scenario: Predicate derives from the principal
- **WHEN** a scoped repository executes any query for a user principal
- **THEN** the SQL contains the ownership condition for that user's id, produced by the shared predicate helper

#### Scenario: Org principals fail loudly, not silently
- **WHEN** any guard method is invoked with an org principal
- **THEN** it throws naming the deferred org change rather than running an unscoped or mis-scoped query

### Requirement: Owned data is accessible only through the scoped repository guard
All access to directly-owned tables (Agent, Provider, Tier, RoutingRule — and later owned types) SHALL go through a central scoped-repository factory whose entire API takes a `Principal`: `findById`, `list`, `insert`, `update`, and `remove` — each appending the ownership predicate. **No unscoped by-id method SHALL exist on the guard** (CLAUDE.md invariant 5). `id` and ownership columns SHALL be immutable through the API: `insert` sets the owner from the principal (never caller input) and `update` strips/rejects `id`, `owner_user_id`, and `org_id` at the type level and at runtime. Rows owned through a parent (Model via provider, RoutingEntry via tier + model) SHALL be reachable only via join-scoped accessors applying the same predicate — **including at mutation time**: inserts SHALL atomically validate that every referenced parent belongs to the principal, ownership-defining foreign keys (`model.provider_id`, `routing_entry.tier_id`, `routing_entry.model_id`) SHALL be immutable through the API, and deletes SHALL be join-scoped. A row belonging to another principal SHALL be indistinguishable from a nonexistent row (not-found), for reads and writes alike.

#### Scenario: Cross-tenant read by id fails closed
- **WHEN** principal A calls `findById` with the id of a row owned by principal B
- **THEN** the result is not-found — identical to querying a random nonexistent id

#### Scenario: Cross-tenant mutation fails closed
- **WHEN** principal A calls `update` or `remove` with the id of principal B's row
- **THEN** zero rows are affected, the call reports not-found, and B's row is unchanged

#### Scenario: Ownership cannot be forged on insert
- **WHEN** `insert` is called with values attempting to set a different owner
- **THEN** the stored row is owned by the calling principal (owner columns are not caller-assignable)

#### Scenario: Ownership cannot be transferred by update
- **WHEN** `update` is called with a patch containing `owner_user_id`, `org_id`, or `id`
- **THEN** those fields are stripped or rejected and the stored row's identity and ownership are unchanged

#### Scenario: Cross-tenant parenting fails closed
- **WHEN** principal A attempts to create a model under principal B's provider, or to add a routing entry linking A's tier to B's model (or B's tier to any model)
- **THEN** the mutation is rejected as not-found and no row is created

#### Scenario: Parent foreign keys cannot be repointed
- **WHEN** an update attempts to change `model.provider_id` or a routing entry's `tier_id`/`model_id`
- **THEN** the field is stripped or rejected and the row's parentage is unchanged

### Requirement: Raw database handles stay private to the persistence module
The database module SHALL export only the shared persistence token (typed as the scoped `PersistencePort`: repositories, join-scoped accessors, `ensureDefaultTier`, and a narrow `users.count()` infrastructure accessor) and two privileged facilities — `withTransaction` and `withAdvisoryLock` (required by #3's first-admin race) — **whose callbacks receive a transaction-bound `PersistencePort`, never a raw handle**. The raw Pool and drizzle instance providers SHALL NOT be exported, and no exported surface SHALL expose `query`/`execute`/Pool/drizzle members; unscoped SQL is unwritable outside the persistence module.

#### Scenario: Raw providers do not resolve outside the module
- **WHEN** a test module importing the database module attempts to inject the raw drizzle/Pool providers
- **THEN** resolution fails, while the persistence port and the privileged facilities resolve normally

#### Scenario: Privileged facilities stay scoped
- **WHEN** code runs inside `withTransaction` or `withAdvisoryLock`
- **THEN** the callback argument is a transaction-bound `PersistencePort` exposing no `query`/`execute`/Pool/drizzle member (asserted structurally in a test)

#### Scenario: The data-plane seam resolves by token
- **WHEN** a consumer module (importing only `@polyrouter/shared/server` for the token) is composed with the database module
- **THEN** it receives the scoped `PersistencePort` via the token — the pattern #10/#11's data-plane module uses without importing control-plane

### Requirement: Cross-tenant regression harness
An e2e harness SHALL boot the app against a real PostgreSQL (dev compose), fabricate at least two principals directly (no auth plane exists yet), and exercise the cross-tenant scenarios above for every owned resource wired in this change — establishing the reusable pattern each later CRUD change extends. If the database is unreachable the suite SHALL fail with instructions, not skip.

#### Scenario: Harness proves isolation end to end
- **WHEN** the tenancy e2e suite runs with the dev database up
- **THEN** every cross-tenant read and mutation attempt for Agent, Provider, Tier, and RoutingRule rows returns not-found and leaves data unchanged

#### Scenario: Missing database is loud
- **WHEN** the suite runs with the database down
- **THEN** it fails (not skips) with a message naming the compose command to start it

