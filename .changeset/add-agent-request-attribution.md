---
'@polyrouter/control-plane': minor
'@polyrouter/shared': minor
'@polyrouter/frontend': minor
---

Request surfaces now say which agent a request came from. The requests listing
gains an owner-scoped `agentId` filter, the table groups consecutive rows by
agent, and the Overview page names the agents accruing the range's traffic with
a click-through to their filtered rows. The breakdown endpoint gains a
`requests` ranking metric, without which a volume view inherits a spend ranking
and truncates out its highest-volume, lowest-cost agents.
