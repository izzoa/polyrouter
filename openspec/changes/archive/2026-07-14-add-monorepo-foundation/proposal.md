# Proposal: add-monorepo-foundation

> Implements **TODOS.md #1 `add-monorepo-foundation`** — spec.md **§3.1** (baseline stack), **§4** (repository structure), **§12** (configuration & environment), **§14.1** (scaffold milestone).

## Why

polyrouter has an approved spec and a 22-change build plan but no code: every subsequent change (database, auth, providers, proxy) needs a monorepo to land in, pinned tooling so stack drift can't start, and a config framework so "boot fails fast on bad config" is true from the first capability rather than retrofitted. This change creates that foundation and nothing else.

## What Changes

- Create the Turborepo + npm workspaces monorepo with the four §4 packages: `packages/shared` (types/enums/constants, built to CJS + ESM), `packages/control-plane` (NestJS 11), `packages/data-plane` (the proxy as a NestJS module boundary from day one, compiled into the control-plane server), `packages/frontend` (SolidJS + Vite).
- TypeScript **strict** everywhere; ESLint + Prettier; Jest + Supertest (`control-plane`/`data-plane`), Vitest (`frontend`/`shared`) per spec §3.1; changesets tooling.
- NestJS skeleton with the global `ValidationPipe` (`whitelist: true`, `forbidNonWhitelisted: true`) and a health endpoint.
- **Extensible env/config-schema framework**: each capability registers the vars it introduces; boot validates all registered vars and **fails fast (non-zero exit, clear message) on missing/invalid config**. This change registers `PORT` (default 3001), `BIND_ADDRESS` (default `127.0.0.1` per §12), `NODE_ENV`, `MODE` (`selfhosted|cloud`).
- Dev topology: Vite on `:3000` proxying `/api` and `/v1` to the backend on `:3001`; CORS enabled in dev only. Prod topology: NestJS serves the built SPA + API on one port.
- Root scripts: `npm run dev` (control-plane watch + Vite), `npm run build` (Turborepo dependency graph: `shared` → `data-plane` → `control-plane`, with `frontend` after `shared`), `npm start`, `npm test -w packages/<pkg>`, `npm run test:e2e -w packages/control-plane`.

## Capabilities

### New Capabilities

- `monorepo-workspace`: repository layout (§4), workspace/package wiring, build/lint/test pipeline, root scripts, shared-package dual build (CJS + ESM), changesets.
- `app-config`: the extensible config-schema framework — var registration, validation, fail-fast boot semantics, defaults (`BIND_ADDRESS=127.0.0.1`), and the initial variable set (§12).
- `app-bootstrap`: the runnable server skeleton — NestJS with global ValidationPipe, health endpoint, prod SPA-serving on one port, dev proxy topology with dev-only CORS.

### Modified Capabilities

_None — `openspec/specs/` is empty; this is the first change._

## Impact

- **Code:** everything is new; no existing code affected. Directory boundary for `data-plane` established now so the cloud-tier extraction (§3.3) stays lift-and-shift.
- **Dependencies pinned:** Node.js 24.x LTS, npm 10–11 (Node 24 bundles npm 11 — design decision 9), TypeScript strict, NestJS 11, Turborepo, SolidJS + Vite, Jest/Supertest/Vitest, changesets. (Per CLAUDE.md these are not to be substituted without a change proposal.)
- **Downstream:** TODOS.md #2–#22 all depend on this change; later changes register their own env vars (`DATABASE_URL`, `REDIS_URL`, …) in the `app-config` framework rather than extending this change.

## Non-goals

- **No database or Redis** — Drizzle schema, migrations, tenant guard, and Redis wiring are TODOS.md #2 (`add-database-and-tenancy`); their env vars are registered there.
- **No auth** — Better Auth and agent API keys are #3.
- **No business endpoints** — nothing beyond the health endpoint; the proxy contract starts at #10.
- **No Docker/packaging** — single-container image, compose, and the `BIND_ADDRESS=0.0.0.0` container override are #22 (`add-packaging`).
- **No env vars owned by later capabilities** (`ROUTING_AUTO_LAYERS`, `SMTP_*`, `APPRISE_API_URL`, secrets) — the framework is extensible precisely so those land with their owners.
