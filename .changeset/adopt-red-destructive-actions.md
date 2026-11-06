---
'@polyrouter/frontend': minor
---

Destructive actions are red: a red-outlined trigger and a red commit in a dashboard dialog, replacing the amber button and the browser's native prompts

**Visual change.** The buttons that delete, remove, purge, disable or cancel are a red-outlined
ghost: red text on a red border, a red wash when hovered, and a thicker red border when pressed.
Amber, a status colour, is no longer used on any button.

- **One confirmation dialog.** Deleting an agent, provider, budget, notification channel or user,
  disabling a user, removing a model the provider no longer lists, purging stored bodies and
  cancelling a batch all ask in the same dashboard dialog, never the browser's native prompt. Its
  title names the action and the resource, its body states the consequence, Cancel comes first
  and holds focus, and the commit is a red button named for the verb (`Delete agent`, never `OK`).
- **Busy and failure in place.** While the request runs, the commit reads `Deleting…` (or the
  action's own word) and the dialog cannot be dismissed. A failure is reported inside the dialog,
  which stays open so you can retry or cancel; nothing is removed from the page.
- **The inspector's payload Delete asks first.** It used to delete a request's stored bodies at
  once, from a red link.
- **Turning body capture off** asks keep-or-purge in the same dialog: Keep until retention turns
  capture off and keeps the stored bodies until they expire; Purge now also deletes them.
- **Forward-looking copy.** The dialogs say what will happen to new requests (for example, `New
  requests with its key will be refused.`) rather than promising an instant cut-off.
- Enabling body capture still asks for consent with the primary button, and recoverable actions
  (Rotate key, Enable, Revoke an invitation, Revert to bundled) keep the neutral ghost.

No API, routing behavior or stored data changed.
