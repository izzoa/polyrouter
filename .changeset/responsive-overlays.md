---
'@polyrouter/frontend': minor
---

The dashboard's overlays now work on a phone. Phase 1 adapted every page but deliberately
left the drawers and dialogs alone, so you could browse the dashboard on a phone without
being able to open anything on it.

Tapping a request opened a 440px inspector panel on a 390px screen: its left edge sat at
−50px, and at 320px wide it hung 120px off the edge. Nothing caught that, because a
`position: fixed` surface overhangs the viewport without adding any document overflow — so
the page-level check passed while a third of the drawer was unreachable. Three of the six
modal kinds were worse: the provider form is 878px tall at 320px wide against a 568px
screen, and its Save button sat 310px past the bottom of a fixed backdrop, where no scroll
could reach it.

Below 768px the inspector, all six modal kinds and both confirmation dialogs are now
presented as bottom sheets — full width, height-capped so the page stays visible behind
them, and scrolling internally so nothing is stranded. It is the same DOM restyled rather
than a second component, so dismissal, focus trapping, layer ordering and accessible names
are literally the same objects at both widths; a test keeps a dialog open across the
breakpoint and asserts the element, its layer token and the focused control all survive the
crossing.

The on-screen keyboard is handled for the first time. Nothing in the app read the visual
viewport before, so a sheet anchored to the bottom of the screen would have sat behind the
keyboard, and the model picker — which measured against `window.innerHeight`, a value that
does not shrink on iOS — would have opened underneath it. Sheets and the picker now measure
against what is actually visible, the picker re-measures if the keyboard arrives after it
opens, and pinch-zoom is correctly distinguished from a keyboard so zooming to read a value
does not send a sheet up the screen.

Safe-area insets are honoured on bottom-anchored surfaces, so a sheet's actions clear the
home indicator, and the toast — which had no width and shrink-wrapped into a 160×103px
block at 320px wide — now spans the screen.

**Desktop rendering is unchanged**, pinned by geometry captured from every overlay before
any of this was written.
