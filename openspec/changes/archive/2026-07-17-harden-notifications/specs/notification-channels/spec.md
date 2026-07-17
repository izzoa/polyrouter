## MODIFIED Requirements

### Requirement: SSRF validation on every notification egress

The system SHALL treat every server-reached notification destination as SSRF-sensitive (invariant 6, spec §11.2), validating the **resolved IP** under the **same policy shape as #4's provider guard**: **metadata / link-local / all hard ranges are blocked in every mode and are never allowlistable**; **loopback** is allowed **only in self-host** (the §11.2 local exception — a loopback SMTP relay or the Apprise sidecar), blocked in cloud; a **soft private** range is blocked unless a **port-bounded** `NOTIFY_ALLOWED_ENDPOINTS` entry permits it, in **both** modes (the operator opts a private relay/sidecar in explicitly). This is enforced for a **user SMTP host** (validated at create/update AND **at connect time** in the adapter, which connects to the pinned validated IP so a rebind can't redirect the socket), a **host-bearing Apprise target** (URL host **and** host-override params like `?smtp=` validated by scheme), and **`APPRISE_API_URL`** (its host validated at boot — gates construction of the delivery pipeline; the operator's own sidecar, so the delivery POST carries the `local` kind and the loopback exception applies at connect time). Because the Apprise sidecar performs the actual per-target connection, app-side validation is defense-in-depth: **in cloud mode an Apprise channel is additionally rejected unless the deployment attests the sidecar's egress is network-isolated** (`NOTIFY_APPRISE_EGRESS_CONFIRMED`); self-host allows it. The SMTP adapter's connect-time refusal and IP pinning SHALL be covered by a regression test, so removing the connect-time SSRF assertion or the IP pinning fails loudly.

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

#### Scenario: SMTP delivery refuses a blocked host at connect time and pins the socket to the validated IP

- WHEN `deliverSmtp` is invoked with a host that resolves to a metadata/link-local (hard-range) address, in either mode
- THEN it rejects with a sanitized `smtp_host_blocked` **before any socket is opened** (no SMTP transport is constructed), leaking no host/recipient/credential
- WHEN `deliverSmtp` is invoked with a host that resolves to a permitted address
- THEN the SMTP connection is opened to the **resolved IP** (pinned, defeating a post-validation DNS rebind), with the certificate validated against the original hostname (SNI preserved)

### Requirement: Per-channel test-send records its status

The system SHALL provide a per-channel **test-send** that delivers a sample event directly (for inline feedback) and surfaces success or a sanitized failure, persisting `last_test_at` and `last_test_status` on the channel (spec §10.1). The test-send route SHALL be **rate-limited per user** (a small number of sends per minute, across all of the caller's channels, via the shared atomic Redis window limiter), and the throttle SHALL be applied **before** any DNS/SMTP/Apprise work — so an authenticated (or stolen) session cannot loop it to spam recipients, hammer the Apprise sidecar, or tie up connections. Over the threshold the route SHALL return **429** and perform no delivery.

#### Scenario: Test-send delivers and records the result

- WHEN a user triggers a test-send on a channel
- THEN a sample notification is delivered (or attempted), the result is returned inline, and `last_test_at`/`last_test_status` (success or `failed:<code>`) are persisted

#### Scenario: The test-send route is throttled per user

- WHEN a user triggers more than the allowed number of test-sends within the window
- THEN further calls return `429` and open no SMTP session / Apprise POST, while a different user's test-sends (their own window) are unaffected
