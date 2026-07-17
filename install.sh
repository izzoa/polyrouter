#!/bin/sh
# polyrouter one-line self-host installer (#22, spec §13).
#
#   curl -fsSL https://raw.githubusercontent.com/OWNER/polyrouter/main/install.sh | sh
#
# What it does: verifies docker + Compose v2, fetches ONE source archive at a
# single ref (branch, tag, or commit SHA — pin with POLYROUTER_REF; the compose
# file is taken from inside the archive, so compose and build context are always
# the same commit), generates the required secrets into a mode-600 .env that
# lives OUTSIDE the replaceable source tree and is NEVER overwritten, and boots
# the stack. Re-running is safe: it refreshes the source and re-applies the
# stack, preserving .env.
#
# Prefer to inspect first? Clone the repo and run `./install.sh` from the
# checkout — it then uses your working tree and downloads nothing.
set -eu

# NOTE: no public repository exists yet — set POLYROUTER_REPO=<owner>/<repo>
# (or run from a checkout, which needs no download) until the project publishes.
REPO="${POLYROUTER_REPO:-OWNER/polyrouter}"
REF="${POLYROUTER_REF:-main}"
PROJECT="polyrouter-selfhost"
DIR="polyrouter"
# A durable, polyrouter-specific marker written into a fetch-install root. A re-run
# is recognized ONLY by this marker (plus .env), so the installer never mistakes an
# unrelated directory that merely happens to contain `src/docker-compose.yml` for one
# of its own installs and refreshes (replaces) that directory's `src/`.
MARKER=".polyrouter-install"

say() { printf '%s\n' "$*"; }
fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "docker is not installed (https://docs.docker.com/get-docker/)"
docker info >/dev/null 2>&1 || fail "the docker daemon is not reachable (is Docker running? do you need sudo?)"
docker compose version >/dev/null 2>&1 || fail "docker Compose v2 is required ('docker compose', not the legacy docker-compose binary)"

# --- locate or fetch the source tree ------------------------------------------
# .env deliberately lives NEXT TO the source tree, never inside it: the source
# is replaced wholesale on re-runs and must never take the secrets with it.

# Download the pinned archive into ./src via a clean stage→swap (no stale files
# from previously-deleted paths). The caller has already positioned cwd; .env
# lives beside ./src and is untouched here.
fetch_src() {
  [ "$REPO" != "OWNER/polyrouter" ] || fail "no public repository is published yet — set POLYROUTER_REPO=<owner>/<repo>, or clone the repo and run ./install.sh from the checkout"
  command -v curl >/dev/null 2>&1 || fail "curl is required"
  command -v tar >/dev/null 2>&1 || fail "tar is required"
  say "fetching polyrouter source ($REPO@$REF)..."
  STAGE="$(mktemp -d "${TMPDIR:-/tmp}/polyrouter-src.XXXXXX")"
  trap 'rm -rf "$STAGE"' EXIT
  # codeload's bare form accepts branches, tags, and commit SHAs alike.
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" |
    tar -xz -C "$STAGE" --strip-components=1 ||
    fail "could not download $REPO@$REF"
  # Stage → swap, keeping the previous tree as `src.old` until the new one is in
  # place, so an interrupted swap can be recovered rather than losing `src` (the
  # steps are explicit, not `&&`-chained, since POSIX errexit does not fire on the
  # left of `&&`). `.env` lives outside `src/` and is never touched here.
  rm -rf src.new
  mv "$STAGE" src.new || fail "could not stage refreshed source"
  trap - EXIT
  rm -rf src.old
  if [ -d src ]; then
    mv src src.old || fail "could not set aside the previous source"
  fi
  if mv src.new src; then
    rm -rf src.old
  else
    [ -d src.old ] && mv src.old src # restore the working tree on a failed swap
    fail "could not install refreshed source"
  fi
}

# An incomplete install (our marker but no .env — e.g. the first fetch failed
# before secrets were written) must NEVER be silently completed by regenerating
# secrets (that would rotate keys against any volumes and orphan credentials) nor
# nested over. Refuse and tell the operator. Used at both the cwd and the ./$DIR
# entry points below.
require_env_or_bail() {
  [ -f .env ] || fail "'$(pwd)' is a polyrouter install directory ($MARKER present) but .env is missing — restore it from backup, or delete this directory to start fresh; refusing to regenerate secrets (that would orphan stored credentials)."
}

if [ -f docker-compose.yml ] && [ -f Dockerfile ] && [ -f package.json ]; then
  # A working-tree checkout — build from here, download nothing.
  say "using this checkout as the build context"
  SRC="."
  ENV_FILE="./.env"
