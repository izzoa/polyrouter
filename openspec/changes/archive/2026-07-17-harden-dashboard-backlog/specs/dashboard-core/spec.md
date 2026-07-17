## ADDED Requirements

### Requirement: Create/add mutations are single-flight and onboarding never duplicates

Every dashboard mutation that CREATES a resource (create agent, add provider, create tier,
create rule, and the onboarding connect-provider step) SHALL be **single-flight**: a second
invocation while one is in flight SHALL be ignored (guarded on the form's `busy` flag), so a
double-click or an impatient re-submit cannot POST twice and create duplicate resources. The
onboarding flow, which creates a provider and then performs follow-up steps (model sync, tier
assignment), SHALL NOT mint a **second** provider when a later step fails and the user retries:
it SHALL reuse the provider already created for that onboarding attempt and resume the
follow-up steps from there.

#### Scenario: A double-submit creates one resource, not two

- WHEN a create/add mutation is invoked twice in rapid succession (the second before the first
  completes)
- THEN only one create request is sent and one resource is created — the second invocation is a
  no-op while the first is in flight

#### Scenario: Retrying onboarding after a downstream failure reuses the created provider

- WHEN onboarding creates a provider and then a follow-up step (model sync or tier assignment)
  fails, and the user retries the step
- THEN the retry reuses the already-created provider (resuming the follow-up steps) rather than
  creating a second provider for the same onboarding attempt

### Requirement: Dashboard controls reflect real state, never inert or fabricated display

Dashboard controls and displayed facts SHALL correspond to real, honest state. A control SHALL
NOT present an affordance for a capability that does not exist or that it does not actually
effect: because the system stores **metadata only** and has no prompt/response-body persistence
mechanism (invariant 8), the settings surface SHALL NOT offer an interactive "log bodies" toggle
that changes nothing — it SHALL instead state, read-only, that bodies are never stored. Displayed
version/build information SHALL be the instance's **real** value (injected at build), not a
hard-coded placeholder, and the dashboard SHALL NOT display backend component versions (e.g.
database/cache versions) it cannot actually observe.

#### Scenario: No inert body-logging toggle

- WHEN a user views the settings surface
- THEN there is no interactive toggle implying prompt/response bodies can be logged; the surface
  states read-only that the system is metadata-only (bodies are never stored)

#### Scenario: The version shown is real, not fabricated

- WHEN the settings surface displays the instance version
- THEN it shows the real build version (injected from the package version) and does not display a
  hard-coded version string or backend component versions the browser cannot know
