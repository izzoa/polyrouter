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

**To get the links, set `APP_URL` to the address your users actually reach the
dashboard at, then restart.** They appear only from a routable origin: with the
default (`http://localhost:3001`) the link is omitted rather than sending a
`127.0.0.1` URL that would be dead in a recipient's inbox — and setting `APP_URL`
to a loopback value explicitly does the same, deliberately. A LAN or `.local`
address works and is often the right one for a self-hosted instance. The value is
read at boot, so a restart is required after changing it.

Chat channels (Apprise) now carry a per-event severity, so a provider-down or
budget-block notification is visually distinct from an informational summary at
the target, with the page link on its own line.
