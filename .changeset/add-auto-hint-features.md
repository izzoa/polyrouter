---
'@polyrouter/data-plane': minor
'@polyrouter/control-plane': minor
---

`model: auto` now honors client-declared complexity. OpenAI `reasoning_effort`
(including `xhigh`/`max`), Anthropic `thinking` (enabled budgets, `adaptive`,
`disabled`), and Anthropic `output_config.effort` become a Layer-1 signal: a
maximal declaration routes a request to the `auto_high` target directly, low
declarations bias the structural score downward (a declared `none` on an
otherwise-ambiguous request takes the cheap path without cascade), and
`response_format`/`output_config.format` count as structured-output demand.
Requests without declared controls score byte-identically to before — ambient
weights, thresholds, and existing `ROUTING_STRUCTURAL_WEIGHTS` overrides are
untouched; the new optional `reasoning` key in that JSON tunes the adjustment
magnitude ([0, 0.5], default 0.1). Anthropic `output_config` also now passes
through same-protocol requests verbatim (dropped, documented, crossing to
OpenAI).
