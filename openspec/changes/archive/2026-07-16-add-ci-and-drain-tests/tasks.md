# Tasks: add-ci-and-drain-tests

## 1. Typecheck wiring + phantom-import fixes (fix lands with the check that catches it)

- [x] 1.1 Add `"typecheck": "tsc --noEmit -p tsconfig.json"` to `packages/{shared,data-plane,control-plane,frontend}/package.json`; verify each package's `tsconfig.json` includes its colocated `*.spec.ts` (and control-plane `test/`); adjust includes only where a spec/test file is not covered
- [x] 1.2 Add a `typecheck` task to `turbo.json` (`dependsOn: ["^build"]`, no outputs) and `"typecheck": "turbo run typecheck"` to the root `package.json`; **also declare `"env": ["CI", "REDIS_URL"]` on the existing `test` task** — turbo runs strict env mode and otherwise strips both vars from jest, silently defeating the loud-skip rule (and folding them into the hash prevents a cached local skip replaying as a pass)
- [x] 1.3 Fix the phantom imports: `NormalizedStreamEvent` from `'../proxy/translate'` (not `'./translate'`) in `breaker-caller-abort.spec.ts`, `breaker-open.spec.ts`, `breaker-state-listener.spec.ts`; `ProviderCircuitOpenError` from `'./errors'` (not `'./breaker'`) in `breaker-state-listener.spec.ts`
- [x] 1.4 Run `npm run typecheck` at root and fix the full inventory it surfaces (~18 pre-existing errors, ~14 beyond the breaker files — known examples: Node16-incompatible dynamic import in `test/budgets/budget-proxy.e2e-spec.ts:148`, unsafe row indexing in `test/auth/auth.e2e-spec.ts:339`, nullable-return mismatches in `test/proxy/cascade-routing.e2e-spec.ts:260`) — **test files only**; a production `src/` type error = stop and flag as its own change
- [x] 1.5 Confirm `npm test -w packages/data-plane` still passes and that `breaker-state-listener.spec.ts`'s `rejects.toThrow(ProviderCircuitOpenError)` now asserts the real class (temporarily throw a different error locally to see it fail, then revert)

## 2. Loud CI gate for the real-Redis parity suite

- [x] 2.1 In `packages/data-plane/src/providers/breaker-redis.spec.ts`: when `process.env.CI` is set and `REDIS_URL` is undefined, throw at module load with an actionable message naming `REDIS_URL`; keep the existing warn+skip for local runs
- [x] 2.2 Verify both behaviors with the package's own jest config: `CI=1 npm test -w packages/data-plane -- breaker-redis --runInBand` without `REDIS_URL` fails with the message; `REDIS_URL=redis://127.0.0.1:6379 npm test -w packages/data-plane` executes (does not skip) the parity suite against the dev Redis

## 3. StreamDrainRegistry unit coverage

- [x] 3.1 Add `packages/control-plane/src/proxy/stream-drain.registry.spec.ts` with an injected short deadline, covering the registry's actual primitives: register/deregister lifecycle; `isDraining()` flips on `beforeApplicationShutdown()`; drain resolves promptly once all registered streams deregister; a still-registered straggler's `AbortController` is aborted when the deadline elapses (deregister-on-error is `handleInference` behavior — covered by section 4, not asserted here)
- [x] 3.2 Run `npm test -w packages/control-plane` — new spec green without touching production code

## 4. Stream lifecycle e2e (real listening server; supertest cannot exercise these paths)

