## MODIFIED Requirements

### Requirement: Per-channel test-send records its status

The system SHALL provide a per-channel **test-send** that delivers a sample event directly (for inline feedback) and surfaces success or a sanitized failure, persisting `last_test_at` and `last_test_status` on the channel (spec §10.1). The test-send route SHALL be **rate-limited per user** (a small number of sends per minute, across all of the caller's channels, via the shared atomic Redis window limiter), and the throttle SHALL be applied **before** any DNS/SMTP/Apprise work — so an authenticated (or stolen) session cannot loop it to spam recipients, hammer the Apprise sidecar, or tie up connections. Over the threshold the route SHALL return **429** and perform no delivery. A channel **update that changes the config** SHALL clear `last_test_status`/`last_test_at` (the prior result was for the old target/credentials, so a stale "success" must not linger); a metadata-only update (name/enabled/events) SHALL leave the result intact.

#### Scenario: Test-send delivers and records the result

- WHEN a user triggers a test-send on a channel
- THEN a sample notification is delivered (or attempted), the result is returned inline, and `last_test_at`/`last_test_status` (success or `failed:<code>`) are persisted

#### Scenario: The test-send route is throttled per user

- WHEN a user triggers more than the allowed number of test-sends within the window
- THEN further calls return `429` and open no SMTP session / Apprise POST, while a different user's test-sends (their own window) are unaffected

#### Scenario: A config change clears the stale test result

- WHEN a channel's config is updated (new target/credentials) after a prior test-send recorded `success`
- THEN `last_test_status`/`last_test_at` are cleared (null), so the UI does not show a stale success for the changed config; a metadata-only update (e.g. rename) keeps the prior result
