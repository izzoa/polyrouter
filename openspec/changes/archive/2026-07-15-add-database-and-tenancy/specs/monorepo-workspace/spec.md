# monorepo-workspace — delta

## MODIFIED Requirements

### Requirement: Shared package builds to CJS and ESM
`packages/shared` SHALL be built to both CJS and ESM with TypeScript declarations, and its `exports` map SHALL resolve correctly from both module systems. It SHALL additionally expose a **server-only entrypoint `@polyrouter/shared/server`** (schema, principal types, encryption — code that may depend on node built-ins and server-side libraries): importable by `control-plane` and `data-plane`, forbidden to `frontend` by lint **in every import form** (package subpath, deep source path, relative path, and built output), and never re-exported through the root entrypoint.

#### Scenario: Consumed from both module systems
- **WHEN** `control-plane` (CJS/NestJS) imports a symbol from `shared` in a Jest test and `frontend` (ESM/Vite) imports the same symbol in its build
- **THEN** both resolve and type-check without interop errors

#### Scenario: Server entrypoint stays off the frontend in every form
- **WHEN** a file in `packages/frontend` imports `@polyrouter/shared/server`, a deep path under it, or reaches `shared`'s server code via a relative or dist path
- **THEN** `npm run lint` fails with a boundary violation

#### Scenario: Root entrypoint does not smuggle server code
- **WHEN** the public root entrypoint of `@polyrouter/shared` is inspected
- **THEN** it exports no server-only symbols (schema, encryption, principal helpers) — asserted by a unit test
