# monorepo-workspace Specification

## Purpose
TBD - created by archiving change add-monorepo-foundation. Update Purpose after archive.
## Requirements
### Requirement: Workspace layout follows the reference repository structure
The repository SHALL be a Turborepo + npm workspaces monorepo containing exactly the four packages from spec.md §4 — `packages/shared`, `packages/control-plane`, `packages/data-plane`, `packages/frontend` — with `data-plane` present as its own package from day one so the cloud-tier extraction (§3.3) needs no restructuring.

#### Scenario: Fresh checkout builds
- **WHEN** a clean clone runs `npm ci` (from the committed `package-lock.json`) followed by `npm run build` on Node.js 24.x LTS / npm 10–11
- **THEN** the build completes with exit code 0, building `shared` first and `data-plane` before `control-plane` (Turborepo dependency graph; `frontend` needs only `shared`), with all four packages built

#### Scenario: Unsupported toolchain is refused
- **WHEN** `npm install`/`npm ci` runs on a Node.js major version other than 24 or an npm major version outside 10–11
- **THEN** installation fails due to the enforced `engines` constraint (`engine-strict=true`) rather than proceeding to undefined behavior

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

### Requirement: Strict TypeScript everywhere
All packages SHALL compile under TypeScript `strict: true`, and the build SHALL fail on any type error.

#### Scenario: Type error fails the build
- **WHEN** a file containing a type error (e.g. an implicit `any`) is present in any package
- **THEN** `npm run build` exits non-zero naming the offending file

### Requirement: Dependency direction is enforced
The workspace dependency graph SHALL be exactly: `shared` depends on no workspace package; `data-plane` depends only on `shared`; `control-plane` depends only on `shared` and `data-plane`; `frontend` depends only on `shared`. `control-plane` SHALL consume `data-plane` as a built package (declared workspace dependency with an `exports` entrypoint), not via source paths. Any edge outside this matrix SHALL be rejected by tooling — regardless of import style (package name, path alias, or relative path) — not by convention.

#### Scenario: Reverse import is rejected
- **WHEN** a file in `packages/data-plane` imports from `packages/control-plane`
- **THEN** `npm run lint` (and therefore CI) fails with a boundary violation

#### Scenario: Boundary bypasses are rejected
- **WHEN** a file crosses the matrix via a relative path or path alias instead of a package name (e.g. `frontend` importing `../control-plane/src/...`)
- **THEN** `npm run lint` fails with the same boundary violation

### Requirement: Test harnesses are wired per package
Backend packages (`control-plane`, `data-plane`) SHALL use Jest + Supertest; `frontend` and `shared` SHALL use Vitest (spec §3.1). Every package SHALL contain at least one real passing test so a broken harness cannot pass silently.

#### Scenario: Per-package tests run green
- **WHEN** `npm test -w packages/<pkg>` runs for each of the four packages
- **THEN** each invokes that package's configured runner and exits 0 with at least one executed assertion

### Requirement: Root scripts match the maintained command set
The root package SHALL provide the CLAUDE.md command set: `npm run dev` (control-plane watch + Vite together), `npm run build` (Turborepo dependency order), `npm start` (production server), `npm test -w packages/<pkg>`, `npm run test:e2e -w packages/control-plane`, and lint/format scripts. Changesets SHALL be configured so the release-note flow works for private packages: `changeset version` consumes pending changesets into CHANGELOG entries without publishing or tagging.

#### Scenario: Dev command serves both planes
- **WHEN** `npm run dev` is running
- **THEN** the Vite dev server responds on `:3000` and the backend responds on `:3001` concurrently

#### Scenario: Dev works from a clean checkout
- **WHEN** a clean clone runs `npm ci` followed directly by `npm run dev` (no manual `npm run build`)
- **THEN** the dev pipeline builds workspace dependencies (`shared`, `data-plane`) first and both planes serve successfully

#### Scenario: Changesets produce release notes
- **WHEN** a contributor runs `npx changeset` and later `npx changeset version`
- **THEN** a changeset file is created and then consumed into a CHANGELOG entry, with no publish or git tag attempted

