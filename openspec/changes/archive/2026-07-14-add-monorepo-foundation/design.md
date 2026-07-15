# Design: add-monorepo-foundation

## Context

Greenfield repo containing only planning documents (spec.md, CLAUDE.md, TODOS.md, openspec/). This change produces the first code: the §4 monorepo, pinned §3.1 toolchain, and the §12 config/boot behavior that all 21 later changes build on. Constraints: the stack is pinned (CLAUDE.md — no substitutions without a proposal), the `data-plane` package must be extractable later without a rewrite (§3.3), and self-host safety defaults apply from day one (`BIND_ADDRESS=127.0.0.1`).

## Goals / Non-Goals

**Goals:**
- A clean checkout builds, lints, and tests green with the pinned toolchain (Node 24.x LTS, npm 10.x, TS strict).
- The four §4 packages exist with correct dependency direction (`shared` ← `control-plane`/`data-plane`/`frontend`; `data-plane` never imports `control-plane`).
- Config is registered per-capability, validated at boot, and fails fast with a clear message.
- `npm run dev` gives the §4 dev topology; `npm run build && npm start` serves SPA + API on one port.

**Non-Goals:**
- Anything from TODOS.md #2+ (DB, Redis, auth, proxy, Docker). No env vars owned by later capabilities.

## Decisions

1. **Turborepo task graph mirrors the §4 build order.** `build` depends on `^build` so `shared` compiles before its dependents and `data-plane` builds before `control-plane` (which consumes it as a built package with an `exports` entrypoint, not as source); `frontend` needs only `shared`. **`dev` also depends on `^build`** so `npm ci && npm run dev` works on a clean checkout with no manual build step, then runs watch rebuilds for `shared` and `data-plane` alongside control-plane watch + Vite so edits propagate. Alternative (npm scripts + `concurrently` only) rejected: no caching, no graph, and Turborepo is pinned anyway.

2. **`data-plane` is a real workspace package consumed as a NestJS module by `control-plane`, with the full dependency matrix enforced.** Allowed edges are exactly: `shared` → nothing; `data-plane` → `shared`; `control-plane` → `shared` + `data-plane`; `frontend` → `shared`. A dependency-boundary lint rule enforces the whole matrix — not just the data-plane→control-plane edge — and rejects bypasses via path alias or relative path, not only package-name imports. This makes the §3.3 extraction a deploy change, not a refactor. Alternative (a `data-plane/` folder inside control-plane) rejected: boundary erosion is exactly what §4 warns against.

3. **`shared` builds with `tsup` to CJS + ESM + `.d.ts`.** One config, both formats, correct `exports` map (`require`/`import`/`types`). Alternative (two `tsc` passes) rejected: hand-maintained dual `package.json`/exports plumbing is the classic source of ESM/CJS interop bugs; `tsup` is a devDependency, not a stack substitution.

4. **Config framework: a small registry in `shared` + zod validation, wired into Nest via `@nestjs/config`.** Each capability calls `registerConfig(namespace, zodSchema)`; boot merges all registered fragments, parses `process.env` once, and throws before the HTTP server binds. Zod over Joi/class-validator: full TS type inference (strict-mode friendly), and the registry lives in `shared` so `data-plane` can use it after extraction. **Validation errors name the offending variable but never print its value** (future-proofing for secret vars, invariant 8).

5. **Initial variables and defaults:** `PORT` (int, default `3001`), `BIND_ADDRESS` (default `127.0.0.1` — §12 loopback-by-default; #22 overrides in-container), `NODE_ENV` (`development|production|test`, default `development` — `test` is a **deliberate extension** of §12's `development|production` for test harnesses — and this change updates spec.md §12 to record it, keeping the durable sources in sync per CLAUDE.md rather than leaving the divergence in a delta), `MODE` (`selfhosted|cloud`, default `selfhosted` — local-first product, and self-host gates are the safe default). Because `NODE_ENV` defaults to `development` and gates CORS/static-serving, **`npm start` sets `NODE_ENV=production` explicitly (via `cross-env` for portability)** so the documented production command (`npm run build` + `npm start`) can never inherit development behavior from a bare environment.

6. **Test runners follow spec §3.1, which splits from CLAUDE.md on one point.** Spec §3.1 says "Jest + Supertest (backend), **Vitest (frontend/shared)**"; CLAUDE.md's commands section says "Jest for backend/shared". Per CLAUDE.md's own precedence rule ("the spec wins on any specific detail"): **Jest + Supertest for `control-plane`/`data-plane`, Vitest for `frontend` and `shared`**. Flagged here rather than silently resolved; CLAUDE.md's command doc should be corrected when this change lands.

7. **Health endpoint at `GET /api/health`, unauthenticated**, returning `{ "status": "ok" }`. Lives under `/api` so the Vite dev proxy covers it; #22 wires it to orchestration.

8. **Dev/prod topology per §4.** Dev: Vite `:3000` with `server.proxy` for `/api` and `/v1` → `:3001` (proxy configured stream-friendly so SSE works when #10 lands); CORS enabled only when `NODE_ENV=development`. Prod: `ServeStaticModule` serves `frontend/dist` from the Nest process on `PORT`, SPA-fallback for non-`/api`/`/v1` routes.

9. **Toolchain enforcement:** `engines` (`node >=24 <25`, `npm >=10 <12`) + `engine-strict=true` in `.npmrc` + `.nvmrc` + a `packageManager` field pinning the exact npm version for reproducibility; `package-lock.json` is committed and clean installs use `npm ci`. *npm range rationale (user-approved during apply):* spec §3.1's "npm 10.x" predates the fact that **Node 24 bundles npm 11** — a strict `<11` pin would make the scaffold refuse to install on a stock Node 24; task 7.2 syncs spec.md §3.1 accordingly. ESLint flat config with `typescript-eslint` (type-checked rules), Prettier separate from lint. **Changesets lifecycle defined, not just initialized:** packages stay private/unpublished, but changesets is configured to version private packages (`privatePackages: { version: true, tag: false }`) so `changeset version` actually consumes changesets into CHANGELOG entries — the CLAUDE.md release-note flow — without any publish/tag step.

## Risks / Trade-offs

- [NestJS CJS runtime importing dual-built `shared`] → `exports` map generated by tsup, plus a smoke test in each consumer (one import exercised in a Jest test and in the Vite build) so interop breaks fail CI, not runtime.
- [Vite proxy buffering would break SSE streaming later (#10)] → configure the `/v1` proxy entry now with streaming-safe settings and a comment pinning the requirement; verified properly when #10 adds streams.
- [Boundary rule drift (data-plane importing control-plane)] → enforced in lint (fails CI), not convention.
- [Empty-package skeletons make "tests green" trivially true] → each package gets at least one real assertion (config validation, health e2e via Supertest, shared util round-trip, frontend smoke render) so harnesses are proven wired.
- [`MODE` default `selfhosted` could leak self-host relaxations into cloud deploys] → cloud deploys must set `MODE=cloud` explicitly; acceptable because self-host is the primary distribution and later gates (#3 auto-login, #4 loopback) all check the value at use time.

## Migration Plan

Greenfield — nothing to migrate. Rollback = revert the change; no data involved.

## Open Questions

None blocking. (Whether `data-plane` stays version-pinned to `control-plane` via workspace `*` protocol until extraction is a #22-era concern.)
