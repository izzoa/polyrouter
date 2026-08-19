---
'@polyrouter/shared': minor
'@polyrouter/data-plane': minor
'@polyrouter/control-plane': minor
'@polyrouter/frontend': minor
---

Output-cap guardrails: on router-chosen routes (tiers, headers, rules, default, auto), polyrouter now plans each fallback chain against the models' known `max_output_tokens` (ingested from the LiteLLM catalog, refreshed daily). Members that cannot satisfy the request's `max_completion_tokens` are deferred behind members that can (recorded as `output_cap_deferred` in the routing reason — note this means capacity can outrank a subscription member's quota-first position across stages, never within one); when every member's known cap is insufficient, the chain is walked in configured order with each attempt clamped to its own cap (`output_cap_clamped`, honest `finish_reason: "length"` on truncation) instead of dying on a guaranteed provider 400. Explicitly-named models are never touched (provider parity), unknown caps never defer or clamp, a cap-lookup failure fails open, and the synthesized Anthropic `max_tokens` default is now capped to the dispatched model's known limit.
