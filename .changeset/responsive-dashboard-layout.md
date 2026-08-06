---
'@polyrouter/frontend': minor
---

The dashboard's pages now adapt to a narrow viewport. Every page previously rendered a
desktop layout regardless of screen width — the sidebar alone took 53% of a phone screen,
and the requests table needed roughly 1020px to stay legible.

Below 768px the sidebar collapses to an icon rail that expands, on demand, into a labelled
navigation panel carrying the account menu and setup guide. Multi-column page layouts drop
to fewer columns, control rows wrap instead of overflowing, and page gutters tighten.

Tables adapt to the width **they** actually get rather than the viewport's — a table sits
inside the content pane minus the sidebar and gutters, so at a 1025px window the requests
table receives only about 765px. Each of the four tables reflows to stacked records at its
own measured threshold, keeping every field, every row action, and — for a request row —
the same single control, the same accessible name, and the same link into the inspector.

Interactive controls now meet a 24px minimum target at every width and 44px below the
narrow threshold or on a touch pointer, so a tablet gets comfortable targets even at a
width nowhere near a phone's.

**Desktop rendering is unchanged**, with one deliberate exception: three controls that
shipped below the 24px accessibility minimum (`.icon-x`, `.drag-handle`, `.link-accent`)
grew to meet it. That parity is pinned by a browser test measured against the released
v0.11.0 build.

Detail drawers and dialogs keep their current geometry for now; they are the next phase.
