# Live verification — OpenCode Go key preset (add-key-subscription-presets)

The OpenCode Go preset's endpoint, listing URL and response shape are **ecosystem-known, not
documented contracts** (`packages/control-plane/src/subscription-presets/key-presets.ts`,
`OPENCODE_GO_PRESET`). This check is **optional QA** (redesign-subscription-picker): every
region ships **enabled**, so a run is not a precondition to ship. Run it with your own key to
settle the [U] values below, or when a user reports a failure. Re-run on suspicion of upstream
drift.

Needs: **your own OpenCode Go plan key** (a plain account key, no documented prefix), and a
running polyrouter dev stack on **Node 24** (`export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`,
`docker compose -f docker-compose.dev.yml up -d`, then `npm run dev`), ~10 minutes. An
agent never runs this for you and never uses a credential found on disk.

**Never paste the key into logs, commits or this file.** Type it into the dashboard field
only. When a step needs an agent key for `curl`, keep it in a shell variable you set by
hand (`read -s POLY_KEY`), never in the command line history or a file.

## Which [U] facts this settles

- The pinned base URL `https://opencode.ai/inference/go/openai/v1` completes a chat request
  with a Bearer key (research [V], design D4).
- The listing override `https://opencode.ai/inference/go/v1/models` (a different path from
  the OpenAI base) answers, and **its response shape** parses with the existing OpenAI
  listing parser ([U], design D4 and D5). If it does not parse, Test and Sync fail with a
  typed provider error and the region is withdrawn; never a hard-coded model list.
- Which token-cap spelling the endpoint honours (`maxTokensSpelling`, design Risks).
- That polyrouter's honest `User-Agent: polyrouter/<version>` is accepted (OpenCode Go
  declares no imitation identity, so there is no imitation pass).
- Whether a request needs an `x-opencode-session` header ([U]; a recorded follow-up, not
  sent by this change).

## 1. Confirm the region is listed

Start the dev stack and check that `GET /api/providers/key-presets/available` (or the
dashboard's Add provider → Subscription list) lists **OpenCode Go**. Every region ships
enabled. If this one was withdrawn (`enabled: false` in `key-presets.ts`), flip it to `true` in
your local working copy only and restart the stack.

## 2. Connect

1. Dashboard → Providers → Add provider → **Subscription** → the **OpenCode Go** card.
2. Read the terms-risk copy, paste your key, **Connect**.
3. Confirm by eye only that the new row is named **OpenCode Go**, kind **Subscription**, and
   that the endpoint is the pinned URL. Do not copy the key anywhere.

Record: whether the row appeared with `keyPreset` set (Edit shows "Subscription — OpenCode
Go").

## 3. Test (the listing)

Press **Test** on the row. Expected: success with a model count. Record the **listing shape**
(a top-level `data` array of `{ id }` like OpenAI, or something else) and the count. A typed
parse or HTTP error means the listing path or shape is wrong: record the status and body
shape (never the key) and withdraw the region (`enabled: false`).

## 4. Sync

Press **Sync models**. Expected: the plan's models appear on the row. Record the count and a
few ids (these are not secrets).

## 5. One buffered and one streamed completion

Pick one synced model id from step 4 and send, with an agent key in `$POLY_KEY`:

```sh
curl -sS http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer $POLY_KEY" -H 'content-type: application/json' \
  -d '{"model":"<synced-model-id>","messages":[{"role":"user","content":"Say ok."}]}'

curl -sSN http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer $POLY_KEY" -H 'content-type: application/json' \
  -d '{"model":"<synced-model-id>","stream":true,"messages":[{"role":"user","content":"Say ok."}]}'
```

(Adjust the host and port to your dev stack.) Expected: a normal completion and a normal SSE
stream ending in `[DONE]`. Check the request log row: provider kind **subscription**, cost
shown as **notional / unknown** (OpenCode Go serves several vendors' models, so its cost is
null and flagged by design). Record any non-2xx and the typed error.

## 6. Capped completion (decides `maxTokensSpelling`)

Send one request with a small cap (`"max_tokens": 16`, then `"max_completion_tokens": 16`
through a client or by PATCHing the row's `maxTokensSpelling` to each value in Edit). The
spelling the endpoint honours is the one for which `usage.completion_tokens` stays at or
below the cap and `finish_reason` is `length`. Record which spelling(s) work. If only
`max_tokens` works, set `maxTokensSpelling: 'max_tokens'` on the region.

## 7. Honest-UA pass

The default is the only mode: polyrouter sends exactly one `User-Agent: polyrouter/<version>`.
Steps 3 to 6 above were that pass. Record **pass** or the refusal (status, body shape). There
is no imitation pass: OpenCode Go declares no identity, so a refusal here withdraws the region (never `imitationRequired`).

## 8. Result table and outcome

On a fully passing run: keep `enabled: true` for the region, update any constants that drifted
(`modelsUrl`, `maxTokensSpelling`), record the verification date in the registry comment, add a
row below, and commit. On a failure: withdraw the region (ship it `enabled: false`; rows
already connected from it keep working) or fix the drifted constant, and document the failure
here.

| Region  | Date | Listing shape | Models | `maxTokensSpelling` | Honest UA | Imitation | Result      | Notes                      |
| ------- | ---- | ------------- | ------ | ------------------- | --------- | --------- | ----------- | -------------------------- |
| default | —    | —             | —      | —                   | —         | n/a       | **not run** | Ships enabled; not run yet |
