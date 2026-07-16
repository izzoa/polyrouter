# Proposal: add-ci-and-drain-tests

Implements **FABLE_AUDIT.md Epic E7** (post-baseline hardening; new entry for the TODOS.md status
board — all 22 numbered build entries are archived). Supports **spec.md §3.2** (graceful shutdown
drains in-flight streams; streaming applies backpressure), the matching **§15 acceptance criteria**
("deploys drain in-flight streams", "no unbounded buffering to a slow client"), and **CLAUDE.md
invariants 10 & 12** plus the Definition of done.

## Why

CLAUDE.md's Definition of done (build passes, lint clean, tests green) is enforced by convention
only — the repo has no CI. That gap already has observable consequences: the only suite that pins the
circuit breaker's Redis Lua scripts to the TypeScript state machine (`breaker-redis.spec.ts`,
invariant 10) is gated on `REDIS_URL` and silently self-skips in every automated context; three
breaker spec files carry imports of a nonexistent module and a phantom export that ts-jest's
transpile-only mode never surfaces (degrading one circuit-open assertion to "accepts any rejection");
and two spec-mandated behaviors — shutdown stream draining and slow-client backpressure (invariant
12) — have zero automated coverage, so a regression there ships silently into the Docker image where
deploy restarts are routine. Separately, the e2e runner masks leaked async handles with
`forceExit: true`, which is the standing suspect for the known `auth.e2e-spec` full-suite flake.

## What Changes

- **New GitHub Actions CI workflow** (`.github/workflows/ci.yml`) that runs on every push/PR:
  - *Quality job* (with a `redis:7` service, `REDIS_URL` exported): `npm ci`, `npm run build`,
    `npm run lint`, typecheck (including spec/test files), unit tests for all four packages — the
    real-Redis breaker parity suite **executes** here (not skips).
  - *e2e job:* `postgres:16` + `redis:7` services (published ports, health-checked), then the
    control-plane e2e suite via the root `test:e2e` script (which builds first).
- **Typecheck wiring:** per-package `typecheck` scripts (`tsc --noEmit` over the tsconfig that
  includes spec/test files), a `typecheck` turbo task, and a root `npm run typecheck` script.
  turbo's `test` task additionally declares `env: ["CI", "REDIS_URL"]` — turbo runs in strict env
  mode and would otherwise strip both variables from the child process, silently defeating the
  loud-skip rule below (and a cached local skip could replay).
- **Loud skip in CI:** `breaker-redis.spec.ts` fails (instead of warn+skip) when `CI` is set but
  `REDIS_URL` is missing, so the parity suite can never silently drop out of the pipeline again.
- **Fix the phantom imports** the new typecheck exposes: three breaker spec files import
  `NormalizedStreamEvent` from a nonexistent `./translate` (real home: `../proxy/translate`), and
  `breaker-state-listener.spec.ts` imports `ProviderCircuitOpenError` from `./breaker` (not exported
  there; real home: `./errors`) — which currently makes its `rejects.toThrow(...)` assertion vacuous.
  Fixing the import restores the open→skip assertion's strength.
- **Invariant-12 test coverage** (tests only; no production code changes):
  - A colocated unit spec for `StreamDrainRegistry` (register/deregister lifecycle;
    `beforeApplicationShutdown` flips draining, waits for in-flight streams, aborts stragglers at
    the deadline).
  - Proxy integration/e2e coverage for: new `/v1` work refused with 503 while draining; an in-flight
    stream completing during drain; a mid-stream client disconnect aborting the upstream call while
    staying breaker-neutral; and a slow-reading client engaging the `res.write()`/`drain()`
    backpressure path instead of unbounded buffering.
- **De-flake the e2e runner:** remove `forceExit: true` from `jest-e2e.config.cjs`, fix the leaked
  handles that `--detectOpenHandles` surfaces (test-side only: closing queues/workers/apps in
  `afterAll`), and make the auth rate-limit tests timing-robust if implicated.

## Capabilities

### New Capabilities

- `ci-pipeline`: the project's automated quality gate — what CI must run (build, lint, typecheck
  including test files, unit + infra-backed suites, e2e), the rule that environment-gated suites run
  loudly or fail in CI, the requirement that the e2e runner exits cleanly without `forceExit`, and
  the requirement that the spec-mandated drain/backpressure/disconnect scenarios have automated
  coverage executed by CI.

### Modified Capabilities

*None.* No runtime requirement changes: the drain/backpressure scenarios being covered already exist
in `openspec/specs/inference-proxy/spec.md`; this change adds their missing regression coverage and
the pipeline that runs it. All code edits are confined to test files and build/CI configuration.

## Impact

- **New files:** `.github/workflows/ci.yml`; `packages/control-plane/src/proxy/stream-drain.registry.spec.ts`;
  new e2e/integration spec(s) under `packages/control-plane/test/proxy/`.
- **Modified (config):** root `package.json` (+`typecheck` script), `turbo.json` (+`typecheck` task),
  per-package `package.json` (+`typecheck`), `packages/control-plane/jest-e2e.config.cjs`
  (remove `forceExit`).
- **Modified (test files only):** `breaker-caller-abort.spec.ts`, `breaker-open.spec.ts`,
  `breaker-state-listener.spec.ts` (imports), `breaker-redis.spec.ts` (loud CI skip), e2e suites
  that leak handles (cleanup in `afterAll`), and the further control-plane test files the new
  typecheck surfaces — a scouting `tsc --noEmit` run found ~18 pre-existing errors, ~14 beyond the
  breaker files (e.g. a Node16-incompatible dynamic import in `budget-proxy.e2e-spec.ts`, unsafe
  row indexing in `auth.e2e-spec.ts`, nullable-return mismatches in `cascade-routing.e2e-spec.ts`)
  — all test-side; any production `src/` type error is a stop-and-flag.
- **No production `src/` changes, no schema change, no migration, no changeset** (not user-facing).
- **Dependencies:** none added; CI uses `actions/checkout`, `actions/setup-node` (pinned to
  `.nvmrc` → Node 24), and Docker service containers (`postgres:16-alpine`, `redis:7-alpine` to
  match `docker-compose.dev.yml`).

## Non-goals

- **No production drain fix:** FABLE_AUDIT Task E1.2 (the drain deadline cannot terminate a
  write-blocked stream; `app.close()` can hang) is a runtime defect belonging to epic E1's change.
  This change tests *currently-specified, currently-correct* behavior only; the
  write-blocked-at-shutdown assertion lands with E1.2.
- **No other FABLE_AUDIT epics** (breaker recovery, translation fidelity, etc.) — one epic ≈ one change.
- **No release/publish automation, coverage thresholds, Docker image builds, or matrix builds** in
  CI — this is the correctness gate only; extensions come as their own proposals.
- **No production shutdown-code edits for de-flaking.** If `--detectOpenHandles` implicates a
  production `src/` leak (not a test harness), stop and flag it as its own change rather than
  patching it here.
