#!/bin/sh
# E13.1 regression test for install.sh idempotency: a re-run from INSIDE a prior
# fetch install must NOT nest polyrouter/polyrouter/, must keep .env byte-identical
# (never rotate the secrets against the live volumes), and must boot compose from
# the refreshed src/. Docker + the network fetch are stubbed, so this needs no
# daemon and no repository — run with `sh test/install-rerun.test.sh`.
set -eu

REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
INSTALL="$REPO_ROOT/install.sh"
[ -f "$INSTALL" ] || { echo "FAIL: cannot find install.sh at $INSTALL" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/polyrouter-install-test.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

STUBBIN="$WORK/stubbin"
DOCKER_LOG="$WORK/docker.log"
mkdir -p "$STUBBIN"
: >"$DOCKER_LOG"

# --- stub `docker`: info/compose-version succeed; log the compose invocations ---
cat >"$STUBBIN/docker" <<STUB
#!/bin/sh
case "\$1" in
  info) exit 0 ;;
  compose)
    shift
    case "\$1" in version) exit 0 ;; esac
    printf '%s\n' "compose \$*" >>"$DOCKER_LOG"
    exit 0 ;;
esac
exit 0
STUB
chmod +x "$STUBBIN/docker"

# --- build a fake source archive (top-level dir → --strip-components=1) ---------
# `make_archive <sentinel>` bakes a unique marker into docker-compose.yml so a
# refresh is observable (a re-run must overwrite src/ with the newer content).
make_archive() {
  rm -rf "$WORK/polyrouter-main"
  mkdir -p "$WORK/polyrouter-main"
  printf 'services: {}\n# %s\n' "$1" >"$WORK/polyrouter-main/docker-compose.yml"
  printf 'FROM scratch\n' >"$WORK/polyrouter-main/Dockerfile"
  printf '{"name":"polyrouter"}\n' >"$WORK/polyrouter-main/package.json"
  ( cd "$WORK" && tar -czf archive.tgz polyrouter-main )
}
make_archive "SENTINEL-FIRST"

# --- stub `curl`: emit the fixture archive regardless of args ------------------
cat >"$STUBBIN/curl" <<STUB
#!/bin/sh
cat "$WORK/archive.tgz"
STUB
chmod +x "$STUBBIN/curl"

PATH="$STUBBIN:$PATH"
export PATH
export POLYROUTER_REPO="stub/repo"

pass=0
fail=0
check() { # desc, condition already evaluated by caller via if
  if [ "$1" = ok ]; then pass=$((pass + 1)); printf '  ok  %s\n' "$2"
  else fail=$((fail + 1)); printf 'FAIL  %s\n' "$2" >&2; fi
}

# --- 1) fresh fetch install into $WORK/run ------------------------------------
mkdir -p "$WORK/run"
( cd "$WORK/run" && sh "$INSTALL" >/dev/null 2>&1 )

ROOT="$WORK/run/polyrouter"
[ -f "$ROOT/.env" ] && check ok "fresh install created polyrouter/.env" || check no "fresh install created polyrouter/.env"
[ -f "$ROOT/src/docker-compose.yml" ] && check ok "fresh install placed compose under src/" || check no "fresh install placed compose under src/"
[ -f "$ROOT/.polyrouter-install" ] && check ok "fresh install wrote the re-run marker" || check no "fresh install wrote the re-run marker"
grep -q SENTINEL-FIRST "$ROOT/src/docker-compose.yml" && check ok "fresh src/ has the first-archive content" || check no "fresh src/ has the first-archive content"

BEFORE="$(cksum <"$ROOT/.env")"

# --- 2) re-run from INSIDE the fetch install; the archive has NEW content ------
make_archive "SENTINEL-REFRESHED"
: >"$DOCKER_LOG"
( cd "$ROOT" && sh "$INSTALL" >/dev/null 2>&1 )

# no nested polyrouter/polyrouter/
[ ! -e "$ROOT/polyrouter" ] && check ok "re-run did NOT nest polyrouter/polyrouter/" || check no "re-run did NOT nest polyrouter/polyrouter/"
# .env byte-identical (secrets never rotated)
AFTER="$(cksum <"$ROOT/.env")"
[ "$BEFORE" = "$AFTER" ] && check ok ".env is byte-identical after the re-run" || check no ".env is byte-identical after the re-run"
# src/ was actually REFRESHED to the newer archive (proves fetch_src ran)
grep -q SENTINEL-REFRESHED "$ROOT/src/docker-compose.yml" && check ok "re-run refreshed src/ to the new archive content" || check no "re-run refreshed src/ to the new archive content"
# compose booted with the FULL load-bearing contract, from the refreshed src/
LOG="$(cat "$DOCKER_LOG")"
case "$LOG" in *"-p polyrouter-selfhost"*) proj=1 ;; *) proj=0 ;; esac
case "$LOG" in *"--env-file ./.env"*) envf=1 ;; *) envf=0 ;; esac
case "$LOG" in *"-f src/docker-compose.yml"*) cf=1 ;; *) cf=0 ;; esac
case "$LOG" in *"--project-directory src"*) pd=1 ;; *) pd=0 ;; esac
[ "$proj$envf$cf$pd" = "1111" ] && check ok "re-run booted compose with -p/--env-file/-f src/--project-directory" || check no "re-run booted compose with -p/--env-file/-f src/--project-directory ($LOG)"