elif [ -f "$MARKER" ]; then
  # A re-run from INSIDE a prior fetch install (identified by OUR marker, never a
  # bare src/docker-compose.yml — see MARKER). Reuse the existing .env and refresh
  # src/ IN PLACE — do NOT mkdir/cd, which would nest polyrouter/polyrouter/, miss
  # the .env, and rotate secrets against the live volumes (a fresh POSTGRES_PASSWORD
  # can't auth an already-initialized database; a rotated PROVIDER_CREDENTIAL_KEY
  # orphans every stored credential). Keyed on the marker (not a present src/), so a
  # swap interrupted mid-refresh still recovers here instead of nesting.
  require_env_or_bail
  say "reusing this install (refreshing src/, keeping the existing .env)"
  ENV_FILE="./.env"
  fetch_src
  SRC="src"
else
  # A fresh fetch install into ./$DIR. Refuse to adopt an EXISTING directory of that
  # name that is not one of OUR installs (no marker) — fetch_src would replace its
  # src/. An existing dir that IS ours is entered and refreshed (idempotent).
  if [ -e "$DIR" ] && [ ! -f "$DIR/$MARKER" ]; then
    fail "a '$DIR' directory already exists here and is not a polyrouter install (no $MARKER marker) — remove it or run from another directory"
  fi
  mkdir -p "$DIR"
  cd "$DIR"
  ENV_FILE="./.env"
  if [ -f "$MARKER" ]; then
    require_env_or_bail # entering an existing install of ours — keep its .env
  else
    printf 'polyrouter fetch install — re-run marker; do not delete\n' >"$MARKER"
  fi
  fetch_src
  SRC="src"
fi

# --- secrets (.env) — generated ONCE, never rotated ----------------------------
gen_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -vN 32 -An -tx1 /dev/urandom | tr -d ' \n'
  fi
}

# A mode-independent sentinel recording that secrets were once generated HERE.
# Guards both fetch and checkout modes: if it exists but .env does not, .env was
# removed after a real install — regenerating would rotate keys against the
# existing volumes (breaking DB auth, orphaning stored credentials), so we refuse.
SECRETS_SENTINEL="$(dirname "$ENV_FILE")/.polyrouter-secrets-created"

if [ -f "$ENV_FILE" ]; then
  say "keeping the existing .env (secrets are never rotated: rotating the"
  say "encryption keys would orphan stored provider/channel credentials)"
else
  [ -f "$SECRETS_SENTINEL" ] && fail ".env is missing but secrets were previously generated here — restore .env from backup rather than regenerate (new keys would break DB auth and orphan stored credentials against the existing volumes). To deliberately start over, delete $SECRETS_SENTINEL (and the stack's volumes)."
  say "generating secrets into $ENV_FILE (600) ..."
  umask 077
  # Temp file BESIDE the destination so the rename is atomic on one filesystem.
  TMP_ENV="$ENV_FILE.tmp.$$"
  trap 'rm -f "$TMP_ENV"' EXIT
  {
    printf '# polyrouter self-host secrets — generated %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '# NEVER commit this file. Key-rotation caveat: see README (Self-hosting).\n'
    printf 'BETTER_AUTH_SECRET=%s\n' "$(gen_hex)"
    printf 'API_KEY_HMAC_SECRET=%s\n' "$(gen_hex)"
    printf 'PROVIDER_CREDENTIAL_KEY=%s\n' "$(gen_hex)"
    printf 'NOTIFY_CREDENTIALS_SECRET=%s\n' "$(gen_hex)"
    printf 'POSTGRES_PASSWORD=%s\n' "$(gen_hex)"
    printf '\n# Exposure (claim the admin account BEFORE exposing):\n'
    printf '# POLYROUTER_HOST=0.0.0.0\n'
    printf '# POLYROUTER_PORT=3001\n'
    printf '# APP_URL=https://polyrouter.example.com\n'
  } >"$TMP_ENV"
  mv "$TMP_ENV" "$ENV_FILE"
  trap - EXIT
  # Record that secrets exist here, so a later run with a deleted .env refuses to
  # regenerate rather than rotating keys against the live volumes.
  : >"$SECRETS_SENTINEL"
  # .env must never end up in a fork/PR by accident.
  [ -f .gitignore ] || printf '.env\n.polyrouter-install\n.polyrouter-secrets-created\npolyrouter/\nsrc/\n' >.gitignore
fi

# --- boot ----------------------------------------------------------------------
say "building and starting the stack (first build takes a few minutes) ..."
docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$SRC/docker-compose.yml" --project-directory "$SRC" up -d --build

PORT="$(grep -E '^POLYROUTER_PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || true)"
say ""
say "polyrouter is starting at http://localhost:${PORT:-3001}"
say "the FIRST account you sign up becomes the admin — claim it now."
say "manage the stack with: docker compose -p $PROJECT --env-file $ENV_FILE -f $SRC/docker-compose.yml --project-directory $SRC <up|stop|logs>"
