---
'@polyrouter/shared': minor
'@polyrouter/data-plane': minor
'@polyrouter/control-plane': minor
'@polyrouter/frontend': minor
---

Reserve a routing-chain entry for batch work, and stop offering batch to flat-rate subscriptions.

A tier entry now carries a **mode**. Leave it alone and nothing changes. Set it to
**batch only** and that entry is held for bulk work: a synchronous walk skips it,
and a batch submission claims it. One chain can therefore serve cheap interactive
traffic and hold an expensive model for overnight runs:

```
[0] gpt-4o-mini   any          sync uses mini
[1] gpt-4o        batch only   batch uses gpt-4o
```

The Routing page gets a per-entry switch, shown wherever the provider can actually
run a batch — and always where an entry is already reserved, so a reservation can
be undone even if that provider has since changed. For OpenRouter, the `:batch`
twins you can see priced on the Providers page now appear in the model picker as a
shortcut that reserves the model they price; the twin id itself is still never a
routing target.

**A batch resolves to exactly one candidate and is never re-pointed.** It takes the
lowest-position reserved entry, or position 0 when nothing is reserved. If that
candidate's provider cannot run a batch the submission is refused rather than
quietly moved to a later member — a different member can be a different provider at
a different price, and that is not a choice a router should make for you.

**Fixed:** a batch naming a **Claude Pro / Max** subscription provider was accepted
and then rejected upstream, *after* a budget reservation was taken — and because the
poller releases nothing on failure, that reservation stayed held for the rest of its
window while the job never finished. Batch is now refused up front for any
subscription provider, decided by provider kind rather than by protocol, so it holds
for every subscription preset. Jobs already accepted keep draining to completion,
settling, and serving their results.

Also fixed: batch resolution previously ignored a wholly-reserved tier's members and
would have reported it as unconfigured.
