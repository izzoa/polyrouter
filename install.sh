#!/bin/sh
# polyrouter one-line self-host installer (#22, spec §13).
#
#   curl -fsSL https://raw.githubusercontent.com/izzoa/polyrouter/main/install.sh | sh
#
#   # Pin to an exact commit (recommended — reproducible, supply-chain-safe):
#   curl -fsSL https://raw.githubusercontent.com/izzoa/polyrouter/main/install.sh \
#     | POLYROUTER_REF=<commit-sha> sh
#
#   # Skip the local build and run a published image instead:
#   curl -fsSL .../install.sh | POLYROUTER_IMAGE=ghcr.io/izzoa/polyrouter:0.8.1 sh
#
# Verifies docker + Compose v2, fetches ONE source archive at a single ref (the
# compose file comes from inside the archive, so compose and build context are
# always the same commit), generates the required secrets into a mode-600 .env
# that lives OUTSIDE the replaceable source tree and is NEVER overwritten, then
# builds (or pulls) and boots the stack. Re-running is safe: it refreshes the
# source and re-applies the stack, preserving .env.
#
# Run `./install.sh --help` for flags and environment overrides. Prefer to
# inspect first? Clone the repo and run `./install.sh` from the checkout — it
# uses your working tree and downloads nothing.
set -eu

# --- configuration -------------------------------------------------------------
# The canonical repository. Override with POLYROUTER_REPO=<owner>/<repo> to install
# from a fork (a checkout needs no download and ignores this).
REPO="${POLYROUTER_REPO:-izzoa/polyrouter}"
REF="${POLYROUTER_REF:-main}"
PROJECT="polyrouter-selfhost"
DIR="polyrouter"
# A durable, polyrouter-specific marker written into a fetch-install root. A re-run
# is recognized ONLY by this marker (plus .env), so the installer never mistakes an
# unrelated directory that merely happens to contain `src/docker-compose.yml` for one
# of its own installs and refreshes (replaces) that directory's `src/`.
MARKER=".polyrouter-install"

# --- output (color only on a TTY; honors NO_COLOR — https://no-color.org) ------
if [ -z "${NO_COLOR:-}" ] && [ -t 1 ]; then
  C_G="$(printf '\033[32m')"; C_Y="$(printf '\033[33m')"; C_DIM="$(printf '\033[2m')"; C_OFF="$(printf '\033[0m')"
else
  C_G=''; C_Y=''; C_DIM=''; C_OFF=''
fi
if [ -z "${NO_COLOR:-}" ] && [ -t 2 ]; then C_R="$(printf '\033[31m')"; C_ROFF="$(printf '\033[0m')"; else C_R=''; C_ROFF=''; fi

say()  { printf '%s\n' "$*"; }
ok()   { printf '%s%s%s\n' "$C_G" "$*" "$C_OFF"; }
warn() { printf '%swarning:%s %s\n' "$C_Y" "$C_OFF" "$*"; }
fail() { printf '%serror:%s %s\n' "$C_R" "$C_ROFF" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
polyrouter self-host installer

Usage:
  ./install.sh                       install / refresh and start the stack
  ./install.sh --uninstall           stop & remove the stack (KEEPS data volumes)
  ./install.sh --uninstall --purge   also DELETE the data volumes (Postgres+Redis)
                            [--yes]   skip the confirmation prompt
  ./install.sh --help                show this help

Environment overrides:
  POLYROUTER_REPO    source repo for fetch installs     (default: izzoa/polyrouter)
  POLYROUTER_REF     branch, tag, or commit SHA to pin  (default: main)
  POLYROUTER_IMAGE   pull this published image instead of building from source,
                     e.g. ghcr.io/izzoa/polyrouter:0.8.1 — skips the local build
  POLYROUTER_HOST    host interface to publish on       (default: 127.0.0.1)
  POLYROUTER_PORT    host port                          (default: 3001)
  NO_COLOR           disable colored output

Docs: https://github.com/izzoa/polyrouter#self-hosting
EOF
}

# Run docker compose against this install's project/env/compose file. Omits
# --env-file when .env is absent (e.g. an --uninstall after .env was removed).
compose() {
  if [ -f "$ENV_FILE" ]; then
    docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$SRC/docker-compose.yml" --project-directory "$SRC" "$@"
  else
    docker compose -p "$PROJECT" -f "$SRC/docker-compose.yml" --project-directory "$SRC" "$@"
  fi
}

