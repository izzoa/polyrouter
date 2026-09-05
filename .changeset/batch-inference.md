---
'@polyrouter/shared': minor
'@polyrouter/data-plane': minor
'@polyrouter/control-plane': minor
'@polyrouter/frontend': minor
---

Add batch inference: submit, track, read and cancel provider batch jobs.

Batch is an execution **mode**, not a model. `POST /v1/batches` takes a JSONL body
of ordinary chat/messages requests on the same agent key the sync endpoints use,
routes the job like any other request, and hands it to the provider's own batch
API. `GET /v1/batches/{id}` reports progress, `/results` streams the outcomes back
as they are read from the provider, and `DELETE` cancels. Adapters ship for
OpenRouter, Anthropic and OpenAI; a provider without one simply offers no batch
seam rather than failing at submit time.

**polyrouter stores no results.** They stay with the provider until its retention
window ends and are streamed through on demand, so the batch surface keeps the
same metadata-only guarantee as the request path.

**A reservation is not a charge.** Submitting reserves a ceiling against the
agent's budget so a batch cannot silently outspend it, and the reservation is
released and replaced by real, snapshotted per-item cost as the job settles. The
dashboard says which of the two a number is, everywhere it shows one. Settlement
is durable and chunked: a restart mid-settlement resumes rather than
double-charging, and a job whose submission was lost is recorded as costing
nothing.

Batch items are priced at the provider's batch rate — the `:batch` twins the
previous release stopped routing to are now what a batch job is billed against —
and recorded with an explicit price mode, so batch and sync spend are separable in
analytics without recomputing anything.

The dashboard gains a **Batches** page (status, progress, wall time, cost, and the
provider's retention deadline, with Cancel behind the usual confirmation), a
Mode filter on Requests, and a link from a request's inspector to the job it came
from.
