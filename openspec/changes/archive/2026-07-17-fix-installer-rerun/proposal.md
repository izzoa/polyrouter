## Why

A plausible operator upgrade action silently rotates a live stack's secrets → outage (FABLE_AUDIT
E13). `install.sh`'s "prior install" check only recognizes a **working-tree checkout**
(`docker-compose.yml && Dockerfile && package.json` at cwd). But a **fetch** install creates
`polyrouter/{src/,.env}` (compose lives under `src/`), so re-running the one-liner from **inside** that
`polyrouter/` directory falls into the fetch branch, which `mkdir polyrouter && cd polyrouter` —
nesting `polyrouter/polyrouter/`, finding no `.env` there, and **generating brand-new secrets**. It
then boots compose under the same fixed project name (`polyrouter-selfhost`) against the **existing**
volumes:

- a new `POSTGRES_PASSWORD` can't authenticate an already-initialized database (the password is
  init-only) → app crash-loop;
- a rotated `PROVIDER_CREDENTIAL_KEY` orphans every stored provider/channel credential.

This defeats the packaging spec's idempotency guarantee ("an existing `.env` is NEVER overwritten or
rotated").

## What Changes

- **E13.1** In the locate step, add a branch that recognizes a prior fetch install at cwd
  (`src/docker-compose.yml` **and** `.env` present) and treats it as the root: reuse the existing
  `./.env` and refresh `src/` **in place** (no `mkdir`/`cd`, so no nesting and no secret rotation). The
  download logic is factored into a `fetch_src()` helper shared by the fresh-install and re-run paths.
- **A-19 (folded in)** Document in the README that the `docker compose -p polyrouter-selfhost …`
  commands assume a checkout; a fetch install runs them from inside `polyrouter/` with
  `--env-file .env -f src/docker-compose.yml --project-directory src` — the exact manage command the
  installer prints on completion.

## Capabilities

### Modified Capabilities

- `packaging`: `install.sh` is idempotent for a **fetch** install too — re-running from inside the
  created `polyrouter/` directory reuses the existing `.env` (byte-identical, secrets never rotated) and
  refreshes `src/` in place, without nesting `polyrouter/polyrouter/`.

## Impact

- **Code:** `install.sh` (locate branch + `fetch_src()` helper), `README.md` (A-19 note),
  `.github/workflows/ci.yml` (run the new shell test in the quality job).
- **Tests:** a POSIX shell regression test (`test/install-rerun.test.sh`) that stubs `docker`/`curl`,
  performs a fresh fetch install, re-runs from inside `polyrouter/`, and asserts **no nesting**, a
  **byte-identical `.env`**, a refreshed `src/`, and that compose boots from `src/docker-compose.yml`.
  Proven to fail against the pre-fix script (the nesting assertion) and pass against the fix. No
  migration, no schema change, no app code touched.
- Backlog A-19 resolved here. Changeset: user-facing (self-host operators).