# Best-effort: is a host TCP port already listening? Returns non-zero (assume
# free) when no probing tool is available — Docker will still surface a conflict.
port_in_use() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$1" >/dev/null 2>&1
  else
    return 1
  fi
}

# Best-effort low-disk warning. NOTE: measures the CURRENT filesystem, not
# necessarily Docker's storage (Linux /var/lib/docker, or the Desktop VM on
# macOS), so it only warns — never blocks.
check_disk() {
  avail_kb="$(df -Pk . 2>/dev/null | awk 'NR==2 {print $4}')"
  case "${avail_kb:-}" in
    '' | *[!0-9]*) return 0 ;; # unparseable — skip silently
  esac
  [ "$avail_kb" -lt 3145728 ] &&
    warn "low disk space here (~$((avail_kb / 1024)) MB free) — a build + images + Postgres volume needs a few GB."
  return 0
}

# Confirm a data-destroying action against the terminal even when stdin is a
# pipe (curl | sh). No terminal → demand an explicit --yes instead of guessing.
confirm_destructive() {
  if [ -r /dev/tty ]; then
    printf 'Type the project name "%s" to confirm data deletion: ' "$1" >/dev/tty
    IFS= read -r _ans </dev/tty || return 1
    [ "$_ans" = "$1" ]
  else
    fail "no terminal available to confirm — re-run with --yes to delete data non-interactively"
  fi
}

# --uninstall [--purge|--volumes|-v] [--yes|-y]
do_uninstall() {
  _purge=0
  _yes=0
  for a in "$@"; do
    case "$a" in
      --purge | --volumes | -v) _purge=1 ;;
      --yes | -y) _yes=1 ;;
      *) fail "unknown --uninstall option: $a (use --purge and/or --yes)" ;;
    esac
  done
  # Locate an existing install WITHOUT fetching or creating anything.
  if [ -f docker-compose.yml ] && [ -f Dockerfile ] && [ -f package.json ]; then
    SRC="."
  elif [ -f "$MARKER" ] && [ -f src/docker-compose.yml ]; then
    SRC="src"
  elif [ -f "$DIR/$MARKER" ] && [ -f "$DIR/src/docker-compose.yml" ]; then
    cd "$DIR" || fail "could not enter '$DIR'"
    SRC="src"
  else
    fail "no polyrouter install found here — run --uninstall from a checkout, the install directory, or its parent"
  fi
  ENV_FILE="./.env"
  [ -f "$ENV_FILE" ] || warn ".env not found here — 'down' may fail on compose variable checks; if so, remove leftovers with 'docker ps' / 'docker rm'."
  if [ "$_purge" -eq 1 ]; then
    warn "this DELETES the polyrouter data volumes (Postgres + Redis) — all data is lost."
    [ "$_yes" -eq 1 ] || confirm_destructive "$PROJECT" || fail "aborted — nothing removed"
    compose down -v || fail "'docker compose down -v' failed"
    ok "polyrouter and its data volumes were removed."
  else
    compose down || fail "'docker compose down' failed"
    ok "polyrouter stopped and removed. Data volumes kept — re-run install.sh to start again, or '--uninstall --purge' to delete the data."
  fi
  exit 0
}

# Download the pinned archive into ./src via a clean stage→swap (no stale files
# from previously-deleted paths). The caller has already positioned cwd; .env
# lives beside ./src and is untouched here.
fetch_src() {
  command -v tar >/dev/null 2>&1 || fail "tar is required"
  say "fetching polyrouter source ($REPO@$REF)..."
  STAGE="$(mktemp -d "${TMPDIR:-/tmp}/polyrouter-src.XXXXXX")"
  trap 'rm -rf "$STAGE" "$STAGE.tgz"' EXIT
  url="https://codeload.github.com/$REPO/tar.gz/$REF" # bare form accepts branch, tag, or SHA
  # Download to a file THEN extract: POSIX sh has no `pipefail`, so a piped
  # `curl | tar` reports only tar's status and can mask a failed or truncated
  # download. Retry transient network failures; fall back to wget if no curl.
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --retry-connrefused --retry-delay 2 --connect-timeout 20 --max-time 300 \
      -o "$STAGE.tgz" "$url" || fail "could not download $REPO@$REF"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --tries=3 --timeout=30 -O "$STAGE.tgz" "$url" || fail "could not download $REPO@$REF"
  else
    fail "need curl or wget to download the source (or clone the repo and run ./install.sh from the checkout)"
  fi
  tar -xzf "$STAGE.tgz" -C "$STAGE" --strip-components=1 ||
    fail "could not extract $REPO@$REF (corrupt or truncated archive)"
  rm -f "$STAGE.tgz"
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

gen_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -vN 32 -An -tx1 /dev/urandom | tr -d ' \n'
  fi
}

