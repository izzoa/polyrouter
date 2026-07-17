## Context

`install.sh` supports two source modes: a **checkout** (build from the working tree, download nothing)
and a **fetch** install (download a pinned archive into `polyrouter/src/`, with `.env` generated beside
it at `polyrouter/.env`). `.env` deliberately lives *outside* the replaceable `src/` tree so a source
refresh never carries the secrets away. The bug is purely in the *locate* step: it recognizes a
checkout but not a re-run positioned inside a prior fetch install.

## Decisions

### D1 — A third locate branch for "re-run inside a fetch install"

The locate `if` becomes three-way, keyed on a **durable, polyrouter-specific marker file**
(`.polyrouter-install`) that a fresh fetch install writes into its root:

1. **Checkout** — `docker-compose.yml && Dockerfile && package.json` at cwd → `SRC="."`, no download.
2. **Fetch re-run (new)** — `.polyrouter-install && .env` at cwd → reuse `./.env`, `fetch_src`,
   `SRC="src"`. Crucially **no `mkdir`/`cd`**, so the refresh happens in place with no nesting.
3. **Fresh fetch** — else → `mkdir polyrouter && cd polyrouter`, **write the marker**, `fetch_src`,
   `SRC="src"`.

Branch 1 is checked first, so a checkout never matches branch 2. Branch 2 is keyed on OUR marker (not a
bare `src/docker-compose.yml`, which any project could have) — so an unrelated directory is **never**
mistaken for a polyrouter install and never has its `src/` replaced. The marker deliberately does **not**
require a present `src/`, so a swap interrupted mid-refresh is recognized here and *recovers* rather than
nesting. Two destructive edges the marker design would otherwise open are closed explicitly:

- **An existing, unrelated `./polyrouter/` target.** Branch 3 refuses (`fail`) when `./$DIR` already
  exists without our marker, instead of `mkdir -p`-adopting it and letting `fetch_src` replace its
  `src/`. An existing `./$DIR` that *is* ours is entered and refreshed idempotently.
- **A marked-but-`.env`-less directory** (an interrupted first install, or a deleted `.env`). Both
  branch 2 (re-run from inside) and branch 3 (entering our `./$DIR`) call `require_env_or_bail`, which
  **fails with guidance** rather than nesting or silently regenerating secrets — the installer cannot
  tell "first fetch failed before secrets" from "someone deleted a live `.env`", and regenerating the
  latter would rotate keys against live volumes, so it refuses either way. When `.env` is present, the
  existing `[ -f "$ENV_FILE" ]` guard keeps it untouched (secrets never rotated).

### D2 — Factor the download into `fetch_src()`

The archive download (repo/curl/tar preflight → `mktemp` stage → `curl | tar --strip-components=1` →
stage-swap into `./src`) is identical for branches 2 and 3, so it moves into a `fetch_src()` function
that operates on the current directory. Branch 3 `cd`s into `polyrouter/` first; branch 2 runs it in
place. The `trap`/`STAGE` cleanup semantics are unchanged (POSIX `trap … EXIT` is script-scoped, and
`fetch_src` clears its own trap before returning, before the later `.env` block sets its own).

### D3 — A dedicated marker, not a bare `src/docker-compose.yml`, is the identity

The audit's first-cut condition (`src/docker-compose.yml && .env`) is unsafe: those are common paths, so
running the piped one-liner from an unrelated project that has them would treat it as a polyrouter
install and `fetch_src` would `rm -rf` and replace that project's `src/`. The marker
(`.polyrouter-install`, written only by *our* fresh install) is an unambiguous, polyrouter-specific
identity that no unrelated tree carries. Since no public repository is published yet, there is **no
legacy install base** to migrate, so requiring the marker outright is safe (no compat shim needed). The
swap is also hardened (see D2b) so an interrupted refresh cannot silently lose `src/`.

### D3b — A mode-independent secrets sentinel closes the deleted-`.env` footgun

The marker fixes fetch mode, but the same "regenerate secrets against live volumes" hazard exists in
**checkout** mode too: a checkout that already booted `polyrouter-selfhost`, then lost its `.env`, would
regenerate on re-run. So the secrets block writes a `.polyrouter-secrets-created` sentinel *beside*
`.env` after generating it, and — in either mode — **refuses to generate** when that sentinel exists but
`.env` does not (fail with guidance to restore from backup or explicitly delete the sentinel + volumes
to start over). This makes the spec's "`.env` is NEVER overwritten or rotated" guarantee hold for both
install modes. Both sentinels are added to the generated (and the repo's committed) `.gitignore`.

### D2b — The stage→swap is failure-safe

The download installs via explicit, individually-checked steps (POSIX errexit does **not** fire on the
left of `&&`, so the old `rm -rf src.new && mv …` couldn't be trusted to abort): stage into `src.new`,
then move the previous `src` aside to `src.old`, then rename `src.new → src`; on a failed final rename,
restore `src.old`. The previous tree survives until the new one is in place, so an interruption leaves a
recoverable `src.old`/`src.new` rather than an absent `src` — and even a fully-lost `src` re-refreshes on
the next run because branch 2 keys on the marker, not on a present `src`.

### D4 — A stubbed shell regression test + CI wiring

`install.sh` ends by invoking `docker compose … up`, and fetch mode calls `curl`, so the test shims
`docker` (info/compose-version succeed; compose invocations are logged) and `curl` (emits a fixture
archive) on `PATH`, with `POLYROUTER_REPO` set so the "no public repo" guard passes. It does a fresh
fetch install, re-runs from inside `polyrouter/`, and asserts no nesting, a byte-identical `.env`, a
present `src/`, and a compose boot from `src/docker-compose.yml`. It is wired into the CI `quality` job
(no services needed). Verified to fail on the pre-fix script (nesting) and pass on the fix.

## Risks / Trade-offs

- **Branch-2 false positive is closed by the marker.** Only a directory carrying our
  `.polyrouter-install` marker (which only our fresh install writes) is treated as an install to refresh,
  so an unrelated project's `src/` is never touched — it falls to branch 3 and nests a fresh install in a
  subdirectory instead. (This corrects the earlier "coincidental `src/docker-compose.yml`" hazard.)
- **Manual verification still recommended** for a real Docker round-trip; the shell test covers the
  filesystem/secret-preservation logic (no nesting, byte-identical `.env`, actual `src/` refresh, full
  compose arg contract, and the unrelated-dir guard), not an actual container boot.

## Migration Plan

None — installer script + docs + a test only. No app code, schema, or runtime change.

## Open Questions

- Should a fetch re-run also `git`-less-diff the refreshed `src/` to warn on local edits? No — `src/` is
  explicitly the replaceable tree; operators are told not to edit it. Out of scope.
