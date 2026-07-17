## ADDED Requirements

### Requirement: The repository ships a security policy, a contributor guide, and complete metadata

The repository SHALL include a top-level `SECURITY.md` documenting a **private** vulnerability-disclosure
route (not a public issue) and the by-design sensitive areas (SSRF validation, credential handling,
tenant isolation, metadata-only privacy, and the loopback/`/metrics` exposure posture), and a top-level
`CONTRIBUTING.md` documenting local setup (Node 24 + Docker), the build/lint/typecheck/test commands, and
the OpenSpec spec-driven workflow with its definition of done. The root `package.json` SHALL carry a
`repository` field, and machine-generated migration artifacts SHALL be excluded from formatting checks so
`format:check` is not failed by generated output.

#### Scenario: an adopter finds the disclosure route and contributor guide

- **WHEN** someone evaluates or contributes to the repository
- **THEN** `SECURITY.md` gives a private disclosure route and `CONTRIBUTING.md` gives the setup, commands, and change workflow; the root `package.json` declares its `repository`; and `format:check` does not fail on drizzle-generated migration JSON
