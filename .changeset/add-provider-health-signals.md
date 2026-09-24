---
'@polyrouter/control-plane': minor
'@polyrouter/frontend': minor
'@polyrouter/data-plane': minor
'@polyrouter/shared': minor
---

Show provider health without a Test, keep sign-ins renewed, and reconnect in place

A provider card only showed a failure after someone clicked **Test**: live traffic
that was being rejected tripped the breaker and fired `provider_down`, but never
touched the card. OAuth sign-ins renewed only when a request happened to arrive
within five minutes of expiry, so a ChatGPT token (240h) went unchecked for ten
days. And a subscription whose token was rejected while its stored expiry still
looked valid could not be reconnected at all — the Reconnect action was hidden
unless the sign-in was already marked expired — so the only way out was delete and
re-add, losing its models and routing.

**Added — provider health from live traffic.** Each provider now keeps two records:
its last deliberate **check** (Test, a Sync that listed models, a credential-refresh
failure, a reconnect or credential/endpoint edit) and what **live traffic** observed
(failing when its shared circuit breaker opens, healthy when a served request
recovers it). The card shows whichever was recorded last, with the reason and how
long ago — e.g. "authentication failed · seen in live traffic 12m ago". Stale
observations can never overwrite newer ones: every write is guarded by the
credential and endpoint it was made against, and traffic writes are ordered by a
sequence the breaker issues. Writes happen only on a transition, off the request
path; a request that changes nothing costs nothing.

**Added — background OAuth renewal.** A sweep every 15 minutes renews sign-ins near
expiry and re-verifies each grant about once a day, so a revoked sign-in turns into
"reconnect" without waiting for traffic. It calls only each provider's token
endpoint — never a model API — and budgets the daily checks per sweep, so a first
deploy spreads them out. A live **401** triggers one background renewal (at most
once per 10 minutes per credential); **Test** does the same inline and re-probes
once, so it either repairs a rejected token or reports reconnect.

**Changed — Reconnect is always available** on every OAuth card and in the Edit
dialog, renews the provider in place (models and routing kept), and runs one Test
afterwards. The card's contradictory "Last action failed" beside "Connected" is
replaced by one status line, with the token lifetime on its own neutral line.

**Fixed — a revoked sign-in was never durably recorded.** The refresh path wrote
"reauthorize required" inside a transaction it then rolled back, so every request
re-tried the dead grant. **Fixed — a bundled-preset Sync (ChatGPT) marked a provider
healthy without contacting it.** **Fixed — requests still in flight with a dead
credential could reopen a just-reconnected provider's circuit breaker**; breaker
generations are no longer reused after a reset or an idle expiry.

Upgrade note: one additive migration; the first sweep after upgrading spreads its
liveness checks over several ticks.
