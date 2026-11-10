---
'@polyrouter/shared': minor
'@polyrouter/data-plane': minor
'@polyrouter/control-plane': minor
'@polyrouter/frontend': minor
---

Subscription cards graph each plan's usage, read about every 15 minutes

Every subscription plan with a usage endpoint is now read on a schedule, about every 15 minutes, by one instance at a time, so a card shows usage without any traffic. Claude Pro / Max and ChatGPT Plus / Pro gain usage endpoints (`https://api.anthropic.com/api/oauth/usage` and `https://chatgpt.com/backend-api/wham/usage`, read with polyrouter's own User-Agent; only the numbers are kept) and a Refresh usage button, and every usage endpoint now ships enabled, with the live runbook as optional QA. A scheduled read and Refresh usage share the 5-minute cooldown. Each tick records one sample per window in a new owner-scoped table, `plan_usage_sample`, kept 35 days, and under the usage line each window gets a 0–100% chart over its span with the reset marked; a window with no reading shows an empty track labelled "no reading yet", never 0%. Edit gains "Check plan usage on a schedule" (on by default) to stop the unattended reads for one provider. New: `GET /api/providers/:id/plan-usage/history`, and `checkPlanUsage` on the provider view and `PATCH /api/providers/:id`. Migration 0046 adds the table and the `provider.check_plan_usage` column (default true); usage stays display data only.
