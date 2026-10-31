---
'@polyrouter/shared': minor
'@polyrouter/control-plane': minor
'@polyrouter/frontend': minor
---

Retired models are removed automatically

**Upgrade note:** on the first sync after upgrading (a manual Sync, or the next daily
catalog refresh), every model already marked "no longer offered" that no tier chain or
rule uses is deleted. A deleted `custom` or `local` model also loses any price you typed
in for it, and a stale `:batch` twin takes its base model's batch rate with it. If a
model comes back, the next sync re-creates it as a new row. Turn this off per provider
with **Remove retired models automatically** in the provider's edit dialog.

A sync used to flag a model the provider stopped listing and leave it until you removed
it by hand. Now, when a successful listing sync finds a model that has stayed unlisted
for seven days, it deletes the model, unless a tier chain or a `model:` rule still uses
it. Referenced models are never deleted and stay flagged, so routing never changes under
you. A listing that is empty, truncated, from a replaced credential, or aborted prunes
nothing, and request history and recorded cost are untouched.

- A new per-provider switch, `autoPruneUnlisted` (on by default, including for existing
  providers), is accepted on provider create and update and shown in the edit dialog.
- A sync result carries `pruned`, and the Sync toast says how many retired models were
  removed; the daily refresh logs the total.
- Saving a tier chain or a rule that names a model now locks that model's row first, so
  a save and a prune can never interleave: one wins, and a save that loses is rejected as
  naming an unknown model.
- One migration adds `provider.auto_prune_unlisted`.
