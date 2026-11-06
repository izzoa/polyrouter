---
'@polyrouter/frontend': minor
---

The dashboard adopts one set of design tokens, and a first visit follows the OS theme

**Visual change (breaking for anyone who relied on the old look).** Every page renders
differently at desktop width, and a first-time visitor whose operating system is set to dark now
gets the dark theme. The theme is resolved before the first paint, so there is no flash. A theme
you chose yourself is still remembered and wins.

- **Contrast.** Indigo text is a deeper indigo that clears 4.5:1 in both themes, and the primary
  button darkens on hover and press in both. Fields, filter chips and the off switch draw a
  visible edge. Meaningful glyphs (copy, chevrons, close) are darker.
- **One size system.** Controls are 24 or 32px tall (44px on touch and on a phone), and controls
  in one row share a height. Text uses five sizes, set in `rem`, so the browser's font-size
  setting scales the dashboard. Spacing uses a 4px scale and corners use four radii.
- **The switch** is 36 × 20px (32 × 18px small): dark when on, grey when off. It is never indigo.
- **Indigo is spent once per view:** one primary button and one highlighted data series. The
  breakdown bars on Overview and Costs, switches and running dots are now grey.
- **One selected look** for the current page, a chosen segment or filter, a selected option card
  and the open request row: a light indigo wash, a deeper indigo label and a 1px edge.
- **Buttons** show hover, pressed, focus and disabled states. A button that starts a request shows
  that it is working (for example `Testing…` and `Syncing…` on a provider card) and keeps its
  width while it waits.
- **Fields** show help text, and each form reports a problem next to the field it concerns.
- **Tables** share one row and head style. Figures use tabular digits; long model ids, provider
  names and emails are cut with an ellipsis, with the full text on hover.
- **Notices** share one layout in four tones. A confirmation toast stays 4 seconds and a failure
  toast 8 seconds, announced as an alert; hovering or focusing a toast holds it.
- **Overview and Costs** state their headline figures in one readout strip, with the spend as the
  one large figure.
- **The sidebar** groups its pages under Observe, Configure and Admin. Batches moves under
  Observe, after Costs, and Routing leads Configure.
- **The Live lamp** blinks once when new data arrives instead of pulsing all the time.
- **Native widgets** (checkboxes, radios, scrollbars, text selection) follow the theme.
- **Table reflow.** The tables switch to stacked records at re-measured widths: the requests table
  below about a 1240px window (was about 1220px).

**Fixed.** The Settings body-capture card no longer claims "metadata only" before it knows: while
its status was loading, or when the read failed, it said bodies are never persisted and showed a
green Metadata-only badge, even on an instance that captures them. It now claims nothing until the
status loads.

No API, routing behavior or stored data changed. The theme setting keeps its storage key.
