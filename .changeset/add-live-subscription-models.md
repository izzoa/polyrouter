---
'@polyrouter/shared': minor
'@polyrouter/data-plane': minor
'@polyrouter/control-plane': minor
'@polyrouter/frontend': minor
---

Subscription models come from the provider — a retired model can't break Test again

OpenAI retired `gpt-5.4-mini` on 2026-09-22. polyrouter's ChatGPT preset had that id
built in as the model its Test called, so every Test of a correctly signed-in ChatGPT
provider failed with "invalid request to provider" — and its built-in model list could
never learn about GPT-6.

- **No preset names a model any more.** The ChatGPT preset now lists the backend's own
  model catalog (the endpoint the Codex CLI reads — verified live with only polyrouter's
  three identity headers), and for Claude and ChatGPT alike **Test is the model listing**:
  it names no model, so a retirement can't fail it. A revoked sign-in still reports
  `auth`, and a changed catalog format now fails Test visibly instead of "ok, 0 models".
- **Retired models are flagged, never silently kept or deleted.** When a provider's
  listing stops offering a model polyrouter synced, the model is marked "no longer
  offered" (with the date first noticed) on the Providers page, in the model picker, and
  on every tier entry and rule that routes to it. Routing is unchanged — it still sends
  there and a rejection walks your chain. A listing that is empty, cut short, or made
  with a credential or endpoint that has since changed flags nothing. Applies to every
  provider whose models you Sync.
- **Remove an unlisted model** from its provider card; the confirmation says how many
  tier entries will be dropped and how many rules will lose their target. A model the
  provider still lists can't be removed (`DELETE /api/models/:id` → 409).
- **Every provider's model list refreshes itself about once a day** — API-key, custom,
  local, and subscription providers alike (a provider with no credential, or waiting to
  be reconnected, is skipped). It is a budgeted, round-robin background job on its own
  queue that only lists models (no chat, no Test), records nothing on the provider's
  status, cancels a listing that runs past its deadline, and retries a failure after
  about an hour. Sync models still refreshes on demand.
- Fixed: a model's provider-listed context window and vision claim were only written on
  its first sync; they are now rewritten on every sync, as documented.
