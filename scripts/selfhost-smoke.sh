#!/usr/bin/env bash
# In-container smoke pass for the self-host stack (#22 DoD, spec §15/§13).
# Boots a THROWAWAY product stack (own project name/volumes/port — the dev
# compose and a real polyrouter-selfhost install stay untouched) and asserts:
#   health/SPA/metrics · first-sign-up-is-admin (and second is not) ·
#   a LIVE streamed completion drains across `docker stop` (inspected exit
#   state, not compose's) · metadata-only persistence (prompt sentinel absent) ·
#   restart-safe (idempotent migrations, data intact).
# Needs: docker (Compose v2), curl, python3, openssl. Run from the repo root.
set -euo pipefail

PROJECT=polyrouter-smoke
PORT="${SMOKE_PORT:-3210}"
BASE="http://127.0.0.1:$PORT"
SENTINEL="SMOKE_SENTINEL_$(date +%s)_do_not_persist"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/polyrouter-smoke.XXXXXX")"

compose() { docker compose -p "$PROJECT" --env-file "$WORK/.env" -f docker-compose.yml "$@"; }
pass() { printf '  \033[32mok\033[0m  %s\n' "$*"; }
fail() {
  printf '  \033[31mFAIL\033[0m %s\n' "$*" >&2
  exit 1
}
cleanup() {
  compose --profile apprise down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

command -v docker >/dev/null || fail "docker required"
command -v curl >/dev/null || fail "curl required"
command -v python3 >/dev/null || fail "python3 required"
json() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }

echo "== throwaway env + stack (project $PROJECT, port $PORT)"
{
  echo "POLYROUTER_PORT=$PORT"
  # Isolated from any real install: own image tag + own subnet (+ own project).
  echo "POLYROUTER_IMAGE=polyrouter:smoke"
  echo "POLYROUTER_SUBNET=${SMOKE_SUBNET:-172.28.9.0/24}"
  for k in BETTER_AUTH_SECRET API_KEY_HMAC_SECRET PROVIDER_CREDENTIAL_KEY NOTIFY_CREDENTIALS_SECRET POSTGRES_PASSWORD; do
    echo "$k=$(openssl rand -hex 32)"
  done
} >"$WORK/.env"
compose up -d --build --quiet-pull

echo "== wait for the app healthcheck"
APP_ID="$(compose ps -q app)"
for _ in $(seq 1 60); do
  STATUS="$(docker inspect -f '{{.State.Health.Status}}' "$APP_ID")"
  [ "$STATUS" = "healthy" ] && break
  sleep 2
done
[ "$STATUS" = "healthy" ] || fail "app never became healthy (status: $STATUS)"
pass "app healthy"

echo "== endpoints"
HC="$(curl -fsS -w '|%{content_type}' "$BASE/api/health")"
echo "$HC" | grep -q 'application/json' || fail "/api/health is not JSON: $HC"
pass "/api/health 200 JSON"
ROOT_HTML="$(curl -fsS "$BASE/")"
echo "$ROOT_HTML" | grep -q '/fonts/fonts.css' || fail "SPA shell missing local fonts link"
echo "$ROOT_HTML" | grep -q 'fonts.googleapis' && fail "SPA still references Google Fonts"
pass "SPA shell served, local fonts only"
curl -fsS "$BASE/fonts/fonts.css" | grep -q '@font-face' || fail "fonts.css not served"
for f in geist-latin geist-mono-latin; do
  curl -fsS -o /dev/null "$BASE/fonts/$f.woff2" || fail "$f.woff2 not served"
done
pass "font assets served locally"
BINDING="$(docker inspect -f '{{(index (index .NetworkSettings.Ports "3001/tcp") 0).HostIp}}' "$APP_ID")"
[ "$BINDING" = "127.0.0.1" ] || fail "app is published on $BINDING, expected loopback by default"
pass "published on loopback by default"
curl -fsS "$BASE/metrics" | grep -q '^polyrouter_' || fail "/metrics missing polyrouter_ series"
pass "/metrics scrapes"

echo "== first sign-up = admin, second is not"
curl -fsS -c "$WORK/c1.txt" -H 'content-type: application/json' \
  -d '{"name":"Admin","email":"admin@smoke.test","password":"smoke-password-1"}' \
  "$BASE/api/auth/sign-up/email" >/dev/null
