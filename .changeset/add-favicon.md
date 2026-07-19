---
"@polyrouter/frontend": patch
---

feat(dashboard): add the polyrouter mark as the favicon

An SVG favicon derived from the sidebar routing mark (accent + neutral tokens), with a
`prefers-color-scheme` block so it stays legible on dark browser chrome. Served from the
SPA's static assets — no third-party fetches, per the packaging rules.
