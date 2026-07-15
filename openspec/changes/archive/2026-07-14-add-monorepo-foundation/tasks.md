# Tasks: add-monorepo-foundation

## 1. Repo & toolchain scaffold

- [x] 1.1 Root `package.json` with npm workspaces (`packages/*`), `engines` (`node >=24 <25`, `npm >=10 <12` — Node 24 bundles npm 11; design decision 9), `packageManager` pinning the exact npm version, `.npmrc` (`engine-strict=true`), `.nvmrc`, `.gitignore`; commit `package-lock.json` (clean installs use `npm ci`)
- [x] 1.2 `turbo.json` task graph: `build` (dependsOn `^build`), `test`, `lint`, `dev` (persistent, **dependsOn `^build`** so a clean checkout needs no manual build, with watch rebuilds for `shared`/`data-plane`) — dependency order `shared` → `data-plane` → `control-plane`, `frontend` after `shared`
- [x] 1.3 Base `tsconfig.base.json` with `strict: true` (+ `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) extended by every package
- [x] 1.4 ESLint flat config (typescript-eslint, type-checked) + Prettier; root `lint`/`format` scripts; verify a type error fails `npm run build` and a lint violation fails `npm run lint`
- [x] 1.5 Initialize changesets with `privatePackages: { version: true, tag: false }`; verify the lifecycle: `npx changeset` creates a file, `npx changeset version` consumes it into a CHANGELOG entry with no publish/tag (discard the bump after verifying)
- [x] 1.6 Toolchain-refusal check: automated test asserting the `engines` ranges and `engine-strict=true` are present/correct, plus a documented one-off verification that `npm ci` fails on a non-24 Node major

## 2. shared package (config registry lives here)

- [x] 2.1 Scaffold `packages/shared` with tsup dual build (CJS + ESM + `.d.ts`, `exports` map) and Vitest wired
- [x] 2.2 Implement the config-schema registry: `registerConfig(namespace, zodSchema)` + `loadConfig(env)` that merges fragments, validates once, and throws a report naming each offending variable **without echoing values**
- [x] 2.3 Register the initial variable set: `PORT` (int, default 3001), `BIND_ADDRESS` (default `127.0.0.1`), `NODE_ENV` (`development|production|test`, default `development` — the `test` extension per design decision 5), `MODE` (`selfhosted|cloud`, default `selfhosted`)
- [x] 2.4 Vitest coverage alongside 2.2/2.3: defaults apply; a **required** fragment (registered by the test, since the initial set is all-defaulted) missing from env throws naming it; invalid `MODE` error omits the supplied value; a fragment registered later is validated by the same pass

## 3. control-plane skeleton

- [x] 3.1 Scaffold `packages/control-plane` as a NestJS 11 app depending on `shared`; Jest + Supertest wired; maintain both `npm test` and `npm run test:e2e` scripts for the package (CLAUDE.md command set)
- [x] 3.2 Boot sequence: load/validate config **before** binding; on failure exit non-zero with the report; listen on `BIND_ADDRESS:PORT`; Jest test spawns the process with a required test-only config fragment absent and asserts non-zero exit + variable named
- [x] 3.3 Global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`); Supertest e2e proving a non-whitelisted property returns 400 (temporary probe DTO in the test module)
- [x] 3.4 `GET /api/health` returning `{ "status": "ok" }` unauthenticated + Supertest e2e
- [x] 3.5 CORS enabled only when `NODE_ENV=development`; e2e asserts no `Access-Control-Allow-Origin` in production mode

## 4. data-plane package & boundary

- [x] 4.1 Scaffold `packages/data-plane` with its own build output and `exports` entrypoint, exporting an (empty-for-now) NestJS module; `control-plane` declares the workspace dependency and imports the **built package** (not source paths) in its root module; Jest wired with one real test; a shared-package symbol imported in a test (CJS interop smoke)
- [x] 4.2 Enforce the full dependency matrix in lint (`shared` → nothing; `data-plane` → `shared`; `control-plane` → `shared`+`data-plane`; `frontend` → `shared`), covering package-name, path-alias, and relative-path imports; prove it with fixtures/unit tests for at least the reverse edge (data-plane→control-plane) and one relative-path bypass

## 5. frontend skeleton

- [x] 5.1 Scaffold `packages/frontend` (SolidJS + Vite + TS strict) rendering a minimal polyrouter shell; Vitest smoke test; a shared-package symbol imported (ESM interop smoke)
- [x] 5.2 Vite `server.proxy` for `/api` and `/v1` → `http://localhost:3001`, configured streaming-safe (no buffering) with a comment pinning the SSE requirement for #10; verify `/api/health` round-trips through `:3000` in dev

## 6. Production topology

- [x] 6.1 Serve `frontend/dist` from NestJS in production with SPA fallback for non-`/api`/non-`/v1` routes; `npm start` sets `NODE_ENV=production` explicitly (`cross-env`) so an unset environment still runs production behavior
- [x] 6.2 E2e (against a built app): one port serves `GET /` (SPA shell), `GET /api/health` (200), a deep link like `/agents` (SPA shell, not 404), **and** `GET /api/nonexistent` + `GET /v1/nonexistent` return 404 JSON (not the SPA shell)
- [x] 6.3 E2e: `npm start` serves the SPA and emits no `Access-Control-Allow-Origin` header both with `NODE_ENV` unset **and with `NODE_ENV=development` inherited from the spawning environment** (production mode forced over inherited values)

## 7. Root commands & final verification

- [x] 7.1 Root scripts: `npm run dev` (control-plane watch + Vite concurrently), `npm run build`, `npm start`, per-package `npm test`, `npm run test:e2e -w packages/control-plane` — all work as documented in CLAUDE.md
- [x] 7.2 Sync durable sources: correct CLAUDE.md's commands note per design decision 6 (spec §3.1 wins: Vitest covers `shared`, Jest covers backend packages), update spec.md §12 to record the `NODE_ENV` `test` extension (design decision 5), and update spec.md §3.1 + CLAUDE.md's npm pin to 10–11 (design decision 9)
- [x] 7.3 Clean-checkout verification: fresh clone → `npm ci` → `npm run dev` works **directly, with no manual build** (SPA shell on `:3000`, health on `:3001`) → then `npm run build` → all package tests green → `npm run lint` clean
- [x] 7.4 Add a changeset describing the scaffold (user-facing: the repo now builds/runs)
