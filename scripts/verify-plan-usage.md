# Live verification — plan usage (add-subscription-quota-display, add-subscription-usage-history)

**Optional QA.** Ask the user before every live call. Use the user's own credentials, never CI.

Plan usage is read from two places, and both carry [U] items until a real account has been
checked:

- **Passive** (Claude, ChatGPT, OpenCode Go): header and body fields on replies polyrouter already
  receives. Nothing here adds a call.
- **Active** (MiniMax, Kimi Code, Z.ai, OpenCode Go, Claude, ChatGPT): a read of the plan's own
  usage endpoint, on a Refresh usage press and on the usage schedule (about every 15 minutes, per
  provider, while its "Check plan usage on a schedule" switch is on). Every `usageProbe` ships
  **`enabled: true`** (add-subscription-usage-history, design D3): in
  `packages/control-plane/src/subscription-presets/key-presets.ts` for the key plans and in
  `packages/control-plane/src/subscription-oauth/presets.ts` for Claude and ChatGPT. This runbook
  is **optional QA**: it settles the [U] items below and records whether each endpoint accepts
  polyrouter's honest User-Agent. An endpoint a run (or a user report) shows **broken** is
  **withdrawn** by shipping its probe `enabled: false` (step 9.9); nothing needs a run to be
  switched on.

