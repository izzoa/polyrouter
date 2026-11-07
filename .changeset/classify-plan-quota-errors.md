---
'@polyrouter/shared': minor
'@polyrouter/data-plane': minor
'@polyrouter/control-plane': minor
'@polyrouter/frontend': minor
---

A coding plan that runs out of allowance pauses its provider instead of tripping the breaker

For the Z.ai, MiniMax M Plan and Kimi Code key presets (their international hosts, plus Kimi Code's China host), polyrouter now reads the provider's own
quota, risk-control, inactive-plan and entitlement errors and acts on them. An exhausted plan, a throttled account
or an inactive key pauses that provider until the reset time the provider stated (or a default, between 1 minute
and 7 days), chains skip it without contacting it and fall back, and the pause is shared through Redis so every
instance agrees. These failures no longer count toward the circuit breaker, so a plan that is simply out of
allowance no longer raises `provider_down`.

**Client-visible change:** a recognised plan exhaustion now answers with the code `plan_quota_exhausted`, and a
risk-control throttle with `plan_risk_control`, where both used to be `rate_limited`. The HTTP status is still
429, so clients that branch on the status are unaffected. An inactive plan answers 502 `plan_inactive`, and a plan
that does not include the model 403 `plan_entitlement`.

The provider's card shows one amber line with the reason and the time, and a **Resume now** button that lifts the
pause (a risk-control pause asks first, because sending again early may make the provider restrict the account).
The Request inspector's route trace marks a skipped member as plan paused. OpenCode Go and the Z.ai and MiniMax China hosts keep the generic error mapping until a real exhaustion response is captured. No database migration.