curl -fsS -c "$WORK/c2.txt" -H 'content-type: application/json' \
  -d '{"name":"Second","email":"second@smoke.test","password":"smoke-password-2"}' \
  "$BASE/api/auth/sign-up/email" >/dev/null
ROLES="$(compose exec -T postgres psql -U polyrouter -d polyrouter -tAc \
  'select email||'"'"':'"'"'||coalesce(role,'"'"'none'"'"') from "user" order by created_at asc')"
[ "$(echo "$ROLES" | wc -l | tr -d ' ')" = "2" ] || fail "expected exactly 2 users, got: $ROLES"
echo "$ROLES" | sed -n 1p | grep -q '^admin@smoke.test:admin$' || fail "first user is not the admin ($ROLES)"
echo "$ROLES" | sed -n 2p | grep -q '^second@smoke.test:' || fail "unexpected second user ($ROLES)"
echo "$ROLES" | sed -n 2p | grep -q ':admin$' && fail "second user must not be admin ($ROLES)"
[ "$(echo "$ROLES" | grep -c ':admin$')" = "1" ] || fail "expected exactly one admin ($ROLES)"
pass "admin bootstrap correct (exactly one admin, by email)"

echo "== loopback SSE stub inside the app container (kind=local provider)"
STUB='const h=require("http");h.createServer((q,s)=>{if(q.url.endsWith("/models")){s.setHeader("content-type","application/json");s.end(JSON.stringify({object:"list",data:[{id:"stub-model",object:"model"}]}));return}let b="";q.on("data",c=>b+=c);q.on("end",()=>{const j=JSON.parse(b||"{}");if(j.stream){s.setHeader("content-type","text/event-stream");let i=0;const t=setInterval(()=>{i+=1;if(i>25){clearInterval(t);s.write("data: {\"id\":\"s\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"stub-model\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n");s.write("data: [DONE]\n\n");s.end();return}s.write("data: {\"id\":\"s\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"stub-model\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"w \"},\"finish_reason\":null}]}\n\n")},300)}else{s.setHeader("content-type","application/json");s.end(JSON.stringify({id:"s",object:"chat.completion",created:1,model:"stub-model",choices:[{index:0,message:{role:"assistant",content:"ok"},finish_reason:"stop"}],usage:{prompt_tokens:5,completion_tokens:2,total_tokens:7}}))}})}).listen(9099,"127.0.0.1")'
compose exec -T -d app node -e "$STUB"
sleep 1

echo "== wire provider → model → default tier → agent key (session #1)"
PROVIDER_ID="$(curl -fsS -b "$WORK/c1.txt" -H 'content-type: application/json' \
  -d '{"name":"smoke-stub","kind":"local","protocol":"openai_compatible","baseUrl":"http://127.0.0.1:9099/v1"}' \
  "$BASE/api/providers" | json "['id']")"
curl -fsS -b "$WORK/c1.txt" -X POST "$BASE/api/providers/$PROVIDER_ID/sync-models" >/dev/null
MODEL_ID="$(curl -fsS -b "$WORK/c1.txt" "$BASE/api/models" |
  python3 -c 'import sys,json;ms=[m for m in json.load(sys.stdin) if m["externalModelId"]=="stub-model"];print(ms[0]["id"])')"
TIER_ID="$(curl -fsS -b "$WORK/c1.txt" "$BASE/api/routing/tiers" |
  python3 -c 'import sys,json;print([t for t in json.load(sys.stdin) if t["key"]=="default"][0]["id"])')"
curl -fsS -b "$WORK/c1.txt" -X PUT -H 'content-type: application/json' \
  -d "{\"modelIds\":[\"$MODEL_ID\"]}" "$BASE/api/routing/tiers/$TIER_ID/entries" >/dev/null
AGENT_KEY="$(curl -fsS -b "$WORK/c1.txt" -H 'content-type: application/json' \
  -d '{"name":"smoke-agent","harness":"openai_sdk"}' "$BASE/api/agents" | json "['key']")"
pass "provider/model/tier/agent wired"

