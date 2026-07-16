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
if [ -f docker-compose.yml ] && [ -f Dockerfile ] && [ -f package.json ]; then
  say "using this checkout as the build context"
  SRC="."
  ENV_FILE="./.env"
else
  [ "$REPO" != "OWNER/polyrouter" ] || fail "no public repository is published yet — set POLYROUTER_REPO=<owner>/<repo>, or clone the repo and run ./install.sh from the checkout"
  command -v curl >/dev/null 2>&1 || fail "curl is required"
  command -v tar >/dev/null 2>&1 || fail "tar is required"
  mkdir -p "$DIR"
  cd "$DIR"
  ENV_FILE="./.env"
  say "fetching polyrouter source ($REPO@$REF)..."
  STAGE="$(mktemp -d "${TMPDIR:-/tmp}/polyrouter-src.XXXXXX")"
  trap 'rm -rf "$STAGE"' EXIT
  # codeload's bare form accepts branches, tags, and commit SHAs alike.
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" |
    tar -xz -C "$STAGE" --strip-components=1 ||
    fail "could not download $REPO@$REF"
  # Stage → swap: no stale files from previously deleted paths; .env is outside.
  rm -rf src.new && mv "$STAGE" src.new
  trap - EXIT
  rm -rf src && mv src.new src
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

if [ -f "$ENV_FILE" ]; then
  say "keeping the existing .env (secrets are never rotated: rotating the"
  say "encryption keys would orphan stored provider/channel credentials)"
else
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
  # .env must never end up in a fork/PR by accident.
  [ -f .gitignore ] || printf '.env\npolyrouter/\nsrc/\n' >.gitignore
fi

# --- boot ----------------------------------------------------------------------
say "building and starting the stack (first build takes a few minutes) ..."
docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$SRC/docker-compose.yml" --project-directory "$SRC" up -d --build

PORT="$(grep -E '^POLYROUTER_PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || true)"
say ""
say "polyrouter is starting at http://localhost:${PORT:-3001}"
say "the FIRST account you sign up becomes the admin — claim it now."
say "manage the stack with: docker compose -p $PROJECT --env-file $ENV_FILE -f $SRC/docker-compose.yml --project-directory $SRC <up|stop|logs>"
