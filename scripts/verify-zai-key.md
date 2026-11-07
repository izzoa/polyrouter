# Live verification — Z.ai GLM Coding Plan key preset (add-key-subscription-presets)

The Z.ai preset's `/models` listing path is [U] and whether its plan endpoint needs a client
identity at all is [U]
(`packages/control-plane/src/subscription-presets/key-presets.ts`, `ZAI_CODING_PLAN_PRESET`).
Per the spec, each region ships **`enabled: false`** until its own run of this check passes
with a real plan key — an enabled-and-known-broken preset must never ship. Re-run on
suspicion of upstream drift.

Needs: **your own Z.ai Personal Coding Plan (or Team Plan) key**, a running polyrouter dev
stack on **Node 24** (`export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`,
`docker compose -f docker-compose.dev.yml up -d`, then `npm run dev`), ~15 minutes per
region. An agent never runs this for you and never uses a credential found on disk. The two
regions use separate hosts (`api.z.ai` international, `open.bigmodel.cn` China).

**Never paste the key into logs, commits or this file.** Type it into the dashboard field
only. When a step needs an agent key for `curl`, keep it in a shell variable you set by
hand (`read -s POLY_KEY`).

**Terms caution (high risk).** Z.ai's subscription terms forbid aggregate and proxy use, and
calling the model API from your own applications, unless you hold a separate written
agreement. Routing through polyrouter is that kind of use. Connect needs the
acknowledgement checkbox (the server refuses without `acknowledgeTermsRisk: true`). Run this
only if you accept that risk or have Z.ai's written permission; whether to enable the preset
afterwards is your call, not the technical gate's.

**Wrong key type bills money.** For keys created on or after 2026-10-16 the key type, not the
endpoint, decides billing. Use a Coding Plan key and check your pay-as-you-go balance does not
drop during step 5.

## Which [U] facts this settles

- The `/models` listing path and shape under `/api/coding/paas/v4` on each host ([U], design
  D4). The pay-as-you-go `/api/paas/v4` path must never be used.
- Whether the **honest** `User-Agent: polyrouter/<version>` passes, or Z.ai's plan endpoint
  requires a supported-tool identity.
- Whether the **imitation** identity (`claude-cli/2.1.319 (external, cli)`) passes on the
  pinned OpenAI path, and whether the declared string or version needs updating (design D10).
- Therefore whether each region is **imitation-required** (design D12).
- Which token-cap spelling each region honours (`maxTokensSpelling`).
- Whether Z.ai **lists models the plan cannot use** (error code `1311`, [U]): Test passes and
  the completion fails typed. Record which listed models fail. Classifying that error belongs
  to `classify-plan-quota-errors`, not this change.
- The key-type note wording still matches Z.ai's current key-type billing rules.
- Cost: on `api.z.ai` the request log shows **notional** cost priced at the `zai` family's API
  rates; on `open.bigmodel.cn` the cost is null and flagged.

## 1. Temporarily enable the region

In `key-presets.ts`, flip the region under test (`intl` first, then `cn`) to
`enabled: true` (local working copy only) and restart the dev stack. Check
`GET /api/providers/key-presets/available` (or the dashboard) lists **Z.ai GLM Coding Plan**.

## 2. Connect and confirm the key

1. Dashboard → Providers → Add provider → **Subscription** → the **Z.ai GLM Coding Plan** card.
2. Choose the region, read the terms-risk copy and the key-type note, tick the
   acknowledgement, paste your key, **Connect**.
3. Confirm by eye only that the row is named for the preset and region and the endpoint is the
   pinned coding URL. Do not copy the key anywhere. (There is no documented prefix to check.)

## 3. Test (the listing)

Press **Test** with the identity-imitation switch **off** (the default). Expected: success
with a model count. Record the **listing shape**, count, and any refusal (status, body shape,
never the key).

## 4. Sync

Press **Sync models**. Record the count and a few ids.

## 5. One buffered and one streamed completion

With an agent key in `$POLY_KEY` and a synced model id:

```sh
curl -sS http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer $POLY_KEY" -H 'content-type: application/json' \
  -d '{"model":"<synced-model-id>","messages":[{"role":"user","content":"Say ok."}]}'

curl -sSN http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer $POLY_KEY" -H 'content-type: application/json' \
  -d '{"model":"<synced-model-id>","stream":true,"messages":[{"role":"user","content":"Say ok."}]}'
```

