# Design: add-ci-and-drain-tests

## Context

All 22 baseline build entries are archived and the full suite is green locally — but nothing runs it
automatically. Three latent problems motivate the shape of this change: (1) the real-Redis breaker
parity suite (`packages/data-plane/src/providers/breaker-redis.spec.ts`) gates on `REDIS_URL` and has
never executed in an automated context; (2) ts-jest runs transpile-only (`isolatedModules: true` in
`tsconfig.base.json`), so type-level breakage in spec files is invisible — three breaker spec files
import `NormalizedStreamEvent` from a nonexistent `./translate`, and `breaker-state-listener.spec.ts`
imports `ProviderCircuitOpenError` from `./breaker` (not exported there), which erases to `undefined`
and turns `rejects.toThrow(ProviderCircuitOpenError)` into `rejects.toThrow()` — a vacuous assertion;
(3) the invariant-12 behaviors implemented in `proxy-http.ts` (`await drain(res)` backpressure) and
`stream-drain.registry.ts` (drain-then-abort on shutdown) have zero test coverage because supertest
buffers whole responses — mid-stream disconnects and write backpressure never occur under it.

Constraints: pinned stack (Node 24 via `.nvmrc`, npm workspaces + Turborepo); e2e runs
`--runInBand` with `NODE_OPTIONS=--experimental-vm-modules`; dev infra is `docker-compose.dev.yml`
(postgres:16-alpine, redis:7-alpine); `jest-e2e.config.cjs` currently sets `forceExit: true` with a
comment admitting BullMQ workers linger after close.

## Goals / Non-Goals

**Goals:**
- Every push/PR runs the full Definition-of-done gate automatically, including the infra-backed
  suites that currently never run.
- Type-level integrity of *test* code is enforced (spec files are part of the safety net; a spec
  that doesn't typecheck can assert nothing).
- The spec-mandated drain / disconnect / backpressure scenarios get real regression coverage.
- The e2e runner surfaces leaked handles instead of masking them (`forceExit` removed).

**Non-Goals:**
- No production `src/` changes. The known E1.2 defect (drain deadline cannot terminate a
  write-blocked stream) is *not* fixed here, and no test asserts the behavior that defect breaks.
- No release automation, coverage thresholds, image builds, or dependency-update bots.
- No test parallelization changes (`--runInBand` stays).

## Decisions

1. **GitHub Actions, two jobs (`quality`, `e2e`), both with service containers where needed.**
   - `quality`: redis:7-alpine service; `npm ci` → `npm run build` → `npm run lint` →
     `npm run typecheck` → `npm test` (all four packages) with `REDIS_URL` exported so the
     data-plane parity suite executes here.
   - `e2e`: postgres:16-alpine + redis:7-alpine services (mirroring `docker-compose.dev.yml`
     credentials) → `npm ci` → `npm run test:e2e` (root script already builds first via turbo).
   - *Why two jobs:* fast unit signal in parallel with the slower e2e; the redis service on
     `quality` is deliberate — without it, our new loud-skip rule would fail the unit job.
   - *Alternatives:* one mega-job (slower feedback, considered and rejected); docker-compose in CI
     (service containers are simpler and health-checked natively).
   - Jobs run on `ubuntu-latest` (host-run steps), so service containers MUST publish their ports
     (`5432:5432`, `6379:6379`) and declare health `options` — without published ports a host-run
     job cannot reach them. Connection URLs are exported explicitly (`127.0.0.1` hosts) rather than
     relying on config defaults.
   - Node via `actions/setup-node` with `node-version-file: .nvmrc` and npm cache; jobs get
     `timeout-minutes` so a hang (post-`forceExit` removal) fails loudly instead of stalling.

2. **Typecheck = per-package `tsc --noEmit`, wired through turbo — and turbo env declarations for
   the test task.** turbo runs tasks in **strict env mode** (`turbo run test --dry=json` today
   reports `envMode: "strict"`, `env: []`): undeclared variables are stripped from child processes,
   so without wiring, the quality job's exported `CI`/`REDIS_URL` would never reach jest and the
   parity suite would *still* silently skip — with the skip potentially replayed from turbo's cache.
   The `test` task therefore declares `env: ["CI", "REDIS_URL"]`, which both forwards the values and
   folds them into the task hash (a local skip can never replay as a CI pass; fresh CI runners have
   no cache anyway).
   - Each package gets `"typecheck": "tsc --noEmit -p tsconfig.json"`; root gets
     `"typecheck": "turbo run typecheck"`; `turbo.json` gains a `typecheck` task with
     `dependsOn: ["^build"]` (cross-package imports resolve against built `dist` type declarations).
   - control-plane's `tsconfig.json` already includes `["src", "test"]`, so e2e specs are covered;
     the other packages' tsconfigs include their colocated `*.spec.ts`.
   - *Why not flip off `isolatedModules`/transpile-only in ts-jest:* full type-checking inside jest
     roughly doubles test wall-time and duplicates what one `tsc --noEmit` pass does better.

3. **Loud CI skip for the parity suite.** `breaker-redis.spec.ts` keeps its local warn+skip
   behavior, but when `process.env.CI` is set and `REDIS_URL` is missing it throws at module load
   with an actionable message. This encodes "the suite is expected to run in CI" (its own comment)
   as an enforced property rather than a hope.

4. **Fix the phantom imports rather than exempting spec files from typecheck.** The three
   `./translate` type imports become `../proxy/translate`; `ProviderCircuitOpenError` in
   `breaker-state-listener.spec.ts` imports from `./errors`. This is strictly a test-file fix and
   restores the intended strength of the open→skip assertion.

5. **Drain/backpressure tests run against a real listening server, not supertest.**
   A new e2e spec boots the Nest app on an ephemeral port (`app.listen(0)`) with the existing stub
   upstream and drives raw `node:http` clients:
   - *Determinism latches (all cases):* never race request startup — await an observable "first
     frame received" latch before triggering drain or destroying sockets (`pumpSse` registers with
     the drain registry only once handling begins, so draining too early tests nothing). The stub
     exposes teardown as an **awaitable promise** (not a polled counter), tracks its open sockets,
     and destroys them on close so `server.close()` cannot hang on a deliberately-paused connection;
     raw clients use dedicated agents that the test destroys in cleanup. Every wait is bounded.
   - *Drain:* start a stream against a slow-emitting stub model; after the first-frame latch,
     invoke the registry's `beforeApplicationShutdown()` (not awaited); assert a new `/v1` request
     gets the 503 drain-refusal in the caller's protocol shape; assert the in-flight stream still
     runs to `[DONE]`; assert the drain promise then resolves. A second case uses a never-finishing
     stub stream and asserts the deadline abort fires (short `streamDrainDeadlineMs` via config
     override), observed via the stub's awaitable teardown.
   - *Disconnect:* the default breaker threshold is 5, so "a follow-up request succeeds" cannot
     distinguish `neutral` from one wrongly-recorded `trip`. The harness injects a **threshold-1
     breaker over a recording `BreakerStore`** (both are existing DI seams in the e2e bootstrap):
     destroy the client socket only after the first-frame latch, then assert the stub upstream
     observed teardown, the recorded breaker outcome for the attempt is exactly `neutral`, no
     breaker-open notification fired, and a follow-up request is admitted (with threshold 1, any
     mis-recorded trip would open the breaker and fail it).
   - *Backpressure:* the stub's emission counter is only a sound observable if the stub itself
     honors socket backpressure — today `openaiStream` writes every frame synchronously, so its
     counter would race ahead while bytes park in stub/undici/kernel buffers. The stub's
     large-frame mode therefore **awaits its own `res.write() === false` → `'drain'`** between
     frames (≥64KiB padded frames to fill the buffer chain deterministically). Then: client stops
     reading → proxy's `pumpSse` parks in `await drain(res)` → the pull-based pipeline stops
     pulling → undici stops reading the stub socket → the stub's write stalls → its frame counter
     stops. Assert stall (no counter progress over a generous window) while paused, progress after
     the client resumes, and — as an end-state integrity check once the client reads to
     completion — every emitted frame was delivered in order. No mid-stall byte/frame-count
     assertions.
   - A colocated unit spec covers `StreamDrainRegistry` in isolation (register/deregister
     lifecycle, `isDraining` flip, deadline abort of stragglers) with a short injected deadline —
     the registry exposes only those primitives; deregister-on-error behavior lives in
     `handleInference` and is covered by the e2e cases above.
   - *Why e2e-level:* `pumpSse`'s `res.write`/`drain()` wiring only exists on a real socket;
     unit-mocking `ServerResponse` backpressure would test the mock.

