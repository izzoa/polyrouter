## Context

Docs-and-config-only change (no runtime code). The one accuracy-critical piece is the `spec.md` §12
env refresh: `spec.md` is CLAUDE.md's reference-that-wins, so it must be regenerated from the actual
`registerConfig(...)` schemas, not hand-approximated.

## Goals / Non-Goals

**Goals:** a legal license grant; a discoverable "connect an agent" path; a `spec.md` §12 that matches
the config registry; operator-visible sharp edges; a compose allowlist that passes every registered var.

**Non-Goals:** any runtime behavior change; SECURITY.md/CONTRIBUTING.md and the other A-20..A-24 backlog.

## Decisions

- **Single source of truth for §12 and the compose allowlist:** enumerate every `registerConfig` schema
  key across `packages/*/src` (excluding DI-token string constants and internal `DEFAULT_*`/`MAX_*`
  constants), with its Zod default and whether it is required-in-production (no default + no dev
  fallback). §12 is grouped by namespace (core/auth/proxy/routing/budgets/pricing/notifications/
  observability); the compose block appends the registered-but-missing keys as bare pass-throughs.
- **LICENSE holder:** the repository author (`Anthony Izzo`), year 2026, standard MIT text; the root
  `package.json` already declares MIT, the four workspaces are aligned.
- **README connect-agent** uses the real contract (`poly_` prefix, `x-polyrouter-tier`,
  `/v1/chat/completions` + `/v1/messages`, `model:"auto"`), reinforcing invariant 1 (explicit is the
  reliable core; auto/tier degrade).
- **Stale-value fixes in §12:** drop the cloud-graduation-only `EMBEDDING_MODEL_PATH`/`CONTROL_PLANE_URL`
  (not in the baseline build) and correct `ROUTING_AUTO_LAYERS` (code default is `structural`, not
  `explicit,structural`).

## Risks / Trade-offs

- **[§12 drifts again]** — mitigated by generating it from the registry now and pointing the README at
  it as the exhaustive list; future config changes should update §12 in the same change (the existing
  sync rule).
- **[LICENSE holder]** — attributed to the repo author; adjust if the project later assigns copyright to
  an org (A-21 owner sweep).

## Migration Plan

None (docs/config). Rollback is a revert; the compose change only widens the pass-through allowlist
(unset vars stay unset).

## Open Questions

None.
