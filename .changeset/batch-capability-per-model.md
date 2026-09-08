---
'@polyrouter/shared': patch
'@polyrouter/control-plane': patch
'@polyrouter/frontend': patch
---

Only offer the batch reservation for models the provider will actually batch — and align
the chain rows into columns.

**The control appeared where it could not work.** Batch capability was derived per
*provider*: "does this provider have a batch API", inherited by every model on it. That is
right for a native family, where the batch endpoint covers the account's models. It is
wrong for an aggregator — OpenRouter prices batch as a per-model SKU that only a minority
of its catalog carries — so the switch showed up on every priced OpenRouter model,
inviting a reservation the provider would not honour. The write was accepted, because the
provider seam passed; the refusal arrived later, at submission, or as a job discarded for
having no computable ceiling.

Capability now requires evidence for the MODEL on an aggregator family: the batch-priced
sibling twin the catalog already records. On a native family the seam still decides, since
batch there is not sold per model — deriving this from "a batch price resolved" instead
would have reported every Anthropic model unbatchable, Anthropic publishing none. One
shared rule answers the question for both the dashboard's flag and `PUT
/api/routing/tiers/:id/entries`, so the interface can never offer a reservation the API
refuses. Reservations already stored are untouched and can still be undone.

Also fixed: a capability filter on the model list (`supportsVision`, `supportsTools`)
could exclude a model's batch twin from the response and, with it, the evidence that the
model is batchable — reporting a capable model as incapable for a reason with nothing to
do with batch.

**The chain rows now read as a table.** The price was pushed right with an auto margin, so
everything after it landed wherever that row's own trailing content began: a row with the
reservation switch, a row without one, a row whose model id wrapped, and the primary row
(which has no "Make primary") each placed their price, control and actions at a different
position. The tier's chain is now one grid whose columns every row adopts, so the edges are
shared and sized from the whole chain rather than row by row.
