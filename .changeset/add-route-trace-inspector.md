---
'@polyrouter/frontend': minor
---

The request inspector draws each request's recorded route as a trace, and its price snapshot states when it was taken

**Visual change.** The inspector's chip row, its Fallback trail box and its Timing box are replaced
by one route trace, and Usage & cost is replaced by a price snapshot. Both show only what was
recorded with the request.

- **The route trace** reads top to bottom: the agent (or `(no agent)`, never a raw id), the
  router's decision (`router · <layer>`, in a neutral chip), each attempt the request made, in the
  order it made them, and one outcome with its latency. Only a served request lights its branch,
  and it is the inspector's one indigo.
- **Attempts are stated in words.** A failed attempt names its model and its failure, with the
  HTTP status when one was recorded. A provider that was never contacted reads
  `skipped — circuit open (provider not contacted)`. In a cascade, each attempt carries its leg
  (`cheap leg` or `escalation`), and a superseded cheap call reads, for example,
  `cheap attempt superseded · q=0.42 · $0.0031`. Chain members that were never walked are not
  drawn, and the trace never reads today's routing setup.
- **Outcomes.** A served request reads `served · 1.24s`. A failed, cancelled or unrecognised one
  ends unlit, in words: `failed · 2.10s`, `cancelled by client · 800ms`, or the recorded status
  as it is. A recovered request recorded before attempts were kept says
  `attempt history was not recorded for this request`.
- **The price snapshot** says when the price was taken: `Recorded with the request — later price
  changes never apply.`, or `Batch rate, recorded at submission.` for a batch item. It replaces a
  footnote that said prices were snapshotted at request time. It has no caption when the request
  is unpriced.
- **Receipt rows.** Input and output read count × unit price, and a cache row appears when its
  count or its price was recorded. A source row names the price's origin
  (`native family · estimate` or `provider-listed · estimate` for an estimated price). The
  attempts row appears only when earlier attempts cost money. The total is exact, and reads as the
  request table's cost cell does: `$0 · not billed`, `unpriced`, `$0 free`, `<$0.0001` or the
  amount. A free or priced total carries `· est.` when a price in it was estimated, and estimated
  token counts carry `· est. usage` on the counts, never on the total.
- **Layout.** The error card moves to the top of the inspector, and the served tier has its own row
  under Decision. The decision layer and routing reason rows stay.
- **No motion.** The trace never animates, including when you move between requests.

No API, routing behavior or stored data changed.
