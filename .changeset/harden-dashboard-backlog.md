---
'@polyrouter/frontend': patch
---

Dashboard correctness & honesty fixes (A-26 … A-31).

- Onboarding no longer mints a duplicate provider on retry: it reuses the provider created for the attempt when the form is unchanged (matched by an input fingerprint, so a server-normalized base URL can't cause a false mismatch), and creates fresh when the form — including the credential — is edited. The retry identity is cleared on completion and sign-out.
- The create/add mutations (agent, provider, tier, rule) are now single-flight, so a double-submit can't create duplicates.
- Removed the inert "log bodies" toggle (the system is metadata-only by design and has no body-persistence mechanism); it's now a read-only "Metadata-only" assurance.
- The Agents page shows each agent's real 24h request count and spend (from the agent analytics breakdown), with `—` while unknown instead of a permanent placeholder; the stale "coming soon" copy is gone.
- The Settings/sidebar version is the real build version (injected from the package) instead of a fabricated `v0.4.1 · postgres 16 · redis 7`.
- The requests timeseries zero-fills empty buckets so the chart dips to zero over idle periods instead of drawing a line interpolated across the gap.
