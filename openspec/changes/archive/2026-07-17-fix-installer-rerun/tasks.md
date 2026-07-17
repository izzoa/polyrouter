## 1. E13.1 — Detect a prior fetch install on re-run

- [x] 1.1 In `install.sh`, factor the archive download into a `fetch_src()` helper and harden its stage→swap to be failure-safe (explicit checks, keep `src.old` until the new tree lands, restore on a failed rename — POSIX errexit doesn't fire on the left of `&&`).
- [x] 1.2 Make the locate step three-way, keyed on a durable polyrouter-specific marker (`.polyrouter-install`): checkout (unchanged) → **fetch re-run** (`.polyrouter-install` at cwd → `require_env_or_bail`, reuse `./.env`, `fetch_src`, `SRC="src"`, **no `mkdir`/`cd`**) → fresh fetch (refuse an existing unmarked `./polyrouter`; else `mkdir polyrouter && cd`, write the marker, `fetch_src`). The marker (not a bare `src/docker-compose.yml`) prevents mistaking/clobbering an unrelated dir; a marker-without-`.env` fails rather than nesting or regenerating.
- [x] 1.3 Close the deleted-`.env` footgun in **both** modes: write a `.polyrouter-secrets-created` sentinel beside `.env` on generation, and refuse to regenerate when the sentinel exists but `.env` is missing (checkout mode had no marker). Add both sentinels to the generated + repo `.gitignore`. Verify `sh -n` / `dash -n`.

## 2. A-19 — Document the fetch-install compose command form

- [x] 2.1 In `README.md`, add a note that the `docker compose -p polyrouter-selfhost …` commands assume a checkout; a fetch install runs them from inside `polyrouter/` with `--env-file .env -f src/docker-compose.yml --project-directory src` (the manage command the installer prints).

## 3. Regression test + CI

- [x] 3.1 Add `test/install-rerun.test.sh`: stub `docker`/`curl` on `PATH`, fresh-install, re-run from inside `polyrouter/` (with a **distinct** re-run archive), and assert no `polyrouter/polyrouter/` nesting, a byte-identical `.env`, the marker written, `src/` actually **refreshed** to the new content, the **full** compose contract (`-p`/`--env-file ./.env`/`-f src/docker-compose.yml`/`--project-directory src`), and — the safety guards — that an **unrelated** dir (no marker) is NOT clobbered (nests instead), an existing **unrelated `./polyrouter/`** is refused, a **marker-without-`.env`** dir is refused (no regen, no nest), a **checkout re-run with a deleted `.env`** is refused (secrets sentinel), a **deleted `src/`** recovers in place, and a **parent-entry into an incomplete marked `./polyrouter/`** is refused. Confirm it fails against the pre-fix script and passes against the fix (20 assertions).
- [x] 3.2 Wire `sh test/install-rerun.test.sh` into the CI `quality` job (no services needed).

## 4. Verification & wrap-up

- [x] 4.1 `sh test/install-rerun.test.sh` green; `sh -n install.sh` clean; `npm run build` unaffected.
- [x] 4.2 Changeset (user-facing: self-host re-run no longer rotates secrets / nests).
- [x] 4.3 Update `TODOS.md` board + mark E13 ✅ (and A-19) in `FABLE_AUDIT.md` after archive.
