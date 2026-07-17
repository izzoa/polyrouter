## Context

Pure repo hygiene — no runtime behavior. `format:check` (`prettier --check .`) is **not** a CI gate
(ESLint is), so A-1's fix is scoped to the audit's literal ask: exclude the *generated* migration
artifacts (whose only prettier warnings are the two `meta/*.json` files). Broader pre-existing
prettier/eslint style drift across hand-written source is out of scope (the codebase's enforced style is
ESLint, which passes).

## Decisions

- **A-1:** ignore `packages/*/src/database/migrations/` wholesale — every file under it is
  drizzle-kit-generated (SQL + `meta/` snapshots/journal). Prettier-formatting generated output is
  pointless and risks desyncing the snapshots drizzle-kit maintains.
- **A-18:** `SECURITY.md` documents the private report route (GitHub Security Advisories / maintainer
  email), an ack SLA, and the by-design sensitive areas (SSRF, credential handling, tenant isolation,
  privacy) plus the loopback/`/metrics` posture. `CONTRIBUTING.md` documents Node 24 + Docker setup, the
  build/lint/typecheck/test commands, and the OpenSpec spec-driven flow + definition of done — matching
  what CLAUDE.md/spec.md already require, so contributors follow the real process.
- **A-20:** root `repository` uses the `OWNER/polyrouter` placeholder (matching `install.sh`'s
  `POLYROUTER_REPO` default) until the project publishes; corrected at publish time.

## Risks / Trade-offs

- The `repository` URL is a placeholder pre-publication; harmless and self-documenting.

## Migration Plan

None — docs/config only.