echo "== drain proof: docker stop during a LIVE stream (~7s of chunks left, drain deadline 15s)"
curl -sN -m 60 -H "authorization: Bearer $AGENT_KEY" -H 'content-type: application/json' \
  -d "{\"model\":\"stub-model\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"$SENTINEL\"}]}" \
  "$BASE/v1/chat/completions" >"$WORK/stream.out" &
CURL_PID=$!
# Prove the stream is LIVE before stopping: chunks received AND curl still up.
for _ in $(seq 1 20); do
  grep -q 'chat.completion.chunk' "$WORK/stream.out" 2>/dev/null && break
  sleep 0.5
done
grep -q 'chat.completion.chunk' "$WORK/stream.out" || fail "no stream chunks received before stop"
kill -0 "$CURL_PID" 2>/dev/null || fail "client stream ended before docker stop (nothing to drain)"
STOP_START=$(date +%s)
compose stop app >/dev/null
STOP_SECS=$(($(date +%s) - STOP_START))
wait "$CURL_PID" || fail "the client stream errored during the drain"
grep -q '\[DONE\]' "$WORK/stream.out" || fail "stream was severed — no [DONE] terminator after drain"
EXIT_CODE="$(docker inspect -f '{{.State.ExitCode}}' "$APP_ID")"
OOM="$(docker inspect -f '{{.State.OOMKilled}}' "$APP_ID")"
[ "$EXIT_CODE" = "0" ] || fail "container exit code $EXIT_CODE (SIGKILL after grace period?)"
[ "$OOM" = "false" ] || fail "container was OOM-killed"
pass "in-flight stream drained to [DONE]; container exited 0 in ${STOP_SECS}s (grace 45s)"

echo "== metadata-only: the prompt sentinel is nowhere in the persisted rows"
LOGS="$(compose exec -T postgres psql -U polyrouter -d polyrouter -tAc 'select count(*) from request_log')"
[ "$LOGS" -ge 1 ] || fail "no request_log rows were persisted (shutdown flush missing?)"
HITS="$(compose exec -T postgres psql -U polyrouter -d polyrouter -tAc \
  "select (select count(*) from request_log where cast(row_to_json(request_log) as text) like '%$SENTINEL%')
        + (select count(*) from request_attempt where cast(row_to_json(request_attempt) as text) like '%$SENTINEL%')")"
[ "$HITS" = "0" ] || fail "prompt sentinel found in persisted request rows ($HITS rows)"
pass "$LOGS row(s) persisted, sentinel absent from request_log AND request_attempt"

echo "== restart: idempotent migrations, data intact"
compose start app >/dev/null
for _ in $(seq 1 45); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$APP_ID")" = "healthy" ] && break
  sleep 2
done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$APP_ID")" = "healthy" ] || fail "app unhealthy after restart"
curl -fsS -b "$WORK/c1.txt" "$BASE/api/providers" | grep -q smoke-stub || fail "provider lost across restart"
pass "restarted healthy, data intact"

echo "== apprise profile boots and passes the SSRF allowlist"
{
  echo "APPRISE_API_URL=http://apprise:8000"
  echo "NOTIFY_ALLOWED_ENDPOINTS=apprise,${SMOKE_SUBNET:-172.28.9.0/24},8000"
} >>"$WORK/.env"
compose --profile apprise up -d >/dev/null 2>&1
# The env change RECREATES the app container — re-resolve its id.
APP_ID="$(compose ps -q app)"
for _ in $(seq 1 45); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$APP_ID" 2>/dev/null)" = "healthy" ] && break
  sleep 2
done
if [ "$(docker inspect -f '{{.State.Health.Status}}' "$APP_ID" 2>/dev/null)" != "healthy" ]; then
  compose logs --tail 20 app >&2 || true
  fail "app unhealthy with the apprise pair set (SSRF allowlist rejected?)"
fi
docker inspect -f '{{.State.Running}}' "$(compose --profile apprise ps -q apprise)" | grep -q true || fail "apprise container not running"
pass "apprise profile up; app healthy with APPRISE_API_URL + allowlist"

echo ""
echo "ALL SMOKE CHECKS PASSED (stack is being torn down with volumes)"
