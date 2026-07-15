# notification-channels

## ADDED Requirements

### Requirement: Notification channel CRUD with encrypted config and tenant isolation

The system SHALL let an authenticated user manage `smtp` and `apprise` notification channels via a session-guarded API (list / create / get / update / delete), storing each channel's credentials **encrypted at rest** and never returning the decrypted config. Every access SHALL be ownership-scoped so one tenant cannot read or mutate another's channels by id (invariant 5).

#### Scenario: A channel stores its config encrypted and never exposes it

- WHEN a user creates an SMTP or Apprise channel with credentials
- THEN the stored config is encrypted at rest (the persisted blob is not plaintext) and the API response exposes only safe fields (kind, name, enabled, subscriptions, whether a config is set, last-test status) — never the password or token-bearing URL

#### Scenario: Channels are tenant-isolated

- WHEN user A requests, updates, or deletes a channel id owned by user B
- THEN the request is not found (no cross-tenant read or mutation)

### Requirement: SSRF validation on every notification egress

The system SHALL treat every server-reached notification destination as SSRF-sensitive (invariant 6, spec §11.2), validating the **resolved IP** under the **same policy shape as #4's provider guard**: **metadata / link-local / all hard ranges are blocked in every mode and are never allowlistable**; **loopback** is allowed **only in self-host** (the §11.2 local exception — a loopback SMTP relay or the Apprise sidecar), blocked in cloud; a **soft private** range is blocked unless a **port-bounded** `NOTIFY_ALLOWED_ENDPOINTS` entry permits it, in **both** modes (the operator opts a private relay/sidecar in explicitly). This is enforced for a **user SMTP host** (validated at create/update AND **at connect time** in the adapter, which connects to the pinned validated IP so a rebind can't redirect the socket), a **host-bearing Apprise target** (URL host **and** host-override params like `?smtp=` validated by scheme), and **`APPRISE_API_URL`** (its host validated at boot — gates construction of the delivery pipeline; the operator's own sidecar, so the delivery POST carries the `local` kind and the loopback exception applies at connect time). Because the Apprise sidecar performs the actual per-target connection, app-side validation is defense-in-depth: **in cloud mode an Apprise channel is additionally rejected unless the deployment attests the sidecar's egress is network-isolated** (`NOTIFY_APPRISE_EGRESS_CONFIRMED`); self-host allows it.

#### Scenario: A metadata / hard-range target is rejected in every mode

- WHEN a user adds an Apprise channel whose (host-bearing) target — via its host or a `?smtp=`/`?host=` override — or an SMTP channel whose host, resolves to a link-local/metadata (or other hard-range) address (in any mode)
- THEN the create/update is rejected (422) and no channel is stored

#### Scenario: Loopback is a self-host-only exception; private always needs an allowlist

- WHEN, **in self-host mode**, the operator adds a channel targeting their own **loopback** SMTP relay or Apprise sidecar (`127.0.0.1`)
- THEN the channel is accepted (the §11.2 local exception); the same loopback target in **cloud** is rejected (422)
- WHEN a channel targets a **private** (RFC1918) address with no matching port-bounded allowlist entry, in **either** mode
- THEN the create/update is rejected (422); it is accepted only once a `NOTIFY_ALLOWED_ENDPOINTS` entry permits that host+range+port

#### Scenario: Cloud Apprise requires attested sidecar egress isolation

- WHEN an Apprise channel is created in cloud mode without the sidecar-egress attestation
- THEN the create is rejected (self-host is unaffected)

#### Scenario: A private/metadata-resolving APPRISE_API_URL refuses boot

- WHEN `APPRISE_API_URL` resolves to a metadata/hard address (any mode), or to a private/loopback address that the mode+allowlist do not permit (e.g. a private address in cloud with no allowlist entry)
- THEN the application fails to boot with a clear error (the SSRF check gates construction of the delivery pipeline); a self-host **loopback** sidecar such as `http://127.0.0.1:8000` is accepted, and a private `http://apprise:8000` once allowlisted

### Requirement: Events are delivered asynchronously and failure-isolated

The system SHALL provide a `NotificationService.emit(event)` that fans an event out to the enabled, subscribed channels via a Redis-backed queue, **off the caller's path** — `emit` returns without awaiting delivery and never throws into the caller, so a producer or a budget check is never blocked (invariant 11), including when Redis is unavailable. A channel whose delivery fails SHALL be retried with bounded backoff and then **left failed and logged**; it MUST NOT stall delivery of other channels/events, the request path, or budget enforcement.

#### Scenario: Delivery never blocks the emitter

- WHEN a producer emits an event (including when Redis/queue is unavailable)
- THEN the emit call returns promptly without awaiting delivery and never throws into the caller

#### Scenario: A dead channel logs a failure without stalling others

- WHEN an event fans out to two channels and one (e.g. a dead webhook) fails delivery
- THEN that channel's delivery fails and is logged (no secret), retried within bounds, while the other channel still delivers, and nothing on the request/budget path is blocked

### Requirement: Events are de-duplicated per scope per window (accept-once)

The system SHALL de-duplicate events so that at most one event of a given type per scope is **accepted** within its window (BullMQ TTL-based deduplication keyed on a canonical `(type, scope)` id, independent of job retention), so a condition hovering at a threshold cannot spam channels. (External delivery is best-effort idempotent — the queue is at-least-once — so exact-once external send is not guaranteed.)

#### Scenario: Duplicate events within a window are accepted at most once

- WHEN the same event type for the same scope is emitted more than once within one window
- THEN it is accepted at most once (a single fan-out; subsequent duplicates within the window are dropped)

### Requirement: Delivery errors are sanitized (never leak secrets)

Delivery failures SHALL surface only fixed, sanitized error codes — never a raw mailer/HTTP error containing a host, recipient, URL, response body, or credential (invariant 8). Sanitized codes are what appears in logs, the queue's failure records, the channel's `last_test_status`, and API responses.

#### Scenario: A failed delivery never leaks a secret

- WHEN a delivery (or a test-send) fails with a channel that has a token-bearing URL or SMTP password
- THEN the recorded status, logs, queue job record, and API response contain only a sanitized code — the secret/host/recipient appears in none of them

### Requirement: Per-channel test-send records its status

The system SHALL provide a per-channel **test-send** that delivers a sample event directly (for inline feedback) and surfaces success or a sanitized failure, persisting `last_test_at` and `last_test_status` on the channel (spec §10.1).

#### Scenario: Test-send delivers and records the result

- WHEN a user triggers a test-send on a channel
- THEN a sample notification is delivered (or attempted), the result is returned inline, and `last_test_at`/`last_test_status` (success or `failed:<code>`) are persisted
