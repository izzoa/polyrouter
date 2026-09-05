# Batch-seam golden fixtures (add-batch-inference)

Contract fixtures for the two batch implementations shipped in Phase B. Each
pins what polyrouter SENDS (envelope, key order, per-item wire body) and how it
READS the upstream's objects (status vocabulary, counts, retention, per-item
outcomes), so an upstream shape change fails here before it fails a settlement.

## Provenance

Hand-authored to the published documentation as of 2026-09:

- `openrouter/` — the Batch API quickstart (`POST /api/beta/batches`, inline
  `requests[]`, `endpoint`/`model` serialized before `requests`, results inlined
  on the GET of a completed batch, list with `first_id`/`last_id`/`has_more`,
  30-day artifact retention). The cancel route is inferred from the object's
  OpenAI-compatible conventions and pinned only through the stub.
- `anthropic/` — the Message Batches API reference (`/v1/messages/batches`,
  `requests[{custom_id, params}]`, `processing_status` in
  `in_progress | canceling | ended`, five-way `request_counts`, JSONL results,
  29-day retention, `custom_id` grammar `^[a-zA-Z0-9_-]{1,64}$`).

- `openai/` — the published OpenAPI document (`POST /v1/files` with purpose `batch`,
  `POST /v1/batches` with `input_file_id` + `completion_window: "24h"` + `metadata`,
  the eight-value status enum, `{total, completed, failed}` counts, results split
  across `output_file_id` and `error_file_id`, and NO output expiry unless one is
  requested at create time — hence a null retention deadline).

No live keys or account data are embedded. `retrieve-ended.json` deliberately
carries a foreign `results_url` to pin that the adapter reads results from the
batch's OWN path on the configured origin — the credential can never follow an
echoed URL elsewhere.
