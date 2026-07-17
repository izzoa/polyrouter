# Security Policy

polyrouter is a self-hostable LLM router that sits between your agents and your LLM providers,
holding provider API keys and notification credentials. We take its security posture seriously.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via one of:

- **GitHub Security Advisories** — the "Report a vulnerability" button under the repository's
  **Security** tab (preferred; lets us collaborate on a fix privately).
- **Email** — send details to the maintainers (see the repository owner's profile). Encrypt with our
  public key if you have highly sensitive details.

Please include:

- a description of the issue and its impact,
- the affected version / commit and configuration (e.g. `MODE=selfhosted` vs cloud),
- reproduction steps or a proof of concept,
- any known mitigations.

We aim to acknowledge a report within **72 hours** and to provide a remediation timeline after triage.
We will credit reporters who wish to be named once a fix is released.

## Scope

In scope: the control plane and proxy (`packages/control-plane`, `packages/data-plane`), the SPA
(`packages/frontend`), the shared security utilities (`packages/shared`), the container image, and the
`install.sh` bootstrap.

Particularly sensitive areas, by design:

- **SSRF** — every server-fetched, user-supplied URL/host (provider `base_url`, Apprise/webhook targets,
  `APPRISE_API_URL`, SMTP host) is validated against private/loopback/link-local/metadata ranges,
  resolving the IP to defeat DNS rebinding. Loopback is permitted only for local providers under
  `MODE=selfhosted`.
- **Credential handling** — agent API keys are HMAC-SHA256 (prefix-indexed); session passwords use a
  slow hash; provider and notification-channel credentials are encrypted at rest (AES-256-GCM). Secrets
  are never logged and never returned by the API.
- **Tenant isolation** — every owned resource is ownership-scoped centrally.
- **Privacy** — metadata only by default; prompt/response bodies are never persisted without explicit
  opt-in.

## Operational note

`/api/health` and `/metrics` are unauthenticated by design (orchestration + Prometheus). The app
publishes on **loopback by default**; exposing it beyond loopback is a deliberate step to take **after**
claiming the admin account, behind a reverse proxy with TLS and access control. See the README's
"Claim the instance, then expose it" section.