6. **`forceExit` removal is empirical, test-side only.** Run the suite with `--detectOpenHandles`
   locally, fix each surfaced leak in test harnesses (`afterAll` closing BullMQ queues/workers,
   Redis duplicates, spawned apps), then delete `forceExit: true`. If any leak traces to production
   `src/` shutdown code, stop and flag it as its own change (per proposal Non-goals). The auth
   rate-limit timing tests get a unique key prefix per run only if `--detectOpenHandles`/repeat runs
   implicate them; otherwise untouched.

## Risks / Trade-offs

- [Typecheck debt is larger than the phantom imports] → a scouting `tsc --noEmit` pass found ~18
  pre-existing errors across control-plane test files (Node16-incompatible dynamic imports, unsafe
  row indexing, nullable-return mismatches). All are test-side and get fixed under task 1.3's
  inventory; if any error traces to production `src/`, stop and flag per Non-goals.
- [Backpressure test flakiness across OS buffer sizes] → large frames (≥64KiB) to fill kernel + Node
  buffers deterministically; a drain-aware stub so the observed counter reflects real socket
  backpressure; assert *stall vs. progress* of the stub counter over a generous window, never
  mid-stall byte counts; keep the case in the `--runInBand` e2e project.
- [Removing `forceExit` reveals a hang only in CI] → per-job `timeout-minutes` turns it into a
  visible failure; `--detectOpenHandles` pass happens before removal, not after.
- [Repo has no GitHub remote yet, so the workflow can't be exercised end-to-end] → validate YAML
  locally (parse + `actionlint` if available); the workflow uses only stock actions and the same
  npm scripts run locally, so drift risk is low. Accepted.
- [`tsc --noEmit` on the frontend (Solid JSX) may need its own settings] → the frontend tsconfig
  already builds under strict TS with Vite; if `--noEmit` needs a tweak it stays inside that
  package's tsconfig, not the shared base.
- [Redis service on the quality job adds ~5s startup] → acceptable; it is what makes the loud-skip
  rule satisfiable in both jobs.

## Migration Plan

Repo-infrastructure only: no deploy, no data. Rollback = revert the commit (workflow file, script
entries, config lines, test files). The `forceExit` removal is independently revertible if CI
exposes an unfixed leak.

## Open Questions

None blocking. (Whether GitHub branch protection *requires* the new checks is an org setting made
after the repo is published; out of scope here.)