- [x] 4.1 Extend `packages/control-plane/test/proxy/stub-upstream.ts` additively: (a) per-request teardown exposed as an **awaitable promise** (not a polled counter); (b) a large-frame streaming mode (≥64KiB padded SSE frames) that **awaits its own `res.write() === false` → `'drain'`** between frames and records a yielded-frame counter — required for the counter to be a sound backpressure observable; (c) track open sockets and destroy them in `close()` so a paused connection cannot hang teardown
- [x] 4.2 Add `packages/control-plane/test/proxy/stream-lifecycle.e2e-spec.ts` booting the app on an ephemeral port (`app.listen(0)`) with a short configured `streamDrainDeadlineMs`, driving raw `node:http` clients with dedicated agents destroyed in cleanup; every wait bounded; all cases latch on "first frame received" before acting
- [x] 4.3 Drain case: with one stream in flight (past the first-frame latch), invoke the registry's `beforeApplicationShutdown()` unawaited → assert a new `/v1/chat/completions` request gets the 503 drain refusal in OpenAI error shape; the in-flight stream still reaches `[DONE]`; the drain promise resolves after deregistration
- [x] 4.4 Deadline case: with a never-terminating stub stream in flight, assert the drain promise resolves at the deadline and the upstream teardown promise settles (straggler aborted)
- [x] 4.5 Disconnect case: inject a **threshold-1 breaker over a recording `BreakerStore`** via the existing e2e DI seams; destroy the client socket after the first-frame latch → assert the stub upstream's teardown promise settles, the recorded breaker outcome is exactly `neutral`, no breaker-open notification fired, and an immediately following request to the same provider is admitted and serves (threshold 1 ⇒ any mis-recorded trip would open the breaker and fail this)
- [x] 4.6 Backpressure case: client pauses reading while the drain-aware stub still has large frames to emit → assert the stub's yielded-frame counter stalls (no progress across a generous window), resumes once the client reads again, and — after the client reads to completion — every emitted frame arrived in order (end-state integrity only; no mid-stall counts)
- [x] 4.7 Run the new spec in isolation and in the full e2e run (build first); tune frame sizes/windows for determinism

## 5. Remove forceExit and fix the leaks it masks (test-side only)

- [x] 5.1 Build first (`npm run build`), then run `npm run test:e2e -w packages/control-plane -- --detectOpenHandles` with `forceExit` still on; inventory every reported open handle and its owning suite
- [x] 5.2 Fix each leak in the test harnesses (`afterAll`: close BullMQ queues/workers before `app.close()`, quit duplicated Redis clients, kill spawned processes); if any leak traces to production `src/` shutdown code, **stop and flag it as its own change** (proposal Non-goals)
- [x] 5.3 Remove `forceExit: true` (and its comment) from `packages/control-plane/jest-e2e.config.cjs`; with a fresh build, run the full e2e suite ≥3 consecutive times — green, exits unaided, no jest force-exit warning; only if the auth rate-limit tests flake in these runs, make them timing-robust (unique key prefix per run)

## 6. CI workflow

- [x] 6.1 Add `.github/workflows/ci.yml`: trigger on push + pull_request; jobs on `ubuntu-latest` with `timeout-minutes`; `actions/setup-node` with `node-version-file: .nvmrc` + npm cache. `quality` job: redis:7-alpine service with **published port `6379:6379` and health `options`**, `REDIS_URL=redis://127.0.0.1:6379` + `CI` in env → `npm ci` → `npm run build` → `npm run lint` → `npm run typecheck` → `npm test`. `e2e` job: postgres:16-alpine (**`5432:5432`**, credentials matching `docker-compose.dev.yml`: polyrouter/polyrouter/polyrouter) + redis:7-alpine (**`6379:6379`**), both health-checked, explicit `127.0.0.1` connection URLs exported → `npm ci` → `npm run test:e2e` (root script — builds first)
- [x] 6.2 Validate the workflow locally: YAML parses; `actionlint` if available; every referenced npm script exists and passes locally in the same order

## 7. Definition of done

- [x] 7.1 Full gate green locally: `npm run build`, `npm run lint`, `npm run typecheck`, `npm test -w` each package (data-plane with `REDIS_URL` set), root `npm run test:e2e`
- [x] 7.2 `git status` clean of strays; no production `src/` diffs; no migration; no changeset (not user-facing); `openspec validate add-ci-and-drain-tests --type change --strict --no-interactive` passes
