---
'@polyrouter/control-plane': minor
---

Notification emails are now branded HTML with a link back into the dashboard.
Every message ships as `multipart/alternative`: a text-only client sees exactly
the same wording as before, an HTML client sees a laid-out message carrying the
event and a link to the relevant page (a provider alert opens Providers, budget
alerts open Limits, and so on). Invite and password-reset emails share the same
layout.

The layout is deliberately asset-free — a text wordmark, no images, web fonts,
or externally hosted anything — so it renders identically on an instance that
isn't publicly reachable and triggers no remote fetches.

Links appear only when the instance has a routable address. If `BETTER_AUTH_URL`
is still the loopback default, links are omitted rather than sending a
`127.0.0.1` URL that would be useless in a recipient's inbox. Set it to your
instance's real address to enable them.

Chat channels (Apprise) now carry a per-event severity, so a provider-down or
budget-block notification is visually distinct from an informational summary at
the target, with the page link on its own line.
