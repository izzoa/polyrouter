---
'@polyrouter/shared': minor
'@polyrouter/data-plane': minor
'@polyrouter/control-plane': minor
'@polyrouter/frontend': minor
---

Scaffold the polyrouter monorepo. Turborepo + npm workspaces with the four packages (`shared`, `control-plane`, `data-plane`, `frontend`), strict TypeScript everywhere, an extensible fail-fast config framework (`PORT`, `BIND_ADDRESS` loopback default, `NODE_ENV`, `MODE`), an unauthenticated `/api/health` endpoint, single-port production serving of the SPA + API (with `npm start` forcing production mode), and the dev topology (Vite on :3000 proxying `/api`/`/v1` to :3001, CORS dev-only). The repo now builds, tests, and lints from a clean checkout.
