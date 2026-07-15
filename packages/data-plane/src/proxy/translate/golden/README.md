# Protocol-translation golden fixtures

These fixtures back the contract suite for the `Normalized*` IR (spec §6.3,
CLAUDE.md invariant 2). They are the committed source of truth for how the
OpenAI Chat Completions and Anthropic Messages wire formats translate through
the IR.

## Provenance

The fixtures are **hand-authored to the documented wire formats** of each
provider (OpenAI Chat Completions; Anthropic Messages `2023-06-01`) as of
2026-07. No live provider keys are used, so no real tokens or account data are
embedded. The base64 image bytes are a 1×1 transparent PNG.

Refreshing these from **sanitized live captures** (when keys exist) is a
maintenance follow-up — the round-trip and cross-translation contracts hold
regardless of the fixture's source, because they compare a payload against its
own normalized form, not against a provider's live output.

## What each fixture exercises

- `plain` — a system prompt + a plain turn; response usage incl. cache tokens.
- `tools-multiturn` — a multi-turn tool exchange with **parallel** tool calls;
  the Anthropic case includes two `tool_result` blocks (one `is_error`) plus
  **trailing user text** in the same turn — the grouping/splitting crux.
- `multimodal` — a base64 image (+ an OpenAI remote-URL variant, preserved not
  fetched; `detail` on the OpenAI side).
- `malformed-tool` — an assistant tool call whose `arguments` are invalid JSON;
  represented as an `inputParseError` block, never thrown.
- `streamed` — a text stream and a tool-call stream, exercising the usage
  lifecycle (Anthropic start/delta; OpenAI empty-`choices` terminal chunk),
  per-block tool-JSON assembly, and split-frame tolerance.

## Error matrix

The `error` cases covered by the suite are **in-band** stream `error` events and
malformed/edge wire payloads (e.g. invalid tool JSON, split SSE frames). HTTP
transport errors (non-2xx, connection failures) are **out of scope here** — they
belong to the provider layer (#6) and the proxy (#10).
