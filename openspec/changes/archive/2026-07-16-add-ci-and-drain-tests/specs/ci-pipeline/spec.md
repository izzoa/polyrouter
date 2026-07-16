# ci-pipeline — delta for add-ci-and-drain-tests

## ADDED Requirements

### Requirement: Continuous integration gates every push and pull request

A GitHub Actions workflow SHALL run on every push and pull request and SHALL fail the check unless
all of the following pass: `npm run build`, `npm run lint`, `npm run typecheck`, the unit test
suites of all four workspaces, and the control-plane e2e suite against real PostgreSQL 16 and
Redis 7 service containers. The workflow SHALL pin Node from `.nvmrc` and SHALL bound every job
with a timeout so a hang is a visible failure, never a stalled run.

#### Scenario: A pull request runs the full Definition-of-done gate

- **WHEN** a commit is pushed or a pull request is opened
- **THEN** CI runs build, lint, typecheck, and all unit suites, and runs the control-plane e2e
  suite against provisioned postgres:16 and redis:7 services
- **AND** a failure in any step fails the CI check

#### Scenario: A hang is a failure, not a stall

- **WHEN** any CI job exceeds its configured timeout (for example because a test leaks a handle
  and the runner never exits)
- **THEN** the job is terminated and reported as failed

### Requirement: Environment-gated suites run loudly in CI

Suites that self-gate on provisioned infrastructure (today: the real-Redis breaker parity suite in
`packages/data-plane`) SHALL execute in CI with their infrastructure provided. When the `CI`
environment variable is set and the required environment is missing, the suite SHALL fail with an
actionable error naming the missing variable — it MUST NOT silently skip. Local runs without the
environment SHALL keep the existing warn-and-skip behavior.

#### Scenario: The breaker parity suite executes in CI

- **WHEN** the data-plane unit tests run in CI
- **THEN** `REDIS_URL` is provided by the workflow and the real-Redis parity/concurrency suite
  executes rather than being skipped

#### Scenario: A missing gate variable fails loudly in CI

- **WHEN** the data-plane unit tests run with `CI` set but `REDIS_URL` undefined
- **THEN** the run fails with an error naming `REDIS_URL` instead of warn-and-skip

#### Scenario: Local runs keep the soft skip

- **WHEN** a developer runs the data-plane unit tests locally without `REDIS_URL` and without `CI`
- **THEN** the parity suite skips with the existing console warning and the run stays green

### Requirement: Typechecking covers test files

The repository SHALL provide a `typecheck` script (root and per workspace) that runs
`tsc --noEmit` over each package's `tsconfig.json`, including colocated `*.spec.ts` files and the
control-plane `test/` directory, and CI SHALL run it. This closes the gap left by ts-jest's
transpile-only mode, under which spec files with unresolvable imports still execute (with erased
types) and can assert vacuously.

#### Scenario: A phantom import in a spec file fails the pipeline

- **WHEN** a test file imports a module or export that does not exist (for example a type import
  from a nonexistent `./translate`, or a named class from a module that does not export it)
- **THEN** `npm run typecheck` exits non-zero and CI fails

#### Scenario: The tree typechecks clean at head

- **WHEN** `npm run typecheck` runs on the repository after this change
- **THEN** it passes — in particular the three breaker spec files import `NormalizedStreamEvent`
  from the real `../proxy/translate` module and `ProviderCircuitOpenError` from `./errors`, so the
  circuit-open assertion in `breaker-state-listener.spec.ts` again matches the concrete error class

### Requirement: Stream drain, disconnect, and backpressure have automated coverage

The invariant-12 behaviors specified by the inference-proxy capability — the requirement
"In-flight streams drain on shutdown" and the scenario "A slow or disconnecting client
backpressures the upstream" (under "Streaming with end-to-end backpressure and a mid-stream commit
boundary") — SHALL be covered by automated tests executed in CI: a unit spec for `StreamDrainRegistry` and integration coverage that
drives a real listening HTTP server (supertest buffers full responses and cannot exercise these
paths). The behavior requirements themselves remain in the inference-proxy spec; this requirement
governs their regression coverage.

#### Scenario: Drain refuses new work and lets in-flight streams finish

- **WHEN** shutdown drain begins while a streamed completion is in flight
- **THEN** a test asserts that a new `/v1` request is refused with the 503 drain error in the
  caller's protocol shape, that the in-flight stream still runs to its terminator, and that the
  drain completes once the stream deregisters

#### Scenario: A straggler stream is aborted at the drain deadline

- **WHEN** a registered stream is still active when the configured drain deadline elapses
- **THEN** a test asserts its `AbortController` is aborted

#### Scenario: A mid-stream client disconnect tears down the upstream and stays breaker-neutral

- **WHEN** a streaming client destroys its socket mid-response
- **THEN** a test asserts the stub upstream observed the request teardown and the provider's
  circuit breaker recorded no failure (a follow-up request is admitted normally)

#### Scenario: A slow client stalls upstream consumption instead of buffering unboundedly

- **WHEN** a streaming client stops reading while the stub upstream still has frames to emit
- **THEN** a test asserts the stub's emission progress stalls while the client is paused and
  resumes when the client reads again

### Requirement: The e2e runner exits cleanly without forceExit

The control-plane e2e jest configuration SHALL NOT rely on `forceExit`; every suite SHALL release
its resources (queues, workers, Redis connections, spawned apps) so the process exits on its own.

#### Scenario: The suite completes and the process exits unaided

- **WHEN** `npm run test:e2e -w packages/control-plane` completes with `forceExit` removed
- **THEN** the jest process exits green without hanging and without jest reporting that it forced
  the exit
