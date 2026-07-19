---
"@polyrouter/frontend": patch
---

feat(routing): group the add-model dropdown by provider

The tier "+ Add model…" dropdown now renders native `<optgroup>` sections — one per
provider, labelled with the provider's name — with models sorted alphabetically inside
each group and groups sorted by name. The Routing page also loads the provider list on
mount so group labels resolve even when the Providers page was never visited.
