# dashboard-config Specification

## Purpose
TBD - created by archiving change add-dashboard-config. Update Purpose after archive.
## Requirements
### Requirement: The automatic-routing layers are toggleable per tenant and honored live

The system SHALL let each tenant enable/disable the automatic-routing layers (structural, cascade) via `GET`/`PUT /api/routing/auto-layers`, persisted per owner, and the proxy SHALL honor a tenant's setting **on the next request without a restart**. The instance's `ROUTING_AUTO_LAYERS` env is the **capability** (surfaced as `structuralAvailable`/`cascadeAvailable`); a tenant's preference is effective only within that capability (`effective = available && (preference ?? on)`), and enabling cascade implies enabling structural. The setting only gates the opt-in refinement of an `auto` request that fell through to the default tier — a thrown/rejected settings-read fault SHALL degrade to the instance default so the smart path never fails a request (invariant 1). The setting is owner-scoped (invariant 5).

#### Scenario: Toggling a layer off takes effect on the same running instance

- WHEN a tenant with structural enabled sends `model:"auto"` requests that structural-route to a configured band, then PUTs `structural:false`
- THEN subsequent `auto` requests from that tenant stay on the default tier (no structural routing) with no restart, and re-enabling structural restores structural routing

#### Scenario: A tenant cannot enable a layer the instance disabled

- WHEN the instance capability has cascade disabled (`ROUTING_AUTO_LAYERS` without cascade)
- THEN `GET /api/routing/auto-layers` reports `cascadeAvailable:false`, a tenant's `cascade:true` preference has no effect (cascade stays off), and the UI shows that layer as off instance-wide

#### Scenario: Enabling cascade enables structural

- WHEN a tenant PUTs `cascade:true, structural:false`
- THEN it is normalized so structural is also enabled (cascade needs structural's ambiguity signal), and the stored/returned state reflects both

#### Scenario: The auto-layer setting is tenant-isolated

- WHEN tenant A sets its auto-layer preference
- THEN tenant B's effective auto-layers are unaffected, and neither can read or write the other's setting

### Requirement: Routing is fully configurable from the dashboard

The Routing page SHALL manage the tenant's routing config against the real API: list tiers and their ordered model chains, and **reorder / add / remove / set-primary** models — persisted atomically via the ordered-chain replace (position 0 = primary, ≤5 models). It SHALL manage header rules (create/delete a `x-polyrouter-tier` value → `tier:<key>` / `model:<id>` mapping). The `default` tier is protected (not deletable).

#### Scenario: Reordering a tier's chain persists the new primary

- WHEN a user drags a model to the top of a tier's chain (or adds/removes one)
- THEN the tier's ordered `modelIds` are replaced via the API, position 0 becomes the primary, and the persisted order is reflected back

### Requirement: Budgets are fully configurable from the dashboard

The Limits page SHALL manage budgets against the real API: create/edit/delete a budget with scope (global/agent), window (day/week/month), **action (alert or block)**, amount, enabled, and the notification channels it targets. Cross-field violations (an agent-scoped budget with no agent) SHALL surface inline (422), owner-scoped.

#### Scenario: Creating a block budget wired to a channel

- WHEN a user creates a budget with action `block`, an amount, and a selected notification channel
- THEN it is persisted and appears in the list; an agent-scoped budget with no agent is rejected inline (422)

### Requirement: Notification channels are configurable with an inline test-send

The Settings→Notifications panel SHALL manage notification channels against the real API: add/edit/enable/delete SMTP or Apprise channels (the kind-specific credential config is write-only — never rendered back), subscribe each to specific event types, and **send a test** whose success/failure is shown inline (and updates the channel's last-test status).

#### Scenario: Send test surfaces the result inline

- WHEN a user clicks "Send test" on a channel
- THEN the API test-send runs and its `{ ok, error? }` result is shown inline (success or a sanitized failure) and the channel's last-test status refreshes; the stored credential is never displayed

