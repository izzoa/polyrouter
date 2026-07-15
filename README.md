# polyrouter

Self-hostable **LLM router / gateway** — one OpenAI- and Anthropic-compatible endpoint that
routes each request to the right model across your providers, with explicit-first routing,
fallbacks, spend limits, and metadata-only cost tracking. No markup, no third-party proxy:
your keys, your box.

> Under active spec-driven development — see [`spec.md`](./spec.md) (reference spec),
> [`TODOS.md`](./TODOS.md) (build plan), and [`openspec/`](./openspec/) (change history).

## Development

Requirements: **Node.js 24.x** (see `.nvmrc`), npm 10–11, Docker (for the dev database).

```bash
# 1. dependencies
npm ci

# 2. dev infrastructure (PostgreSQL 16 + Redis 7 — required from the database change onward)
docker compose -f docker-compose.dev.yml up -d

# 3. run: control-plane API on :3001, dashboard (Vite) on :3000
npm run dev
```

Useful commands (see `CLAUDE.md` for the full set):

| Command                                      | What it does                                        |
| -------------------------------------------- | --------------------------------------------------- |
| `npm run dev`                                | control-plane (watch) + frontend together           |
| `npm run build`                              | production build via Turborepo                      |
| `npm start`                                  | production server (SPA + API + proxy, one port)     |
| `npm test -w packages/<pkg>`                 | unit tests for one package                          |
| `npm run test:e2e -w packages/control-plane` | e2e suites (needs the dev compose up)               |
| `npm run db:generate` / `npm run db:migrate` | Drizzle migrations (also run automatically on boot) |
| `npm run lint` / `npm run format`            | ESLint / Prettier                                   |

MIT licensed.
