---
'@polyrouter/shared': patch
'@polyrouter/data-plane': patch
'@polyrouter/control-plane': patch
'@polyrouter/frontend': patch
---

Requests no provider ran no longer book a cost

A request that failed because every chain member was skipped by an open circuit
(or was refused locally, or was rejected by the provider with an error response)
was still recorded with an estimated cost: the router priced a guess at the prompt
size. Budgets metered that guess, so a retry storm against a down provider could
trip a `block` budget over spend that never happened.

Such a request now records `$0`, keeps its token estimate and price snapshot, and is
marked **not billed** in the Requests table and the inspector. Budgets and alerts
meter it as zero and no longer raise their "estimated" caveat from it, and the Costs
request mix counts it separately instead of as a free request. A request the provider
may have run (a timeout, a dropped connection, a stream that failed after its first
token, a client cancel) is recorded exactly as before.

Existing rows are not rewritten, so a budget period that already holds this spend
clears at its normal reset.

The inspector's unit prices also no longer print floating-point artifacts such as
`$0.09999999999999999 / 1M`.
