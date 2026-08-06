---
'@polyrouter/frontend': minor
'@polyrouter/control-plane': minor
---

The Costs breakdowns can now be ranked by tokens as well as spend, and every token figure
counts the work you were actually billed for.

The dashboard could tell you what each provider cost and nothing about how much work it
did — there was no token figure per provider, model or agent anywhere. That hides the
question a router exists to answer: a provider with a large share of tokens and a small
share of spend is doing cheap work, and heavy spend against few tokens is the opposite. The
three Costs panels now share a spend/tokens selector, and switching it **refetches** rather
than re-sorting: the API returns a top-N, so re-ordering the rows already on screen would
have shown "top by tokens" while silently dropping any provider that leads on tokens and
trails on spend.

**Two corrections to what "tokens" means, both of which move numbers you may be watching.**

Token totals now sum **both cost ledgers**. An escalated cascade attempt consumes tokens the
provider meters and bills, and spend has always counted them — the token figures did not, so
they under-reported real usage on every request the cascade escalated.

Token totals now also include **cached tokens**. `input_tokens` is recorded as *uncached*
input, because the adapters subtract cached tokens out and record them separately; a figure
built from input + output alone therefore omitted a cached workload's largest component
while looking exact.

Both changes flow through the summary, the timeseries and the breakdowns together, so no two
token numbers in the product can mean different things. **The Overview's token headline will
read higher** than it did for the same range — that is the fix, not a display change, and it
is larger the more caching and cascade escalation your traffic does. The headline now shows
a cached component beside its in/out split.

Nothing that decides anything reads these figures: budget enforcement, alert thresholds and
routing use their own spend-only paths and are untouched, as is every recorded cost and
price snapshot. `GET /api/analytics/breakdown` gains an optional `metric` parameter
(`spend` by default, so existing callers are unaffected) and returns the four token
components plus an `estimatedTokens` figure disclosing how much of the total came from
providers that did not report usage.