Re-run a section on suspicion of upstream drift (Codex's header names were renamed twice in
October 2025, and Claude Code's grew from 18 to about 30).

Needs: your own plan keys or sign-ins, a running polyrouter dev stack on **Node 24**
(`export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`,
`docker compose -f docker-compose.dev.yml up -d`, then `npm run dev`), about 10 minutes per
section. An agent never runs this for you, never uses a credential found on disk, and never
prints a token.

**Never paste a key or token into logs, commits or this file.** Type each key into the dashboard
field, or into `read -s` in your own shell, only.

## Rules for every step

1. **Record header NAMES only**, never values, for the response-header steps (9.1, 9.2).
2. For the endpoint steps (9.3 to 9.6), record the **HTTP status**, the top-level JSON **key
   names**, and the **nested key names the parser reads** (listed in each section). For the
   Claude and ChatGPT endpoint steps (9.7, 9.8), record the card's outcome (below).
3. Also record the **enum values the parser branches on**. They are not personal: Z.ai `unit`
   numbers and `type` strings, MiniMax `*_status`, OpenCode Go `status`, and a Kimi 403's error
   code.
4. Where a step asks for a number to pin a rule, record **that number only, rounded**: MiniMax
   `weekly_boost_permille` and whether a remaining value exceeds 100; the hours from the read to
   Kimi's `usage.resetTime`.
5. **Never record** tokens, account ids, emails, user ids, organisation or workspace ids, or any
   free-text body or error message.
6. One read per region, never a retry loop. A 403 or 429 may be a refusal of your account; stop and
   record it. The honest `User-Agent: polyrouter/<version>` is the only identity ever sent to a
   usage endpoint. If a region refuses it, that region's probe is **withdrawn** (step 9.9); it is
   never switched to the imitation identity.
7. To keep a run to the reads you make yourself, turn the provider's **"Check plan usage on a
   schedule"** switch off in Edit before the step, and back on after it. Refresh usage still reads
   on a press while the switch is off.

### Printing names without values

For a JSON endpoint, this prints the key paths and no values (array positions show as `[]`):

```sh
printf '%s' "$BODY" | jq -r '[paths | map(if type=="number" then "[]" else . end) | join(".")] | unique[]'
```

For a header capture through curl, this prints header names and no values:

```sh
curl -sS -D - -o /dev/null … | awk -F: 'NF>1 && !/^HTTP/ {print tolower($1)}' | sort -u
```

For a number from an enum or counter, print that field alone, for example
`printf '%s' "$BODY" | jq -r '.data.limits[] | [.type, .unit] | @tsv'`.

### Reading the usage endpoints yourself (steps 9.3 to 9.6)

Set the key by hand, then read once with the honest User-Agent. Use the polyrouter version from the
dashboard footer.

```sh
read -s KEY            # paste the plan key, press Enter; nothing echoes
UA='polyrouter/<version>'
BODY=$(curl -sS -w '\n%{http_code}' -H "Authorization: Bearer $KEY" \
  -H 'Accept: application/json' -A "$UA" "<usage url>")
STATUS=${BODY##*$'\n'}; BODY=${BODY%$'\n'*}
echo "status: $STATUS"
unset KEY
```

Each section below names its `<usage url>`. The key is only ever in the `KEY` variable, never typed
into a command line, so it cannot reach your shell history.

### Capturing header names for the passive steps (9.1, 9.2)

polyrouter never forwards upstream headers to a client, so a header name cannot be read from the
agent's side. To list them, add this **throwaway, uncommitted** line to your working copy of
`packages/data-plane/src/providers/http-adapter.ts`, inside `reportUsage`, the helper that already runs
on each response (it has `res` in scope):

```ts
const names: string[] = [];
res.headers.forEach?.((_v, n) => {
  if (/^(anthropic-ratelimit|x-.*-(primary|secondary|limit)|x-codex)/i.test(n))
    names.push(n.toLowerCase());
});
console.log('USAGE-HEADER-NAMES', JSON.stringify(names.sort()));
```

It logs **names matching the quota families only, never a value**. Restart, run the step, copy the
logged names, then **delete the lines** and confirm `git diff packages/data-plane` is empty before
anything else. The dashboard's usage line is the cross-check: the windows it shows must agree with
the names you captured.

---

## 9.1 Claude (Pro / Max, `anthropic_unified`)

Settles: whether polyrouter's non-imitating `/v1/messages` and `/v1/models` replies carry the
`anthropic-ratelimit-unified-*` family at all, whether `/v1/messages` is accepted or refused (a
400 "only authorized for use with Claude Code" or a 429), and what a 429 carries. [U]

1. Connect the Claude preset (per `scripts/verify-claude-oauth.md` steps 1 and 2).
2. Capture the names (above), then: press **Test** (`/v1/models`), and send **one small**
   `/v1/messages` through polyrouter with an agent key.
3. Record, per response:

   | Response             | Status | Family names carried (names only) |
   | -------------------- | ------ | --------------------------------- |
   | `/v1/models` (Test)  |        |                                   |
   | `/v1/messages`       |        |                                   |
   | A 429, if one occurs |        |                                   |

   Look for these names, and record which are present: `anthropic-ratelimit-unified-status`,
   `-5h-utilization`, `-5h-reset`, `-7d-utilization`, `-7d-reset`, `-7d_oi-utilization`,
   `-7d_oi-reset`, `-overage-in-use`. Note whether the 5-hour window is absent between sessions
   (it is session-anchored, so a missing or 0% window then is expected).

4. Open Providers and read the card's usage line. Record whether it shows `5h`, `weekly` and, on
   an account that has one, `weekly Fable`.

**Pass:** a response carries `-status` and at least one `-utilization` name, and the card shows the
matching windows. **Sets:** nothing is enabled (Claude's passive capture is already on and inert
when the headers are absent); the names confirm the parser constants in
`packages/data-plane/src/providers/plan-usage.ts` (`CLAUDE_PREFIX` and the window table).
**If the family is absent:** record that, and `docs/self-hosting.md` ("Plan usage on the card")
states that Claude usage stays `unknown` with polyrouter's identity. Do not switch on the imitation
identity to get it.

## 9.2 ChatGPT (Plus / Pro, `codex`)

Settles: whether `chatgpt.com` returns the `x-codex-*` family to polyrouter's three-header request,
the per-model bucket names, the credit flags, whether a 429 carries window headers or
`used-percent=100`, and whether the weekly `reset-at` slides forward. [U]

1. Connect the ChatGPT preset (per `scripts/verify-chatgpt-oauth.md`).
2. Capture the names, then press **Test** and send **one** completion through polyrouter. If a 429
   occurs, record its names too.
3. Record:

   | Response             | Status | Family names carried (names only) |
   | -------------------- | ------ | --------------------------------- |
   | Test (listing)       |        |                                   |
   | Completion           |        |                                   |
   | A 429, if one occurs |        |                                   |

   Look for: `x-codex-primary-used-percent`, `-window-minutes`, `-reset-at`,
   `-reset-after-seconds`, the same four for `secondary`, `x-codex-credits-has-credits`,
   `x-codex-credits-unlimited`, and any `x-<limit>-primary-used-percent` family (model buckets, with
   `x-<limit>-limit-name`). Record whether the window minutes are 300, 10080 or another number
   (numbers are not personal).

4. **Slide check.** Send a second completion at least ten minutes later and record whether
   `x-codex-secondary-reset-at` moved (yes or no, and by about how many hours, rounded).
5. **Credit state.** Record whether both credit flags are present. If your account is at 100% on a
   window, record whether the card then reads "credits may be in use" (it must say _may_).

**Pass:** the primary or secondary window names arrive on at least one response and the card shows
a window labelled by its length. **Sets:** the Codex header constants in `plan-usage.ts`. A 429
without window headers is expected to form no observation; record it and move on. **If the family
is absent:** `docs/self-hosting.md` states that ChatGPT usage stays `unknown` with polyrouter's
identity.

## 9.3 OpenCode Go (`opencode_go`)

Settles: the body extension (`usage.opencode`) on a streamed and a buffered reply, and
(FD1, accepted) the `/zen/go/v1/usage` endpoint: its status, its keys, its `status` enum, and
whether the key needs Usage › Read or the workspace header. [U]

1. Connect the OpenCode Go key preset (per `scripts/verify-opencode-go-key.md`).
2. **Passive.** Send **one streamed** and **one buffered** completion. For each, record whether the
   body carried `usage.opencode`, and the **key names** under it. The parser reads only
   `billing_source` (values `go`, `go-plus` or `balance`; record which one you saw). It never reads
   `allowance`. Record whether a **non-streaming** reply includes `usage.opencode` at all.
3. **Active.** `GET https://opencode.ai/zen/go/v1/usage` with the honest User-Agent (above). Record:
   - the status; for a 403, that it is ambiguous (no Go plan, or the key lacks Usage › Read);
   - the top-level key names and the nested key names under `usage.rolling`, `usage.weekly` and
     `usage.monthly` (the parser reads `percent`, `resetsAt` and `status`);
   - the `status` enum values you see;
   - whether a key restricted to Models › Request is refused, and whether `x-opencode-org-id` is
     needed for a workspace-bound key (OpenCode's docs say no).

**Pass:** the endpoint answers 200 with the `rolling`, `weekly` or `monthly` objects and a
parseable `percent` and `resetsAt`. **Sets:** the `opencode_go_usage` fixture in
`plan-usage-read.spec.ts` cites this run. A refusal of the honest User-Agent withdraws the
OpenCode Go probe (step 9.9); a 403 explained by the key's permissions does not.

## 9.4 MiniMax (M Plan)

Settles: whether `api.minimax.io` serves the documented path, whether the percent fields are
present, which `model_remains` row an M Plan key gets, what a rejected key answers, and what
`weekly_boost_permille` means. [U]

1. `GET https://api.minimax.io/v1/token_plan/remains` with the honest User-Agent. (The China host
   has no probe until its own run; do not test it here.)
2. Record:
   - the status, and the `base_resp` key names (the parser reads `base_resp.status_code`; record
     the **code value**, which is not personal. A non-zero code with HTTP 200 is a failure, and
     `2062` means no active plan);
   - the key names inside `model_remains[]`: `model_name`, `current_interval_remaining_percent`,
     `current_weekly_remaining_percent`, `current_interval_status`, `current_weekly_status`,
     `end_time`, `weekly_end_time`. Record whether each `*_remaining_percent` field is present;
   - **which row** an M Plan key returns (the text model's `model_name` is not personal) and how
     many rows come back;
   - the `*_status` values (the parser treats 3 as unlimited);
   - whether `weekly_boost_permille` is present, and, **as rounded numbers only**, whether any
     remaining value above 100 appears beside it, compared with the boost the MiniMax dashboard
     shows for the same moment (for example: boost 500 permille, weekly remaining 150, dashboard
     shows "+50%").
3. Do not record `*_usage_count`; note only whether those counts look like used or remaining
   against the dashboard.

**Pass:** status 200, `base_resp.status_code` 0, and `current_interval_remaining_percent` or
`current_weekly_remaining_percent` present for the chosen row. **Sets:** the `minimax_remains`
fixture and constants (row choice and count rule) cite this run. A remaining value above 100 stays
`unknown` unless this step pins the boost's meaning; only then does the parser normalize
(`used = (100 + boost − remaining) / (100 + boost)`, boost in percent).

## 9.5 Kimi Code

Settles: whether `/usages` accepts the honest User-Agent, what a 403 means, what the API-key path's
envelope is, whether `used_ratio` is still zero, and which window the `usage` summary is. [U]

**Before the call, ask the user** whether the plan is near or at its 5-hour or weekly limit
(from the Kimi dashboard), and record the answer: _near or at / not near_. This is what tells an
exhaustion 403 from a gate.

1. For each region you hold a key for, `GET {base_url}/usages`, with the honest User-Agent:
   `https://api.kimi.ai/coding/v1/usages` (international) and
   `https://api.kimi.com/coding/v1/usages` (China). One read per region.
2. Record, per region:
   - the status. **A 403 is an ambiguous refusal, not proof of a User-Agent gate.** It may mean the
     plan is exhausted (Kimi has answered 403 for 5-hour and weekly exhaustion), a User-Agent gate,
     or a key or permission problem. For a 403, also record the error envelope's **key names** and
     its **code values**, never its free text. Conclude "UA gate" only if the body names the
     User-Agent, or the 403 repeats while the dashboard shows the plan **not** exhausted. Only a
     confirmed gate withdraws the probe (step 9.9), and the docs never say Kimi refuses
     polyrouter's User-Agent on a bare 403;
   - the envelope key names;
   - whether the `limits[].detail` counters (`limit`, `used`, `remaining`, `resetTime`) and the
     `usage` counters are present;
   - whether `usages.*.used_ratio` still reads 0 against non-zero counters (the parser never
     reads it);
   - **which window `usage` summarises**: the hours from the read to `usage.resetTime`, rounded,
     compared with the weekly or monthly reset the Kimi membership page shows. Record the number
     of hours and which reset on the page it matches.

**Pass:** status 200 with at least one `limits[].detail` or the `usage` counters. **Sets:** the
`kimi_usages` fixture cites this run, and the `usage` summary's label (weekly, monthly, or none)
follows the hours you recorded; if it stays unclear it stays unlabelled (`plan window`). A 403 that
has not been explained is recorded and left for a second run; it withdraws nothing on its own.
Record Moonshot's unanswered third-party question (kimi-code#2937) status here as well.

## 9.6 Z.ai (GLM Coding Plan)

Settles: Bearer or raw key, the unit enum and the zone of `nextResetTime`, whether the new Coding
Plan key type is accepted, and what a Team key returns. [U]

1. `GET https://api.z.ai/api/monitor/usage/quota/limit` with a `Bearer` key first. **Only if Bearer
   is refused**, retry once with the raw key in `Authorization` (no `Bearer`). (For the China
   region, `https://open.bigmodel.cn/api/monitor/usage/quota/limit`, one read.)
2. Record, per form tried:
   - the status, and the top-level key names (the parser reads `success` and `code`, and
     `data.limits[]`);
   - per `limits[]` row: the `type` string, the `unit` number, the `number`, and whether
     `percentage` and `nextResetTime` are present. Record the **`unit` numbers and `type` strings**
     (not personal). The parser keeps only unit 3 (hours) and 6 (weeks);
   - whether `nextResetTime` agrees with the reset the Z.ai dashboard shows, which tells its zone
     (record only "agrees" or "differs by N hours, rounded");
   - whether a Team or non-standard key returns empty `limits` (it reads as unknown).

**Pass:** `success: true`, `code: 200`, and a unit 3 or unit 6 row with a `percentage`. **Sets:**
the probe's `auth` (`bearer`, or `raw` only if Bearer was refused), and confirms or revises FD7's
unit mapping in `ZAI_UNIT_MINUTES` (`plan-usage-read.ts`); the `zai_quota_limit` fixture cites this
run.

## 9.7 Claude usage endpoint (`/api/oauth/usage`)

Settles: whether `GET https://api.anthropic.com/api/oauth/usage` (the **plain** path, never a
`?cedar_ember` or `skip_spend` variant) accepts polyrouter's honest User-Agent with only the Bearer
token and `anthropic-beta: oauth-2025-04-20`, and whether its windows match the parser
(`claude_oauth_usage`). [U] The endpoint shares a per-account rate limit with your own Claude
Code sessions, so make **one** read.

1. Connect the Claude preset (per `scripts/verify-claude-oauth.md` steps 1 and 2), and turn its
   schedule switch off (rule 7).
2. On the Claude card, press **Refresh usage once**. This is polyrouter's own read: the honest
   User-Agent, the Bearer token, the beta header, and nothing else.
3. Record the **outcome** only:
   - **accepted**: the usage line shows windows. Record which labels appear (`5h`, `weekly`,
     `weekly Sonnet`, `weekly Opus`) and whether each percent matches the Claude usage page to
     within one point (a 1% window must never read 100%);
   - **refused**: record the card's fixed message (it names the outcome, never the body):
     "rejected the credential" (401), "was refused" (403; a missing `user:profile` scope is one
     cause), "rate limiting reads" (429; record whether this followed your own Claude Code use),
     or "nothing this version can read" (a 200 in a shape the parser does not know).

**Pass:** the card shows at least the `5h` or `weekly` window with plausible percents. **Sets:**
the `claude_oauth_usage` fixture cites this run. **If refused with 401 or 403 while the provider's
Test passes:** the endpoint does not accept polyrouter's identity; withdraw the Claude probe
(step 9.9). It is never switched to an imitated client.

## 9.8 ChatGPT usage endpoint (`/backend-api/wham/usage`)

Settles: whether `GET https://chatgpt.com/backend-api/wham/usage` accepts polyrouter's honest
User-Agent with only the Bearer token and `chatgpt-account-id` (no `originator`, no
`x-openai-codex-luna-reserve`), and whether its windows match the parser (`chatgpt_wham_usage`).
[U] No other `/wham/` path is ever called; `/wham/rate-limit-reset-credits/consume` spends a
banked reset.

1. Connect the ChatGPT preset (per `scripts/verify-chatgpt-oauth.md`), and turn its schedule
   switch off (rule 7).
2. On the ChatGPT card, press **Refresh usage once**.
3. Record the **outcome** only:
   - **accepted**: record which labels the usage line shows (`5h`, `weekly`, or another length),
     and whether each percent matches the Codex usage view to within one point;
   - **refused**: record the card's fixed message, as in 9.7. A "carries no account id" message
     means the sign-in has no account claim; reconnect, then repeat once.

**Pass:** the card shows a window labelled by its length with a plausible percent. **Sets:** the
`chatgpt_wham_usage` fixture cites this run. **If refused with 401 or 403 while the provider's
Test passes:** withdraw the ChatGPT probe (step 9.9). OpenAI's Pro help page prohibits
"automatically extracting data": record that the run was a single attended read.

## 9.9 Withdraw a broken endpoint (a separate commit)

Only when a section **showed an endpoint broken** (a refused honest User-Agent, a changed path, or a
shape the parser cannot read), never for an account condition such as an exhausted plan:

1. Set that probe's `enabled: false`: in `key-presets.ts` for a key region, in
   `subscription-oauth/presets.ts` for Claude or ChatGPT. Its providers then offer no Refresh
   usage, and the schedule skips them.
2. Update the registry comment (source and date, as the other runbooks do) and
   `docs/self-hosting.md` (what is read, and the per-endpoint notes).
3. Update the registry tests that pin every probe as enabled
   (`npm test -w packages/control-plane -- key-presets presets plan-usage-sources`). Commit this on
   its own, so reverting it only switches the endpoint back on.

## Which [U] items each step settles

| [U] item (design.md "Risks / Trade-offs")                                        | Step                                                     |
| -------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Claude's family absent for non-imitating requests, or `/v1/messages` refused     | 9.1                                                      |
| ChatGPT may not send `x-codex-*` to a request without `originator` or a Codex UA | 9.2                                                      |
| An HTTP 429 may carry no window headers, or not `used=100`                       | 9.1, 9.2                                                 |
| Header names drift                                                               | 9.1, 9.2 (re-check the names on any drift)               |
| Claude's 5-hour window is session-anchored                                       | 9.1 (note whether the window is absent between sessions) |
| Codex weekly `reset_at` slides forward                                           | 9.2 step 4                                               |
| The ChatGPT "credits may be in use" state is an inference                        | 9.2 step 5                                               |
| MiniMax: host serves the documented path; percent fields present                 | 9.4                                                      |
| MiniMax: which `model_remains` row an M Plan key gets                            | 9.4                                                      |
| MiniMax: a rejected key answers HTTP 200 with a non-zero `base_resp`             | 9.4                                                      |
| MiniMax: what `weekly_boost_permille` means; remaining above 100                 | 9.4                                                      |
| Kimi: whether `/usages` accepts the honest UA                                    | 9.5                                                      |
| Kimi: a 403 is ambiguous (exhaustion, UA gate, key or permission)                | 9.5                                                      |
| Kimi: which window the `usage` summary represents                                | 9.5                                                      |
| Kimi: which envelope the API-key path returns; whether `used_ratio` is zeroed    | 9.5                                                      |
| Kimi: Moonshot's unanswered third-party question (kimi-code#2937)                | 9.5                                                      |
| Z.ai: Bearer or raw key                                                          | 9.6                                                      |
| Z.ai: the unit enum and the zone of `nextResetTime`                              | 9.6                                                      |
| Z.ai: whether the new Coding Plan key type is accepted; Team keys read empty     | 9.6                                                      |
| OpenCode Go: whether a Models › Request-only key may read `/usage` (403)         | 9.3                                                      |
| OpenCode Go: whether `x-opencode-org-id` is needed for a workspace-bound key     | 9.3                                                      |
| OpenCode Go: a buffered reply reports `usage.opencode`                           | 9.3 step 2                                               |
| Claude: `/api/oauth/usage` accepts the honest UA with Bearer + the oauth beta    | 9.7                                                      |
| ChatGPT: `/wham/usage` accepts the honest UA with Bearer + `chatgpt-account-id`  | 9.8                                                      |

## Results

Fill one row per run. Names, statuses, enum values and rounded numbers only.

| Date | Step                  | Result | Notes (names, statuses, enums, rounded numbers; never values) |
| ---- | --------------------- | ------ | ------------------------------------------------------------- |
|      | 9.1 Claude            |        |                                                               |
|      | 9.2 ChatGPT           |        |                                                               |
|      | 9.3 OpenCode Go       |        |                                                               |
|      | 9.4 MiniMax           |        |                                                               |
|      | 9.5 Kimi (intl)       |        |                                                               |
|      | 9.5 Kimi (China)      |        |                                                               |
|      | 9.6 Z.ai (intl)       |        |                                                               |
|      | 9.6 Z.ai (China)      |        |                                                               |
|      | 9.7 Claude endpoint   |        |                                                               |
|      | 9.8 ChatGPT endpoint  |        |                                                               |
|      | 9.9 withdrawal commit |        |                                                               |