# --- 3) an UNRELATED dir (no marker) is NOT clobbered; the install nests --------
UNREL="$WORK/unrelated"
mkdir -p "$UNREL/src"
printf 'my-own: project\n' >"$UNREL/src/docker-compose.yml"
printf 'SECRET=keepme\n' >"$UNREL/.env"
UB="$(cksum <"$UNREL/src/docker-compose.yml")"
( cd "$UNREL" && sh "$INSTALL" >/dev/null 2>&1 )
[ "$(cksum <"$UNREL/src/docker-compose.yml")" = "$UB" ] && check ok "unrelated src/docker-compose.yml is untouched (no marker → not treated as an install)" || check no "unrelated src/docker-compose.yml is untouched"
[ -d "$UNREL/polyrouter" ] && check ok "install nested into a subdir rather than refreshing the unrelated src/" || check no "install nested into a subdir rather than refreshing the unrelated src/"

# --- 4) an unrelated pre-existing ./polyrouter/ is REFUSED, not clobbered -------
COLL="$WORK/collision"
mkdir -p "$COLL/polyrouter/src"
printf 'not-ours: yes\n' >"$COLL/polyrouter/src/docker-compose.yml"
CB="$(cksum <"$COLL/polyrouter/src/docker-compose.yml")"
if ( cd "$COLL" && sh "$INSTALL" >/dev/null 2>&1 ); then coll_rc=0; else coll_rc=1; fi
[ "$coll_rc" -ne 0 ] && check ok "a fresh install refuses an existing unrelated polyrouter/ (no marker)" || check no "a fresh install refuses an existing unrelated polyrouter/ (no marker)"
[ "$(cksum <"$COLL/polyrouter/src/docker-compose.yml")" = "$CB" ] && check ok "the unrelated polyrouter/src/ was left untouched" || check no "the unrelated polyrouter/src/ was left untouched"

# --- 5) a marked-but-.env-less dir (interrupted first install) is REFUSED -------
INC="$WORK/incomplete"
mkdir -p "$INC/src"
printf 'polyrouter fetch install — re-run marker; do not delete\n' >"$INC/.polyrouter-install"
printf 'services: {}\n' >"$INC/src/docker-compose.yml" # marker present, but NO .env
if ( cd "$INC" && sh "$INSTALL" >/dev/null 2>&1 ); then inc_rc=0; else inc_rc=1; fi
[ "$inc_rc" -ne 0 ] && check ok "a marker-without-.env dir is refused (no silent secret regeneration)" || check no "a marker-without-.env dir is refused"
[ ! -e "$INC/polyrouter" ] && check ok "the incomplete-install dir was not nested into" || check no "the incomplete-install dir was not nested into"

# --- 6) checkout mode: a deleted .env after a prior install is refused ----------
CO="$WORK/checkout"
mkdir -p "$CO"
printf 'services: {}\n' >"$CO/docker-compose.yml"
printf 'FROM scratch\n' >"$CO/Dockerfile"
printf '{"name":"polyrouter"}\n' >"$CO/package.json"
( cd "$CO" && sh "$INSTALL" >/dev/null 2>&1 )
[ -f "$CO/.env" ] && check ok "checkout install generated .env" || check no "checkout install generated .env"
[ -f "$CO/.polyrouter-secrets-created" ] && check ok "checkout install wrote the secrets sentinel" || check no "checkout install wrote the secrets sentinel"
rm -f "$CO/.env" # operator accidentally deletes .env, then re-runs
if ( cd "$CO" && sh "$INSTALL" >/dev/null 2>&1 ); then co_rc=0; else co_rc=1; fi
[ "$co_rc" -ne 0 ] && check ok "checkout re-run with a deleted .env refuses to regenerate secrets" || check no "checkout re-run with a deleted .env refuses to regenerate secrets"
[ ! -f "$CO/.env" ] && check ok "no new .env was minted on the refused checkout re-run" || check no "no new .env was minted on the refused checkout re-run"

# --- 7) a marked install whose src/ was deleted recovers (refresh, no nest) -----
make_archive "SENTINEL-RECOVER"
rm -rf "$ROOT/src"
( cd "$ROOT" && sh "$INSTALL" >/dev/null 2>&1 )
{ [ ! -e "$ROOT/polyrouter" ] && [ -f "$ROOT/src/docker-compose.yml" ]; } && check ok "a marked install with a deleted src/ recovers in place (no nesting)" || check no "a marked install with a deleted src/ recovers in place (no nesting)"

# --- 8) entering an incomplete marked ./polyrouter from the PARENT is refused ---
PENT="$WORK/parent-entry"
mkdir -p "$PENT/polyrouter/src"
printf 'polyrouter fetch install — re-run marker; do not delete\n' >"$PENT/polyrouter/.polyrouter-install"
printf 'services: {}\n' >"$PENT/polyrouter/src/docker-compose.yml" # marker + src, NO .env
if ( cd "$PENT" && sh "$INSTALL" >/dev/null 2>&1 ); then pe_rc=0; else pe_rc=1; fi
{ [ "$pe_rc" -ne 0 ] && [ ! -e "$PENT/polyrouter/polyrouter" ]; } && check ok "entering an incomplete marked ./polyrouter from the parent is refused, not nested" || check no "entering an incomplete marked ./polyrouter from the parent is refused, not nested"

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
