---
'@polyrouter/frontend': minor
---

On a wide screen the request inspector docks beside the Requests list and steps from request to request, and the Requests and Batches tables drop columns by priority before they stack

**Visual change.** At 1440px and wider, the Requests page no longer covers the list when you open
a request.

- **The docked inspector.** At 1440px and wider, a request opened on the Requests page shows its
  inspector as a 480px panel at the right edge, with no dimmed backdrop and no shadow. The page,
  top bar included, makes room for it, so nothing is covered. The list, its filters and Load more
  stay usable beside the panel. Escape or Close closes it, and focus returns to that request's
  row. Opening a row leaves focus on the row; activating it again moves focus into the panel.
- **The compact list.** While the panel is open, the request list shows time, model, status and
  cost on one line. An escalated or batch request keeps its mark in the status cell. A running
  request or a live batch job keeps every field on a second line.
- **Previous and Next.** The inspector gains Previous and Next controls at every width: 24px, and
  44px on a touch screen or a phone. At the first or last loaded request the control stays
  focusable and reads as unavailable. While docked, ArrowUp and ArrowDown on a request row step
  too. Stepping skips rows that can't open, never wraps, never loads another page, never takes the
  "N new" offer and never fetches a payload.
- **Step announcements.** Each step is announced once to screen readers in one line: time, model,
  status and cost. A held arrow key is announced once, where it stops. Opening, closing and list
  refreshes are not announced.
- **A stable selection.** The inspector keeps showing the request you opened through a refresh, a
  filter change or newer rows arriving, and focus stays on the row you were on.
- **Column priorities.** As space narrows, the Requests table moves provider, tier and decided-by
  to a second line under the model, then tokens and latency; the Batches table moves provider,
  tier and results-until, then progress and wall time. Both become stacked records only below
  640px of table width, so a 730–768px window keeps a table. The agent stays the group heading
  above its rows in every form.
- **Touch targets.** On a touch screen wider than a phone, the inspector's Close button, the
  Routing page's delete `×` and the tier chain's drag handle are now 44px wide, like Previous and
  Next, instead of keeping only their 44px height.
- **Unchanged.** Below 1440px the inspector stays the 440px modal drawer, and the sheet on a phone.
  The Overview card's inspector and the routing tuning drawers never dock.

No API, routing behavior or stored data changed.
