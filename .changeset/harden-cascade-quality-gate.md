---
'@polyrouter/data-plane': minor
'@polyrouter/control-plane': minor
---

The cascade's quality gate is sharper. When a request declared structured
output (`response_format` json, or Anthropic `output_config.format`), a cheap
answer that isn't parseable JSON now escalates to the strong tier — prose
where JSON was demanded is a capability failure, not a style choice
(tool-calling and paused turns are exempt). Truncation (`length` stop) grades
0.5 instead of a clean 1: at the default quality threshold the served tier is
unchanged (the recorded quality_signal visibly becomes 0.5), and thresholds
above 0.5 now meaningfully escalate truncated cheap answers. One deliberate
escalation change at defaults: demanded JSON cut off by the token cap is
invalid JSON and escalates, where it previously served broken output.
