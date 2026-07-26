---
'@polyrouter/frontend': patch
---

Dragging models to reorder a tier's fallback chain now lands where you dropped them, and the
chain can be reordered from the keyboard.

Two independent defects made the Routing page's drag-to-reorder flicker and fail to stick.
The chain **is** the fallback policy — position 0 is the primary every `auto`/tier-routed
request hits first — so a reorder that silently reverted or landed in the wrong order left
the operator believing they had configured one routing policy while the proxy ran another.

The first defect: in-progress drag state was keyed by list index, and the index was re-read
*after* the reorder had already been applied — at which point it referred to the drop target's
new position, not the dragged row's. The marker latched onto the wrong row, subsequent drag
events moved the wrong entry, and for an adjacent swap it became a stable oscillator that
flipped the order back and forth at the browser's drag-event rate with the pointer held
perfectly still. Which order survived depended on where that oscillation happened to be when
the drop landed. Drag state is now keyed by model identity, so there is no index to go stale.

The second: a chain write's response, or a routing refresh, could arrive mid-drag and repaint
the whole chain from server state, discarding the in-progress reorder. Reachable by dragging
within a round-trip of any other chain edit, or simply by leaving the Routing page and coming
back while a refresh was still in flight. An in-progress drag now defers that server state
until the drag ends — the user's order wins if they moved something, and the deferred state is
applied if they didn't, so a no-op drag still converges without issuing a write.

Also in this change: a reorder now commits only once the pointer crosses the target row's
midpoint, so jitter on a row boundary no longer re-triggers it; the drop is properly accepted
instead of resolving as a cancelled drag (which made the browser animate the row snapping back
to where it started); drag data is set on `dragstart`, which Firefox requires to begin a drag
at all; and the row hover highlight no longer chases rows as they move.

**New:** the `⋮⋮` handle is now a real button. Focus it and press `Alt`+`Arrow Up` / `Alt`+`Arrow
Down` to move an entry, with focus following the row and the new position announced to screen
readers. Previously `Make primary` was the only keyboard path, which could only reach position
0 — there was no way to order one fallback against another without a mouse.
