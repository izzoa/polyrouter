---
'@polyrouter/frontend': patch
'@polyrouter/control-plane': patch
---

Fixed: the OpenClaw connection snippet — shown in Agents → New, returned by the agent-create
API, and printed in the README — described a config file OpenClaw cannot read (TOML at
`~/.openclaw/config.toml` with an `[llm]` table; OpenClaw's only config is JSON5 at
`~/.openclaw/openclaw.json`). Following it failed silently. The snippet now emits the real
format: a `models.providers` entry for the router with `api: "openai-completions"` and a
single `auto` model, selected as the default via `agents.defaults.model`.
