---
'@polyrouter/shared': minor
'@polyrouter/control-plane': minor
---

Make routing, spend limits, and notifications fully configurable from the dashboard, and add a per-tenant opt-out for the automatic routing layers (#20, spec §7/§15). The three Configure pages (Routing, Limits, Settings→Notifications) — previously an in-memory simulator behind a "preview" banner — now read and write live, tenant-scoped config through the `/api/routing`, `/api/budgets`, and `/api/notification-channels` endpoints.

**New backend capability — per-tenant auto-layer toggle.** The opt-in smart routing layers (structural / cascade) were enabled only instance-wide via `ROUTING_AUTO_LAYERS`. A tenant can now opt a layer OFF for their own traffic while the instance capability stays the ceiling:

- New owner-scoped `routing_settings` table (migration `0007`): one row per owner, `structural_enabled`/`cascade_enabled`, a unique-owner index, and a `cascade ⇒ structural` CHECK backing the write-time normalization.
- New `GET/PUT /api/routing/auto-layers` (session-guarded, owner-scoped) → `{ structural, cascade, structuralAvailable, cascadeAvailable }`. `*Available` is the boot capability (`autoLayerCapability` over the injected `ROUTING_CONFIG`, never a fresh env read, so the reported capability can't drift from what the routers enforce). `PUT` is a full replacement (both booleans required) that normalizes `cascade → structural`.
- **Effective = capability × preference.** The proxy reads the preference LAZILY — only on an `auto`→default request — masks it against the capability, and **degrades to the capability default on any fault** (a throw, a rejection, or a never-settling read; the read is deadline-bounded), so a settings-read fault can never fail or stall a request (invariant 1). The read is skipped entirely when structural is off instance-wide. No changes to the `StructuralRouter`/`CascadeRouter` classes — the per-tenant gate composes with their internal global gate.

**Frontend (private package) — the Configure pages go live.**

- **Routing:** tiers + the ordered ≤5-model chain (drag-reorder / add / remove / set-primary, persisted via one `PUT …/entries` on drop), the real model id + price per row, header-rule CRUD (`x-polyrouter-tier` → `tier:<key>`), tier create/delete, and the auto-layer card (each toggle → `setAutoLayers`; a layer greyed with "off instance-wide" when `*Available:false`; cascade-on mirrors structural-on; L2 semantic stays locked).
- **Limits:** budget CRUD (scope global|agent + agent picker, window, alert|block, amount, notify-channel multi-select, enabled) with the inline agent-needs-agentId 422; the simulated live-spend bar is dropped (config-only page).
- **Notifications (Settings):** channel CRUD with write-only SMTP/Apprise config and event-subscription checkboxes, an enable toggle, and inline "Send test" → `{ ok, error? }`. Decrypted config is never returned by the API or shown.
- **State discipline:** tier and auto-layer writes are per-key single-flight (coalesce to the latest desired state, roll back to a confirmed snapshot on failure, never lose a newer edit); every loader is guarded by a per-domain mutation sequence so a slow GET can't clobber a just-persisted write; channel saves reconcile the returned row directly; saves / test-sends / enable-toggles are single-flight against double-submit.

Owner-scoping is enforced centrally for `routing_settings` (invariant 5); the proxy's per-tenant read never fails a request (invariant 1); channel and provider secrets stay write-only.
