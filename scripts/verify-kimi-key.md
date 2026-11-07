# Live verification — Kimi Code key preset (add-key-subscription-presets)

The Kimi Code preset's `/models` listing path is [U] and Moonshot's allow-list for the
honest User-Agent is unconfirmed
(`packages/control-plane/src/subscription-presets/key-presets.ts`, `KIMI_CODE_PRESET`). Per
the spec, each region ships **`enabled: false`** until its own run of this check passes with
a real Kimi Code key — an enabled-and-known-broken preset must never ship. Re-run on
suspicion of upstream drift.

Needs: **your own Kimi Code plan key** (starts with `sk-kimi-`), a running polyrouter dev
stack on **Node 24** (`export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`,
`docker compose -f docker-compose.dev.yml up -d`, then `npm run dev`), ~15 minutes per
region. An agent never runs this for you and never uses a credential found on disk. The two
regions use separate hosts (`api.kimi.ai` international, `api.kimi.com` China) and you need a
key valid for each.

**Never paste the key into logs, commits or this file.** Type it into the dashboard field
only. When a step needs an agent key for `curl`, keep it in a shell variable you set by
hand (`read -s POLY_KEY`).

**Terms caution.** Kimi's community guidelines forbid reverse-proxy sharing, non-interactive
automation and altering the client identity, and name high-risk agents as harmful. Running
this against your account is your decision; a refusal (403/429) may be the identity gate, not
a bug. Do not retry in a loop.

## Which [U] facts this settles

- The `/coding/v1/models` listing path and shape under each host ([U], design D4).
- **Moonshot's allow-list answer.** Record here what Moonshot replied to your allow-list
  request (whether `polyrouter/` is allow-listed, and **whether a non-imitation
  `X-Msh-Platform` header is also required**). If a declared `X-Msh-Platform: polyrouter` is
  required, that is the follow-up "documented preset header" seam (design Risks and Open
  Questions); this change cannot send one. If the allow-list needs `X-Msh-Platform` only
  inside the imitation identity, add it to `KIMI_CODE_CLIENT_IDENTITY` (`X-Msh-Platform`)
  now.
- Whether polyrouter's **honest** `User-Agent: polyrouter/<version>` passes (the pi#7752
  relaxation, [U]) or Kimi refuses it until allow-listed.
- Whether the **imitation** identity (`claude-code/2.1.319`) passes on the pinned OpenAI path,
  and whether the declared string and version need updating (design D10; never `KimiCLI/`,
  clients that sent it were banned in May 2026).
- Therefore whether each region is **imitation-required** (design D12).
- Which token-cap spelling each region honours (`maxTokensSpelling`).
- The `sk-kimi-` prefix hint ([V]) matches your key (by eye only).
- Observation only: K3-series behaviour under translation (thinking off downgrades the
  model; K3.1 Pro rejects thinking-off [V]). Record anything odd; it is not addressed here.

## 1. Temporarily enable the region

In `key-presets.ts`, flip the region under test (`intl` first, then `cn`) to
`enabled: true` (local working copy only) and restart the dev stack. Check
`GET /api/providers/key-presets/available` (or the dashboard) lists **Kimi Code**.

## 2. Connect and confirm the key prefix

1. Dashboard → Providers → Add provider → **Subscription** → the **Kimi Code** card.
2. Choose the region, read the terms-risk copy, paste your key, **Connect**.
3. Confirm **by eye only** that your key starts with `sk-kimi-` (the card shows the hint and
   a caution otherwise). Do not copy the key anywhere. Record yes or no.

## 3. Test (the listing)

Press **Test** with the identity-imitation switch **off** (the default). Expected: success
with a model count. Record the **listing shape**, count, and any refusal (status, body shape,
never the key).

## 4. Sync

Press **Sync models**. Record the count and a few ids (plan ids such as `kimi-for-coding`
are not secrets).

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

Expected: a normal completion and stream. Cost shows as **unknown / flagged** on Kimi (no
family maps `api.kimi.ai` or `api.kimi.com`, by design). Record any non-2xx and typed error.

## 6. Capped completion (decides `maxTokensSpelling`)

Send one request with `"max_tokens": 16` and one with `"max_completion_tokens": 16` (through a
client, or by PATCHing the row's `maxTokensSpelling` in Edit). The honoured spelling keeps
`usage.completion_tokens` at or below the cap with `finish_reason: length`. If only
`max_tokens` works, set `maxTokensSpelling: 'max_tokens'` on the region.

## 7. Honest-UA pass, then the imitation pass

1. **Honest pass.** Steps 3 to 6 above, with the switch off, are this pass (exactly one
   `User-Agent: polyrouter/<version>` on the wire). Record **pass** or the refusal.
2. **Imitation pass.** Edit the row, turn on the **identity imitation** switch
   (`allow-preset-client-identity`; read and accept its warning), then repeat steps 3, 4, 5 and 6. The wire carries exactly one User-Agent, `claude-code/2.1.319` (or the string you
   updated). Record **pass** or the refusal. Turn the switch back off when done.
3. Decide: both pass, then honest mode is enough (`imitationRequired: false`). Only imitation
   passes, then set the region's `imitationRequired: true`, raise the preset to `high`, and
   update `riskCopy` to say Kimi currently refuses polyrouter's identity and imitation must
   be turned on in Edit (design D12). Neither passes: keep the region disabled.

## 8. Result table and enablement

For each region that passes: keep `enabled: true`, update drifted constants (listing path,
`maxTokensSpelling`, `keyHint`, identity string or version), record the date in the registry
comment, add a row below, and commit. On any failure: revert to `enabled: false` and document
the failure here.

Moonshot allow-list answer (date, reply, `X-Msh-Platform` required?): **not recorded yet**.

| Region | Date | Listing shape | Models | `maxTokensSpelling` | Honest UA | Imitation | Imitation-required | Result      | Notes                         |
| ------ | ---- | ------------- | ------ | ------------------- | --------- | --------- | ------------------ | ----------- | ----------------------------- |
| intl   | —    | —             | —      | —                   | —         | —         | —                  | **not run** | Ships disabled until verified |
| cn     | —    | —             | —      | —                   | —         | —         | —                  | **not run** | Ships disabled until verified |
