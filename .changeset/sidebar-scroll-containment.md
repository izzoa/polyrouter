---
'@polyrouter/frontend': patch
---

The dashboard no longer slides off the top of the window, and the sidebar's lower content
stays reachable on a short viewport.

The app shell is a viewport-height flex row with `<main>` as the intended scroll container,
but the sidebar owned no overflow of its own. Its content — logo, up to nine nav items, the
setup-guide card and the account footer, around 520px in total — is taller than a short
viewport, and the spill enlarged the *shell's* scroll range. Two problems followed. The
shell became translatable: `overflow:hidden` suppresses a scrollbar but still makes a box a
scroll container, so focus moving to a clipped control, `scrollIntoView`, or scroll
anchoring could shift it — and when the shell shifts, every pane shifts together, carrying
the topbar and the page content off-screen. And the sidebar's lower items, the account menu
among them, were simply clipped out of reach with no way to scroll to them.

The sidebar now scrolls internally, which fixes the reachability and removes the shell's
scroll range at its source. The shell is additionally `overflow: clip`, which creates no
scroll container at all, so it cannot be moved by any mechanism even if some future pane
reintroduces a spill. Scrolling inside the sidebar and `<main>` is unaffected — they are
their own scroll containers.

Reaching the end of either pane no longer chains the remaining scroll outward. That
containment is deliberately limited to the vertical axis so horizontal swipe-back and
forward navigation gestures keep working.

The shell is also sized in `dvh` now, falling back to `vh` on older engines. The static `vh`
unit resolves against the viewport with mobile browser chrome retracted, so a `100vh` shell
is taller than what is actually visible — the same "page extends past the window" symptom,
reached a different way.
