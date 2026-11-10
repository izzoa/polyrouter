---
'@polyrouter/shared': minor
'@polyrouter/control-plane': minor
'@polyrouter/frontend': minor
---

A subscription provider's Terms risk notice can be dismissed

The Terms risk notice on each subscription provider's card now has a `×`. Dismissing it records the acknowledgment on the server for that provider, so the notice stays gone on every browser and device, and the card shows nothing in its place; the add-provider dialog still states each plan's terms risk. Each provider is dismissed separately, and a provider whose kind is changed away from subscription and back shows the notice again. Notices about conditions that end once fixed (Reconnect needed, Unverified, Couldn't load, failures) still have no dismiss. New: `POST /api/providers/:id/terms-risk/acknowledge` (owner-scoped; 422 for a provider that is not a subscription) and `termsRiskAcknowledgedAt` on the provider view. Migration 0047 adds the nullable `provider.terms_risk_acknowledged_at` column; every existing provider starts unacknowledged.
