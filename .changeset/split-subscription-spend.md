---
'@polyrouter/control-plane': minor
'@polyrouter/frontend': minor
'@polyrouter/shared': minor
---

Subscription usage is no longer counted as money spent.

A request served by a Claude Pro/Max provider was priced at Anthropic's **API list rate** and
recorded as ordinary cost — but that traffic is already paid for by a flat monthly fee, so its
marginal cost is zero. Three things followed: the Costs page drew it as "paid", every spend
figure overstated what you owed, and — the one that could actually bite — a `block` budget
could refuse requests once that notional value crossed its threshold, with nothing in the UI
saying so. (ChatGPT Plus/Pro traffic is usually unaffected, because `chatgpt.com` is not in the
pricing catalog's host map and those requests record no cost at all.)

Each ledger row now snapshots the **kind of provider that served it**, immutably, alongside its
price snapshot. It is a snapshot rather than a join for the same reason cost is immutable: a
provider can be deleted, and its kind can be changed, and neither should be able to reach back
and reclassify what a request was months later.

The recorded cost itself is unchanged — this changes what is *summed and labelled*, never what
is *stored*. That matters, because the number is worth keeping: it is exactly what tells you
whether a subscription is paying for itself.

**Costs page.** The headline reports what you owe and says it excludes subscription; the
subscription figure sits beside it as "served on subscription" — visible, so the previous
combined total is still reconstructable, and simply absent when a range has none. The
distribution bar gains a fourth segment for prepaid traffic, rendered as a second intensity of
the existing accent so it still reads as one "paid" block subdivided rather than introducing a
new colour. Every category now shows its count next to its percentage. The exclusion applies to
the timeseries and to the model/provider/agent breakdowns too, not only the headline.

**Budgets choose what they count.** A budget now carries a metering basis. **Existing budgets
are migrated to `notional` and keep metering exactly what they metered before** — nothing
changes under you. New budgets default to counting money spent. The reason for the choice
rather than a blanket fix: metering notional value is a crude proxy for a flat-rate plan's
finite capacity, but it is currently the only usage throttle polyrouter has, and quietly
removing it would trade one bug for a subtler one. The Limits form makes the choice explicit,
and budget alerts now state which basis they metered.

Rows recorded before this release cannot be honestly classified — inferring their billing kind
from today's providers is the exact rewrite this snapshot exists to prevent — so they keep
counting toward spend and are reported as their own unclassified component rather than being
presented as known cash. Expect a visible step in historical figures at the upgrade boundary;
it ages out of the range naturally.