Expected: a normal completion and stream. Record any non-2xx and typed error, including a
`1311` for a listed-but-unusable model (try one or two ids).

## 6. Capped completion (decides `maxTokensSpelling`)

Send one request with `"max_tokens": 16` and one with `"max_completion_tokens": 16` (through a
client, or by PATCHing the row's `maxTokensSpelling` in Edit). The honoured spelling keeps
`usage.completion_tokens` at or below the cap with `finish_reason: length`. If only
`max_tokens` works, set `maxTokensSpelling: 'max_tokens'` on the region.

## 7. Honest-UA pass, then the imitation pass

1. **Honest pass.** Steps 3 to 6 above, with the switch off, are this pass (exactly one
   `User-Agent: polyrouter/<version>` on the wire). Record **pass** or the refusal.
2. **Imitation pass.** Edit the row, turn on the **identity imitation** switch
   (`allow-preset-client-identity`; read and accept its warning), then repeat steps 3, 4, 5 and 6. The wire carries exactly one User-Agent, `claude-cli/2.1.319 (external, cli)` (or the
   string you updated). Record **pass** or the refusal. Turn the switch back off when done.
3. Decide: honest passes, then `imitationRequired: false`. Only imitation passes, then set the
   region's `imitationRequired: true` and update `riskCopy` to say Z.ai currently refuses
   polyrouter's identity and imitation must be turned on in Edit (the preset is already
   `high`; design D12). Neither passes: keep the region disabled.

## 8. Result table and enablement

For each region that passes: keep `enabled: true`, update drifted constants (listing path,
`maxTokensSpelling`, key-type note, identity string or version), record the date in the
registry comment, add a row below, and commit. On any failure: revert to `enabled: false` and
document the failure here.

Z.ai written-permission status (date, reply): **not recorded yet**.

| Region | Date | Listing shape | Models | `maxTokensSpelling` | Honest UA | Imitation | Imitation-required | `1311` seen | Result      | Notes                         |
| ------ | ---- | ------------- | ------ | ------------------- | --------- | --------- | ------------------ | ----------- | ----------- | ----------------------------- |
| intl   | —    | —             | —      | —                   | —         | —         | —                  | —           | **not run** | Ships disabled until verified |
| cn     | —    | —             | —      | —                   | —         | —         | —                  | —           | **not run** | Ships disabled until verified |

## 9. Error-shape evidence (classify-plan-quota-errors)

Z.ai's plan-error codes (`1308`, `1310`, `1313`, `1309`, `1311`, ...) and the `{next_flush_time}`
format come from `https://docs.z.ai/api-reference/api-code` and are **[U]** until a captured
response confirms them (`packages/data-plane/src/providers/plan-errors.ts`, `ZAI_CODES`,
`ZAI_FLUSH_TIME_ZONE`). If a plan error occurs **naturally** during any step above, record it
here. Never exhaust a plan on purpose, never paste a key: this section is for what you happened
to see, nothing else.

Record, per error:

- **HTTP status.**
- **Envelope keys**, for example `error.code` (string or number) and `error.message`, with the
  message redacted except its documented template (the "reset at {next_flush_time}" wording
  and the plan-window words). No key, no account or user ids.
- **`Retry-After`:** present or absent, and if present its form (delta seconds or HTTP-date).
- **`{next_flush_time}` format and zone:** the literal shape of the time (ISO-8601 with an
  offset, `Z`, or a zone-less `YYYY-MM-DD HH:mm:ss`) and which zone it is in. A zone-less time
  is ignored until `ZAI_FLUSH_TIME_ZONE` is set from this evidence (design D5).
- Whether a listed model failed with `1311` (plan lacks the model), and which.

| Region | Date | HTTP status | `error.code` | Envelope keys | `Retry-After` | `{next_flush_time}` format and zone | Notes             |
| ------ | ---- | ----------- | ------------ | ------------- | ------------- | ----------------------------------- | ----------------- |
| intl   | —    | —           | —            | —             | —             | —                                   | none recorded yet |
| cn     | —    | —           | —            | —             | —             | —                                   | none recorded yet |

Never exhaust a plan on purpose, never paste a key. Share only what the table asks for.
