---
'@polyrouter/frontend': patch
---

Reconnect opens the sign-in steps, not the add-provider form

Clicking **Reconnect** on a provider card opened the generic "Add provider" form
(name, kind, pasted credential) with no way to renew the sign-in. The connect
wizard was only shown once the list of sign-in presets had loaded, and only the
"Add provider" button loads it — so a Reconnect clicked before any other provider
dialog showed the paste form, and pressing its button just reported "Name is
required". A leftover "Other subscription" toggle hid the wizard the same way.

Reconnect now opens its own view, titled "Reconnect <name>": it shows only the
two sign-in steps for that provider (open the link, paste what you land on),
"Starting sign-in…" while the session is created, and the reason plus a
**Try again** button if it cannot start. Completing it renews the same provider
in place and runs one Test.
