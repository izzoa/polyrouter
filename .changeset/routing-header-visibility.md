---
'@polyrouter/control-plane': patch
'@polyrouter/data-plane': patch
'@polyrouter/frontend': patch
'@polyrouter/shared': patch
---

The request inspector shows which header chose the route
(add-routing-header-visibility): a header-routed request (`decision_layer =
header`) now records the matched header structurally — the built-in
`x-polyrouter-tier` header records its name plus the matched owned tier key;
a custom header rule records its header **name only** (a configured rule value
can itself be a credential and is never persisted — fail-closed) — in two new
nullable `request_log` columns, exposed on the analytics request listing and
rendered as a dedicated `header` row in the inspector's DECISION section.
Non-header decisions and rows predating the columns render exactly as before.
