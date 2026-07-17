# Contributing to polyrouter

Thanks for your interest in improving polyrouter — a self-hostable, OpenAI- and Anthropic-compatible
LLM router/gateway. This guide covers the local setup and the conventions the project follows.

## Prerequisites

- **Node.js 24.x LTS** (see `.nvmrc`) and npm 10–11.
- **Docker** + Compose v2 (for Postgres 16 + Redis 7, used by the e2e suites).

## Getting started

```bash
npm install
docker compose -f docker-compose.dev.yml up -d   # Postgres + Redis for tests/dev
npm run dev                                       # control-plane (watch) + frontend (Vite)
```

## Build & test

```bash
npm run build         # shared → control-plane → frontend (Turborepo)
npm run lint          # ESLint (the style/quality gate)
npm run typecheck     # strict tsc --noEmit, test files included
npm test              # unit suites (Jest for backend, Vitest for frontend/shared)
npm run test:e2e -w packages/control-plane   # e2e (needs Postgres + Redis up)
```

Some Redis-backed suites are gated on `REDIS_URL`; export it (e.g.
`REDIS_URL=redis://127.0.0.1:6379`) to run them.

## How we work — spec-driven with OpenSpec

**No feature code lands without an approved change proposal.** Work is delivered as OpenSpec changes:

1. `openspec new change <slug>` — scaffold the change.
2. Write `proposal.md`, `design.md`, `tasks.md`, and the spec deltas under `openspec/changes/<slug>/`,
   reviewed against [`spec.md`](./spec.md) and the invariants in [`CLAUDE.md`](./CLAUDE.md).
3. `openspec validate <slug> --strict`.
4. Implement `tasks.md` in order.
5. `openspec archive <slug> --yes` (merges the deltas into `openspec/specs/`).

Keep changes **small and single-capability**. The full architecture, data model, and acceptance criteria
live in [`spec.md`](./spec.md); the always-on operating rules and non-negotiable invariants live in
[`CLAUDE.md`](./CLAUDE.md). Read the relevant section before proposing.

## Definition of done

- `tasks.md` complete; code matches the approved delta.
- Tests written/updated and green — including the relevant **contract / SSRF / tenant-isolation /
  cost-immutability** checks when the change touches those areas.
- A migration generated if the schema changed (`npm run db:generate -w packages/control-plane`);
  `npm run build`, lint, and strict typecheck all pass (no `any` escapes).
- A changeset added for any user-facing change (`npx changeset`).
- Spec/deltas updated and the change archived.

## Commit & PR conventions

- Conventional, present-tense commit messages that explain **why**.
- One capability per PR/change.
- Never commit secrets or a `.env` file.

## Reporting security issues

Please follow [`SECURITY.md`](./SECURITY.md) — do not open a public issue for vulnerabilities.
