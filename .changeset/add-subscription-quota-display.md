---
'@polyrouter/data-plane': minor
'@polyrouter/control-plane': minor
'@polyrouter/frontend': minor
---

Subscription provider cards show how much of the plan is used, in one neutral line, with a Refresh usage button for key plans

**New on the Providers page.**

- **The usage line.** A subscription card shows each window's used percent and its reset time
  (`5h 62% · resets 14:10 UTC · weekly 31% · resets Nov 9, 18:00 UTC · as of 13:02 UTC`). The
  `as of` time is that of the oldest figure shown. A figure the provider did not send reads
  `unknown`, never `0%`, and a window past its reset reads `reset · awaiting new data`. When a plan
  is billing extra usage (Claude usage credits, ChatGPT credits, the OpenCode Go balance) the line
  leads with a phrase saying so. It states nothing about health, and it is hidden while the card
  shows a plan pause or a reconnect notice.
- **Where it comes from.** Claude, ChatGPT and OpenCode Go usage is read from the replies
  polyrouter already receives, with no extra call to the provider. A provider that sends nothing
  shows no line. Each model bucket ChatGPT reports sits under a "model limits" disclosure.
- **Refresh usage.** MiniMax M Plan, Kimi Code and Z.ai GLM Coding Plan (and OpenCode Go) cards
  get a **Refresh usage** button that reads the plan's own usage endpoint once, with polyrouter's
  own User-Agent and no model call. It runs at most once every five minutes per provider across
  all instances, says when it is next available, and reports a failure beside the button without
  changing the line. Every usage endpoint ships off until its live verification passes, so no
  card offers the button until a region passes.
- **The view and the endpoint.** The provider view gains `planUsage` (windows with their own
  observation times, and the billing state) and `planUsageRefresh` (`{ availableAt }`), and there
  is one new endpoint, `POST /api/providers/:id/plan-usage/refresh`, scoped to the owner and
  silent about health. Re-sending a key or reconnecting a provider discards its usage snapshot.

Display only: usage raises no alert, changes no routing and is polled by nothing. No database
migration.
