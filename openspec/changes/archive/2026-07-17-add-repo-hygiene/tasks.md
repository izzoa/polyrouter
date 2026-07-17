## 1. Repo hygiene

- [x] 1.1 A-1: add `packages/*/src/database/migrations/` to `.prettierignore`; confirm `format:check` no longer flags the generated `meta/*.json`.
- [x] 1.2 A-18: add `SECURITY.md` (private disclosure route + sensitive-area map) and `CONTRIBUTING.md` (setup, build/test commands, OpenSpec workflow, definition of done).
- [x] 1.3 A-20: add a `repository` field to the root `package.json` (valid JSON; workspace `license` fields already aligned in E8).

## 2. Wrap-up

- [x] 2.1 `npm run build` unaffected; root `package.json` parses; `SECURITY.md`/`CONTRIBUTING.md` present.
- [x] 2.2 Update `TODOS.md` + mark A-1/A-18/A-20 ✅ in `FABLE_AUDIT.md` after archive.
