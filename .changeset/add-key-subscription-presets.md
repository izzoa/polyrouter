---
'@polyrouter/shared': minor
'@polyrouter/data-plane': minor
'@polyrouter/control-plane': minor
'@polyrouter/frontend': minor
---

Connect OpenCode Go, MiniMax M Plan, Kimi Code and Z.ai GLM Coding Plan with an API key

Four coding plans now have presets on **Add provider** → **Subscription**: pick the plan, a region where
there are several, paste the plan key, and Connect. The endpoint and protocol are pinned by the preset, so
there is no URL to type. Each card states that plan's terms risk in words with a link to its terms, and
Z.ai (whose terms forbid proxy use) needs an explicit acknowledgement. A key that does not look like the
plan's key shows a caution that it may be a pay-as-you-go key, but never blocks. Edit shows the pinned
endpoint read-only and lets you rename the provider or rotate its key. Kimi Code and Z.ai also declare an
optional "Claude Code" identity behind the existing identity-imitation switch, off by default.

**A region is offered only after its live verification passes**, so no card is offered until a region passes its live
verification, i.e. until each runbook has been run with a real key. "Other subscription" is unchanged.

Adds a database migration (one nullable column on the provider row, no backfill).
