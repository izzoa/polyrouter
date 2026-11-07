# Live verification — MiniMax M Plan key preset (add-key-subscription-presets)

The MiniMax M Plan preset's regions are **not all verified**
(`packages/control-plane/src/subscription-presets/key-presets.ts`, `MINIMAX_M_PLAN_PRESET`):
the international host is [V], the China host and the `sk-cp-` key prefix are [U]. Per the
spec, each region ships **`enabled: false`** until its own run of this check passes with a
real Coding Plan key — an enabled-and-known-broken preset must never ship. Re-run on
suspicion of upstream drift.

Needs: **your own MiniMax Coding Plan key**, a running polyrouter dev stack on **Node 24**
(`export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`,
`docker compose -f docker-compose.dev.yml up -d`, then `npm run dev`), ~10 minutes per
region. An agent never runs this for you and never uses a credential found on disk. You need
a key per region you want to verify; a China-region key (`api.minimaxi.com`) is separate from
an international one.

**Never paste the key into logs, commits or this file.** Type it into the dashboard field
only. When a step needs an agent key for `curl`, keep it in a shell variable you set by
hand (`read -s POLY_KEY`).

## Which [U] facts this settles

- **MiniMax's general Terms of Service** (JS-rendered, unread [U]; design Open Questions).
  Before any region is enabled, **re-read the ToS at the live site** and record, in the table
  below, whether it adds a resale, proxy or automation clause that applies to a plan key used
  through a personal router. If it does, MiniMax's level and copy change before enablement.
- The China host `https://api.minimaxi.com/v1` serves the same OpenAI path ([U]).
- The `/models` listing path and shape under each host ([V per research body; re-verify]).
- The key prefix `sk-cp-` ([U]): if confirmed by eye, add it to `keyHint` (prefix
  `sk-cp-`) in the registry; if not, it stays unhinted.
- Which token-cap spelling each region honours (`maxTokensSpelling`).
- That polyrouter's honest `User-Agent: polyrouter/<version>` is accepted (MiniMax declares
  no imitation identity, so there is no imitation pass).
- That a Coding Plan key is billed to the plan, **not your pay-as-you-go balance**: check your
  MiniMax balance before and after the completions in step 5.

## 1. Temporarily enable the region

In `key-presets.ts`, flip the region you are testing (`intl` first, then `cn`) to
`enabled: true` (local working copy only) and restart the dev stack. Check
`GET /api/providers/key-presets/available` (or the dashboard) now lists **MiniMax M Plan**
with that region.

## 2. Connect and confirm the key prefix

1. Dashboard → Providers → Add provider → **Subscription** → the **MiniMax M Plan** card.
2. Choose the region, read the terms-risk copy, paste your key, **Connect**.
3. Confirm **by eye only** whether your key starts with `sk-cp-`. Do not copy the key
   anywhere. Record yes or no.

## 3. Test (the listing)

Press **Test**. Expected: success with a model count. Record the **listing shape** and count.
A typed parse or HTTP error means the listing path is wrong for this host: record status and
body shape (never the key) and keep the region disabled.

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

Expected: a normal completion and a normal stream ending in `[DONE]`. The request log row is
provider kind **subscription**; on `api.minimax.io` its cost is **notional**, priced at the
`minimax` family's API rates (design D4 and Risks); on `api.minimaxi.com` the cost is null
and flagged. Check the MiniMax balance did not drop. Record any non-2xx and its typed error.

## 6. Capped completion (decides `maxTokensSpelling`)

Send one request with `"max_tokens": 16` and one with `"max_completion_tokens": 16` (through a
client, or by PATCHing the row's `maxTokensSpelling` in Edit). The honoured spelling keeps
`usage.completion_tokens` at or below the cap with `finish_reason: length`. Record which
works. If only `max_tokens` works, set `maxTokensSpelling: 'max_tokens'` on the region.

## 7. Honest-UA pass

Polyrouter sends exactly one `User-Agent: polyrouter/<version>`; steps 3 to 6 were that pass.
Record **pass** or the refusal. MiniMax declares no identity, so a refusal keeps the region
disabled (never `imitationRequired`).

## 8. Result table and enablement

For each region that fully passes **and** after the ToS re-read: keep `enabled: true`, update
drifted constants (`keyHint` prefix, `maxTokensSpelling`), record the date in the registry
comment, add a row below, and commit. On any failure: revert to `enabled: false` and document
the failure here.

| Region | Date | ToS re-read result | `sk-cp-` seen | Listing shape | Models | `maxTokensSpelling` | Honest UA | Result      | Notes                         |
| ------ | ---- | ------------------ | ------------- | ------------- | ------ | ------------------- | --------- | ----------- | ----------------------------- |
| intl   | —    | —                  | —             | —             | —      | —                   | —         | **not run** | Ships disabled until verified |
| cn     | —    | —                  | —             | —             | —      | —                   | —         | **not run** | Host is [U]; ships disabled   |
