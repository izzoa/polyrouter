# Project: polyrouter

**polyrouter** is a self-hostable, open-source **LLM router / gateway**: one OpenAI- and Anthropic-compatible endpoint between a user's AI agents and their LLM providers, with explicit-first routing, fallbacks, spend limits, and metadata-only cost/token/latency recording.

This file is the constitution pointer. The two sources of truth it defers to:

- [`spec.md`](../spec.md) — the full reference spec (architecture, data model, routing design, acceptance criteria §15). **The spec wins on any specific detail.**
- [`CLAUDE.md`](../CLAUDE.md) — operating rules: tech stack (pinned), repository layout, the 12 non-negotiable invariants, build order, commands, definition of done.

Work plan: [`TODOS.md`](../TODOS.md) — the spec broken into individually proposable OpenSpec changes, each run through: propose → verify against spec → codex review (unison `clink`) → apply → archive.

## Conventions that aren't in the spec

- **Branding:** the spec's Manifest-branded examples are replaced consistently — agent API key prefix `poly_…` (not `mnfst_…`), tier header `x-polyrouter-tier` (not `x-manifest-tier`), product strings `polyrouter`. (Spec §16 forbids reusing reference branding.)
- **Stack (pinned in CLAUDE.md; don't re-litigate):** TypeScript strict, Node 24.x LTS, NestJS 11, Drizzle (not TypeORM), PostgreSQL 16, Redis, Better Auth, SolidJS + Vite + uPlot, Turborepo + npm workspaces, Docker single-container distribution.
- **Process:** no feature code without an approved OpenSpec change; one capability ≈ one proposal; small changes in the TODOS.md dependency order; the ⛔ review gate after the Layer-0 proxy is mandatory.