# --- argument dispatch ---------------------------------------------------------
case "${1:-}" in
  -h | --help | help) usage; exit 0 ;;
  --uninstall | '') : ;; # empty = normal install; --uninstall handled post-preflight
  -*) fail "unknown option: $1 (try --help)" ;;
esac

# --- preflight -----------------------------------------------------------------
command -v docker >/dev/null 2>&1 || fail "docker is not installed (https://docs.docker.com/get-docker/)"
docker info >/dev/null 2>&1 || fail "the docker daemon is not reachable (is Docker running? do you need sudo?)"
docker compose version >/dev/null 2>&1 || fail "docker Compose v2 is required ('docker compose', not the legacy docker-compose binary)"

if [ "${1:-}" = "--uninstall" ]; then
  shift
  do_uninstall "$@" # exits
fi

check_disk

# --- locate or fetch the source tree ------------------------------------------
# .env deliberately lives NEXT TO the source tree, never inside it: the source
# is replaced wholesale on re-runs and must never take the secrets with it.
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
  mkdir -p "$DIR" || fail "could not create the '$DIR' directory"
  cd "$DIR" || fail "could not enter the '$DIR' directory"
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
# A mode-independent sentinel recording that secrets were once generated HERE.
# Guards both fetch and checkout modes: if it exists but .env does not, .env was
# removed after a real install — regenerating would rotate keys against the
# existing volumes (breaking DB auth, orphaning stored credentials), so we refuse.
SECRETS_SENTINEL="$(dirname "$ENV_FILE")/.polyrouter-secrets-created"

if [ -f "$ENV_FILE" ]; then
  FRESH_INSTALL=0
  say "keeping the existing .env (secrets are never rotated: rotating the"
  say "encryption keys would orphan stored provider/channel credentials)"
else
  FRESH_INSTALL=1
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

# --- port preflight ------------------------------------------------------------
# POLYROUTER_PORT wins if exported; else the .env value; else the default.
PORT="${POLYROUTER_PORT:-$(grep -E '^POLYROUTER_PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || true)}"
PORT="${PORT:-3001}"
MANAGE="docker compose -p $PROJECT --env-file $ENV_FILE -f $SRC/docker-compose.yml --project-directory $SRC"

# Skip the check when our own stack is already running (it legitimately holds the
# port); otherwise a bound port means another process — fail early and clearly.
STACK_UP="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null || true)"
if [ -z "$STACK_UP" ] && port_in_use "$PORT"; then
  fail "port $PORT is already in use on this host (no polyrouter stack is running) — set POLYROUTER_PORT to a free port, or stop what's using it."
fi

# --- boot ----------------------------------------------------------------------
if [ -n "${POLYROUTER_IMAGE:-}" ]; then
  say "pulling published image $POLYROUTER_IMAGE (skipping the local build) ..."
  docker pull "$POLYROUTER_IMAGE" || fail "could not pull $POLYROUTER_IMAGE (is the package public? you may need 'docker login ghcr.io')"
  compose up -d
else
  say "building and starting the stack (first build takes a few minutes) ..."
  compose up -d --build
fi

# --- health check --------------------------------------------------------------
# Confirm the app actually answers before declaring success — a container that
# crash-loops on boot must not be reported as a clean start. (Skipped without curl.)
if command -v curl >/dev/null 2>&1; then
  printf 'waiting for polyrouter to answer on http://localhost:%s ' "$PORT"
  i=0
  until curl -fs -o /dev/null "http://localhost:$PORT/api/health" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge 40 ]; then
      say ""
      warn "not answering after ~2m — it may still be migrating, or failing to boot."
      say "container status:"
      compose ps || true
      say "logs:  $MANAGE logs -f app"
      break
    fi
    printf '.'
    sleep 3
  done
  if [ "$i" -lt 40 ]; then
    say ""
    ok "polyrouter answered — it's up."
  fi
fi

# --- done ----------------------------------------------------------------------
say ""
ok "polyrouter: http://localhost:$PORT"
if [ "$FRESH_INSTALL" -eq 1 ]; then
  say "the FIRST account you sign up becomes the admin — claim it now."
else
  say "refreshed and restarted — your admin account and data are unchanged."
fi
say "${C_DIM}manage:${C_OFF} $MANAGE <up|stop|logs|ps>"
say "${C_DIM}remove:${C_OFF} re-run this installer with --uninstall (add --purge to delete data)"
