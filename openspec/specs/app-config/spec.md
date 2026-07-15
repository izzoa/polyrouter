# app-config Specification

## Purpose
TBD - created by archiving change add-monorepo-foundation. Update Purpose after archive.
## Requirements
### Requirement: Capabilities register their own configuration
The system SHALL provide a config-schema registry (in `packages/shared`) where each capability registers the typed, validated environment variables it introduces. Boot SHALL merge all registered fragments and validate `process.env` against them exactly once, before the HTTP server binds.

#### Scenario: Registered variable is validated
- **WHEN** a module registers a variable with a schema and the process starts with a value violating that schema
- **THEN** boot fails before any port is bound

#### Scenario: Later capabilities extend without modifying the framework
- **WHEN** a future change registers a new variable (e.g. `DATABASE_URL` in the database change)
- **THEN** it is validated by the same boot pass with no edits to the framework itself

### Requirement: Boot fails fast on missing or invalid configuration
WHEN required configuration is missing or invalid, the process SHALL exit non-zero with a message that names each offending variable and the reason. Validation failure messages SHALL NOT include the variable's value (future secret values must never reach logs — CLAUDE.md invariant 8).

#### Scenario: Missing required variable
- **WHEN** the process starts without a required registered variable
- **THEN** it exits with a non-zero code and a message naming that variable, without serving any traffic

#### Scenario: Invalid value is reported without echoing it
- **WHEN** a variable fails validation (e.g. `MODE=staging`)
- **THEN** the error names `MODE` and the expected values but does not print the supplied value

### Requirement: Initial variable set with self-host-safe defaults
This change SHALL register: `PORT` (integer, default `3001`), `BIND_ADDRESS` (default `127.0.0.1`, per spec §12 loopback-by-default for self-host safety), `NODE_ENV` (`development|production|test`, default `development` — `test` is a deliberate extension of spec §12's `development|production` for test harnesses; this change also updates spec.md §12 to record the extension, keeping durable sources in sync), and `MODE` (`selfhosted|cloud`, default `selfhosted`). The server SHALL bind to `BIND_ADDRESS`:`PORT`.

#### Scenario: Defaults apply
- **WHEN** the process starts with none of the initial variables set
- **THEN** it listens on `127.0.0.1:3001` in `selfhosted` mode

#### Scenario: MODE gates downstream behavior
- **WHEN** code queries the resolved config for `MODE`
- **THEN** it receives the validated enum value (`selfhosted` or `cloud`), the single source later self-host-only gates (auto-login, loopback SSRF exception) consult

