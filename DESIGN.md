---
name: polyrouter
description: One endpoint for every model — the self-hosted router's operator console.
colors:
  accent: "#4f5dff"
  accent-bg: "color-mix(in oklab, #4f5dff 9%, #ffffff)"
  accent-deep: "color-mix(in oklab, #4f5dff 78%, #17181a 22%)"
  accent-fill-hover: "color-mix(in oklab, #4f5dff 78%, #17181a 22%)"
  accent-fill-pressed: "color-mix(in oklab, #4f5dff 66%, #17181a 34%)"
  bg: "#fafafa"
  panel: "#ffffff"
  border: "#ececea"
  border2: "#f1f1ef"
  hover: "#f4f4f2"
  chip: "#f1f1ef"
  border-control: "#898b92"
  text: "#17181a"
  text2: "#55575e"
  text3: "#6a6c73"
  faint: "#b4b6bc"
  green: "#3bb273"
  green-text: "#22794c"
  green-bg: "#e9f6ef"
  amber: "#c8901a"
  amber-text: "#8a5d00"
  amber-bg: "#fbf3dc"
  red: "#e5484d"
  red-text: "#b42318"
  red-bg: "#fdecec"
  red-fill: "#b42318"
  red-fill-hover: "color-mix(in oklab, #b42318 85%, #17181a 15%)"
  red-fill-pressed: "color-mix(in oklab, #b42318 70%, #17181a 30%)"
  accent-bg-dark: "color-mix(in oklab, #4f5dff 9%, #16171b)"
  accent-deep-dark: "color-mix(in oklab, #4f5dff 78%, #f0f1f4 22%)"
  bg-dark: "#0e0f12"
  panel-dark: "#16171b"
  border-dark: "#26272d"
  border2-dark: "#1f2025"
  hover-dark: "#1c1d22"
  chip-dark: "#22232a"
  border-control-dark: "#6b6d76"
  text-dark: "#f0f1f4"
  text2-dark: "#a6a8b0"
  text3-dark: "#898b93"
  faint-dark: "#4e5058"
  green-dark: "#46c482"
  green-bg-dark: "#12291d"
  amber-dark: "#e7b03c"
  amber-bg-dark: "#2e2712"
  red-dark: "#f2555a"
  red-bg-dark: "#391a1c"
  red-fill-dark: "#c4342b"
  red-fill-hover-dark: "color-mix(in oklab, #c4342b 85%, #17181a 15%)"
  red-fill-pressed-dark: "color-mix(in oklab, #c4342b 70%, #17181a 30%)"
  green-text-dark: "#46c482"
  amber-text-dark: "#e7b03c"
  red-text-dark: "#f2555a"
typography:
  display:
    fontFamily: "Geist, sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: "32px"
    letterSpacing: "-0.03em"
    fontFeature: "tnum"
  title:
    fontFamily: "Geist, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: "20px"
    letterSpacing: "-0.01em"
  wordmark:
    fontFamily: "Geist, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: "20px"
    letterSpacing: "-0.02em"
  section:
    fontFamily: "Geist, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: "20px"
  body:
    fontFamily: "Geist, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "20px"
  body-control:
    fontFamily: "Geist, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "16px"
  button:
    fontFamily: "Geist, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: "16px"
  body-dense:
    fontFamily: "Geist, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
  label:
    fontFamily: "Geist, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: "16px"
  caption:
    fontFamily: "Geist, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: "16px"
  overline:
    fontFamily: "Geist, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: "16px"
    letterSpacing: "0.06em"
  mono:
    fontFamily: "Geist Mono, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
  mono-sm:
    fontFamily: "Geist Mono, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: "16px"
rounded:
  mark: "4px"
  control: "6px"
  surface: "10px"
  sheet: "16px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  card: "16px"
  card-narrow: "12px"
  page: "24px"
  page-narrow: "16px"
  cell: "0 16px"
  drawer-head: "16px 20px"
  drawer-body: "20px"
  modal: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "7px 13px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.accent-fill-hover}"
  button-primary-pressed:
    backgroundColor: "{colors.accent-fill-pressed}"
  button-secondary:
    textColor: "{colors.text2}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "7px 13px"
    height: "32px"
  button-secondary-hover:
    backgroundColor: "{colors.hover}"
  button-ghost:
    textColor: "{colors.text2}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "3px 10px"
    height: "24px"
  button-ghost-hover:
    textColor: "{colors.accent-deep}"
  button-ghost-destructive:
    textColor: "{colors.red-text}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "3px 10px"
    height: "24px"
  button-ghost-destructive-hover:
    backgroundColor: "{colors.red-bg}"
  button-destructive:
    backgroundColor: "{colors.red-fill}"
    textColor: "#ffffff"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "7px 13px"
    height: "32px"
  button-destructive-hover:
    backgroundColor: "{colors.red-fill-hover}"
  button-destructive-pressed:
    backgroundColor: "{colors.red-fill-pressed}"
  input:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    typography: "{typography.body-control}"
    rounded: "{rounded.control}"
    padding: "7px 11px"
    height: "32px"
  panel:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.surface}"
    padding: "{spacing.card}"
  chip:
    backgroundColor: "{colors.chip}"
    typography: "{typography.caption}"
    rounded: "{rounded.control}"
    padding: "2px 8px"
    height: "20px"
  nav-item:
    textColor: "{colors.text2}"
    typography: "{typography.body-control}"
    rounded: "{rounded.control}"
    padding: "7px 9px"
    height: "32px"
  nav-item-active:
    backgroundColor: "{colors.accent-bg}"
    textColor: "{colors.accent-deep}"
  segmented-option:
    textColor: "{colors.text3}"
    typography: "{typography.body-dense}"
    rounded: "{rounded.mark}"
    padding: "4px 11px"
    height: "26px"
  segmented-option-selected:
    backgroundColor: "{colors.accent-bg}"
    textColor: "{colors.accent-deep}"
  toggle-on:
    backgroundColor: "{colors.text}"
    rounded: "{rounded.surface}"
    width: "36px"
    height: "20px"
  toggle-off:
    backgroundColor: "{colors.border-control}"
    rounded: "{rounded.surface}"
    width: "36px"
    height: "20px"
  modal:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.surface}"
    padding: "{spacing.modal}"
    width: "480px"
  toast:
    backgroundColor: "{colors.text}"
    textColor: "{colors.bg}"
    typography: "{typography.button}"
    rounded: "{rounded.surface}"
    padding: "8px 16px"
    height: "32px"
---

# Design System: polyrouter

## Overview

**Creative North Star: "The Switchboard"**

The polyrouter dashboard is an operator's switchboard. Every request comes in at one point and leaves along one route, and the board's job is to show which route was lit and why. The brand mark sums it up at 20px: one source node fans out to three routes, and one route is lit in Ink Indigo while the other two stay grey. The system repeats that grammar wherever traffic is explained. Above all, it shapes the **Route Trace**, the signature component that draws a request's real path through the router.

Everything else stays quiet so the lit route can be read. Near-white panels sit on a flat board divided by 1px hairlines, and greys carry the structure. Indigo is spent only on what is active, selected or focused (The Indigo Budget Rule). Figures are honest before they are pretty. Every number is either exact or says what it is instead: estimated, unpriced, pending, stale or reserved (see *Figures and their states*). Density is compact because operators scan rather than read, and type grows only where a number is the point.

Controls are crisp and tactile. They are small and exact, and they share one height family. Every state (hover, pressed, selected, focus, busy, invalid) is shown as a tone, border or label change, never as lift or glow. On a first visit the theme follows the operating system. Dark mode mirrors every token and drops every shadow.

**How this file relates to the code.** DESIGN.md is the target: it describes what the dashboard should ship next, not only what ships today. Where target and code differ, the **As-built delta** table below names the gap and the OpenSpec change that closes it. Until that change lands, two things stay authoritative: the as-built value in `packages/frontend/src/styles.css` (for code) and the locked axes in `STYLESEED.md`. Each implementing change updates `STYLESEED.md`, `styles.css` and the contract tests together, then removes its rows from the delta.

**Key Characteristics:**
- One brand hue, spent deliberately. Each view gets one indigo-filled control and one indigo data series. Washes, rings and indigo text mark state.
- The Route Trace draws a request's path in the brand mark's grammar.
- Honest figures: each state has one treatment, and the state is always named in words.
- Flat surfaces. Hairlines separate them. Shadows are faint in light mode and absent in dark mode.
- One control-height family (24 / 32px, and 44px under a coarse pointer) and five type sizes (11 / 12 / 13 / 15 / 26px).
- Geist for words and numbers (numbers use tabular figures). Geist Mono for identifiers only.
- Snap motion, and only state moves: the Live lamp blinks once per event, and the only loops are in-progress pulses and skeletons.

### As-built delta

| Target (this file) | As built today | Closed by |
|---|---|---|
| First-token commit marker on the served node | Not recorded by the proxy, so the marker is never drawn | Follow-up: commit-timing telemetry (request logging) |
| Per-request deep link (`#/requests/<id>`) | Not supported: no owner-scoped read-by-id, and the fragment grammar is page-only | Follow-up: request detail read + deep link |
| Consent confirmations share the dialog's busy and in-dialog failure | The body-capture consent dialog closes before it saves, with no busy state, and reports a failure on the card | Follow-up: consent dialog on the shared confirm structure |
| Failures appear inline, with `role="alert"` | Several failures surface as toasts | Follow-up: inline failure homes |
| The focal readout figure compares spend against a budget (`of $25.00`) | Spend for the range only | Follow-up: budget comparison on Overview and Costs |
| A permanently unavailable action is not rendered | Some show as disabled | Follow-up: permission-aware actions |
| Cancelling and Reconciling pulse an Ink 3 dot; Finishing shows a steady Ink 3 dot (Lifecycle states) | Cancelling pulses amber, kept as a status hue by `adopt-design-tokens-v2` (design.md D11, task 7.2); Finishing (settling) and Reconciling show a Faint dot | Follow-up: lifecycle dot tones |
| Relative time in request lists (`12m ago`; absolute on hover, on focus and in the inspector) | Absolute `HH:MM:SS` in the list and the step announcement | Follow-up: relative time in request lists |
| Unverified notice copy: `Routing may have changed and the refresh failed.` | `Last loaded targets — routing may have changed; see Targets` | Follow-up: unverified-notice copy |
| Newer-rows offer reads `12 new` | `N new · load` | Follow-up: newer-rows copy |
| Aggregate coverage: estimate-priced spend includes `listed` pricing; the unpriced count includes attempts | Omitted from the summary | Follow-up: aggregate coverage (needs an API change) |
| Money grouping follows the browser locale | Not adopted: pinned contract strings fix today's format | Follow-up: locale formatting (needs a spec change) |
| The Users Members email takes its own line at table width | Just above `table-fit-users` the Members email is cut to nothing, leaving the name and `(you)` | Follow-up: Members email line |
| Overview's provider dots state their health in visible words (Status-Speaks Rule) | The state word (`healthy`, `failing`, `not tested`) is only each dot's accessible name and `title` | Follow-up: provider-dot state words |

## Colors

The palette uses a single accent. One indigo signal sits over warm-cool greys, and three status hues are kept strictly for state.

### Primary
Ink Indigo has four roles, and each has its own token so that no role borrows another's contrast:

| Role | Token | Light | Dark | Used for |
|---|---|---|---|---|
| **Fill** | `{colors.accent}`, ≈ oklch(56.9% 0.237 272.4) | #4f5dff | #4f5dff | The primary button, the focus ring, the Route Trace's lit branch, and the view's one focal data series |
| **Fill hover** | `{colors.accent-fill-hover}` | ≈ #414fc7 | ≈ #414fc7 | Primary hover. It darkens in **both** themes, so white text stays at 6.63:1. |
| **Fill pressed** | `{colors.accent-fill-pressed}` | ≈ #3947aa | ≈ #3947aa | Primary pressed: one step darker again (white 7.91:1). |
| **Text** (Deep Ink) | `{colors.accent-deep}` | ≈ #414fc7 | ≈ #6c83ff | All indigo text and hover edges: links, the selected label, icon and edge, ghost-button and endpoint-chip hover. In dark mode it is mixed toward the near-white Ink, so it gets *lighter*. |
| **Wash** | `{colors.accent-bg}` | ≈ #edf2ff | ≈ #1a1e2d | The selected-state fill, and the area under the focal series. A 9% mix into the panel. |

In CSS, write each derived token as a `color-mix(in oklab, var(--accent) …)` expression and never as the hex. The lock forbids hard-coded accent values.

### Neutral
- **Canvas** (`{colors.bg}` / dark `{colors.bg-dark}`): the page behind the panels. Inputs sit on it too, so a field reads as a well cut into the panel.
- **Panel White** (`{colors.panel}` / dark `{colors.panel-dark}`): every card, drawer, modal and docked panel, and the segmented control's track. It is also the toggle knob.
- **Hairline** (`{colors.border}`): the 1px line that separates *surfaces*: panels, the top bar, table frames and buttons. It is a separation line, not a control boundary.
- **Control Edge** (`{colors.border-control}` / dark `{colors.border-control-dark}`): the boundary of every **entry control** whose edge is its affordance and drawn by the stylesheet. That covers inputs, selects, textareas, comboboxes, filter chips and the off toggle track. It clears 3:1 on every neutral surface: canvas, panel, chip and hover. Entry controls never sit on a status wash, where it drops below 3:1. Checkboxes and radios stay native: the browser draws their edge under the theme's `color-scheme`, and it is held to 3:1 by measuring the rendered pixels, not drawn in Control Edge.
- **Soft Hairline** (`{colors.border2}`): dividers *inside* a panel: table rows, receipt rules, drawer header rules and chart grid lines.
- **Hover Tone** (`{colors.hover}`) and **Chip Tone** (`{colors.chip}`): one-step tonal lifts. Hover Tone fills hovered rows and nav items. Chip Tone fills static chips, skeletons, pressed states, the Info notice and disabled fields.
- **Ink** (`{colors.text}`): primary text and figures, and the toggle's on track. It is near-black (#17181a), never pure black.
- **Ink 2** (`{colors.text2}`): row text, secondary controls and field labels.
- **Ink 3** (`{colors.text3}`): stat labels, captions, table heads and axis ticks, plus **every glyph that carries meaning**, such as the copy icon, chevrons and close buttons. It is the lowest-contrast token allowed for readable text.
- **Faint** (`{colors.faint}`): **decorative marks only**, such as the idle nodes in the brand mark or a dot that sits next to a word saying the same thing. At 1.79–2.38:1 it can't carry meaning on its own.

### Status (semantic, not brand)
- **Signal Green / Amber / Red** (`{colors.green}`, `{colors.amber}`, `{colors.red}`): fills for dots, bars, borders and chips. On white they read 2.7–3.9:1, so they never carry small text in light mode.
- **Status Text** (`{colors.green-text}`, `{colors.amber-text}`, `{colors.red-text}`): darkened variants that clear 4.5:1 for status words such as "OK", "Live" and "free". In dark mode the fill already clears 4.5:1, so the text variant equals the fill.
- **Status Washes** (`{colors.green-bg}`, `{colors.amber-bg}`, `{colors.red-bg}`): quiet backgrounds for status notes and alerts.
- **Red Fill** (`{colors.red-fill}` / dark `{colors.red-fill-dark}`): the commit button of a destructive confirm dialog, and nothing else. White text on it is 6.57:1 (light) and 5.42:1 (dark), and the fill clears 3:1 against the panel in both themes. The dark value is lighter than the light one because `#b42318` sinks to 2.72:1 on the dark panel.

### Contrast floors (WCAG 2.2 AA; light / dark)
Each pairing the system prescribes is measured against its floor: 4.5:1 for text, 3:1 for control boundaries and state indicators. A new pairing gets added here, and to the contrast suite, before it ships.

| Pairing | Ratio (light / dark) | Floor |
|---|---|---|
| Ink · Ink 2 · Ink 3 on panel | 17.77 / 15.86 · 7.21 / 7.55 · 5.24 / 5.27 | 4.5 |
| Ink 3 on its weakest surface (chip) | 4.64 / 4.60 | 4.5 |
| Indigo text (`accent-deep`) on panel · wash · chip | 6.63 / 5.40 · 5.92 / 4.99 · 5.86 / 4.72 | 4.5 |
| White on the primary fill · hover · pressed | 4.84 · 6.63 · 7.91 (both themes) | 4.5 |
| White on Red Fill · hover · pressed | 6.57 · 7.81 · 9.30 / 5.42 · 6.62 · 8.12 | 4.5 |
| Control Edge vs panel · canvas · chip · hover | 3.40 / 3.47 · 3.26 / 3.72 · 3.01 / 3.04 · 3.09 / 3.26 | 3 |
| Focus ring vs any surface it can touch, status washes included | ≥ 4.23 / ≥ 3.07 | 3 |
| Toggle on track vs off track · knob vs either track | 5.22 / 4.56 · ≥ 3.40 / ≥ 3.47 | 3 |
| Selected border (`accent-deep`) vs wash | 5.92 / 4.99 | 3 |
| Status text on its wash | 4.84–5.76 / 4.65–7.54 | 4.5 |
| Faint on any surface | 1.79–2.03 / 1.95–2.38 | decorative only |

### Named Rules

**The Indigo-Text Rule.** Text is never set in `--accent`. Indigo text, labels and icons use `accent-deep`, which reaches 5.86:1 or better in light mode and 4.72:1 or better in dark on every neutral surface (panel, canvas, chip, hover, wash). It never sits on a status wash, where dark Amber Wash drops it to 4.47:1. Raw accent text fails in dark mode (3.70:1) and on light washes (4.32:1).

**The 3:1 Edge Rule.** Anything whose edge *is* the affordance has an edge of at least 3:1. An empty field, a filter chip and an off switch draw it in Control Edge; a native checkbox or radio keeps the edge the browser draws, which is measured to clear 3:1. A state is shown by a change in shape, border or weight that clears 3:1, never by a tint alone. The selected wash is only 1.07–1.16:1 against its surroundings, so it never carries the state by itself.

**The Indigo Budget Rule.** Indigo is spent, not sprinkled. Each view gets:
- **One indigo-filled control:** the primary action. Every other action is a neutral button, and switches are Ink.
- **One indigo data series:** the view's focal measure. Examples: the Pipeline's bars, the Limits spend line, the request mix's two intensities, the Route Trace's lit branch. Every other series is Ink or Ink 3, told apart by dash pattern and direct labels.
- **State marks without limit:** the focus ring, the focused input border and the caret; Deep Ink text and hover edges (links, selected labels, ghost and endpoint-chip hover); the Selected wash; and `accent-color` on a checked native checkbox or radio. These mark state, so they don't count against the budget.
- **Identity:** the brand mark's lit route. It is the product's signature, not spend.

A docked panel and the page beside it count as one view.

Running dots, hover fills, icon chips and decorative accents are never indigo. A second accent hue breaks the board.

**The Status-Speaks Rule.** Green, amber and red mean state, with one exception: red also marks an action that destroys data, abandons in-flight work, or cuts off access (Delete, Remove, Purge, Disable, Cancel batch). Every status color appears beside words that name the state. Never encode status by color alone, and never set small status text in the fill variant on a light surface.

**The No-Rainbow Rule.** Never give each card, series or category its own hue. Identity is carried by text. A categorical palette may arrive only through an explicit change to the `STYLESEED.md` lock (`+categorical`), not one surface at a time.

## Typography

**Display Font:** Geist (with sans-serif)
**Body Font:** Geist (with sans-serif)
**Label/Mono Font:** Geist Mono (with monospace)

**Character:** One neutral grotesque carries words *and* numbers at small, exact sizes. Its mono sibling marks only the identifiers a machine produced. Both fonts are bundled locally (`/fonts/fonts.css`), and the dashboard makes no third-party font fetches.

### Scale
Five sizes: **11, 12, 13, 15 and 26px**. That's a small step ratio for dense data, plus one deliberate jump for the focal figure. Line heights sit on the 4px grid. Sizes are authored in `rem` (px ÷ 16) so that a user's font-size setting scales the text, and the values above are what a default root renders.

| Size | Roles |
|---|---|
| **26 / 32px** | **Display** (600, −0.03em, tabular figures): the view's one focal figure, e.g. a page's headline spend. It is the largest type in the product. |
| **15 / 20px** | **Title** (600, −0.01em): the page title in the top bar (followed by a 12px Ink 3 subtitle on the same baseline), and modal and drawer titles. **Wordmark** (600, −0.02em). Supporting figures in readout cells. |
| **13 / 20px** | **Section** (600): card and section titles. **Body** (400): working copy, input text and nav items. Inside a 32px control it takes a 16px line height (`body-control`). Prose sits in a measure of 72ch or less. **Button** (500, 16px line height inside controls). |
| **12 / 16px** | **Body dense** (400): table rows, segmented options and top-bar meta. **Label** (500): field labels and ghost buttons. **Mono** (400): identifiers in rows, the endpoint chip, the secret reveal. |
| **11 / 16px** | **Caption** (400, Ink 3): help text and sub-lines. **Overline** (500, uppercase, 0.06em, Ink 3): navigation group labels and table column heads. **Mono small**: identifiers inside 11px tags. |

**11px is the floor.** No text is smaller.

Roles that share a size differ in weight, color or case, never by a half-pixel:
- Section 13/600 vs Body 13/400.
- Label 12/500 in Ink 2 vs row text 12/400.
- Overline 11/500 uppercase vs Caption 11/400.

### Line breaks
Headings and short centered blocks use `text-wrap: balance`. Prose uses `text-wrap: pretty`. Never hand-break a heading.

### Named Rules

**The Instrument-Scale Rule.** The dashboard's type lives between 11px and 26px, on five sizes. A page title is 15px, not a marketing headline. When something needs emphasis, step up in weight or contrast (Ink 3 → Ink 2 → Ink), not in size. Only the view's one focal figure uses Display.

**The Machine-String Rule.** Geist Mono is for identifiers a machine emitted or will parse: URLs, model ids, tier names, headers, tags, key fragments, price versions, decision layers and failure kinds. **Numbers are not identifiers.** Money, counts, durations and percentages are Geist with tabular figures everywhere, from readout cells to table rows. Never set prose or figures in Mono.

## Layout

**Spacing scale.** Every space is a step on the 4px grid: 4, 8, 12, 16, 20, 24 or 32px (tokens `1`–`8`). A value off this list is a defect, not a choice. Control padding is the one exemption: it is derived from the height family ((height − line height − 2px border) ÷ 2). Every gap, margin, gutter and offset is on the scale.

**Rhythm.**
- **Within a group** (label and field, icon and text, chips in a row): 4–8px.
- **Between groups** inside a panel: 12–16px.
- **Between panels:** 16px.
- **Between page sections:** 24px.
- **Above a heading:** more space than below it. The tighter space binds the heading to its own content.

**Shell.**
- A fixed 208px sidebar.
- A top bar with a Hairline bottom rule, on the Canvas.
- A scrolling page with a 24px gutter.
- Pages are built from panels with 16px padding, laid out on grid templates:
  - two, three or four equal columns;
  - label plus field (140px | 1fr);
  - main plus side (1fr | 300px);
  - an auto-fill grid of cells with a 220px minimum.

**Navigation groups.** The sidebar's pages fall into three groups, each under an Overline label:

| Group | Pages |
|---|---|
| **Observe** | Overview, Requests, Costs, Batches |
| **Configure** | Routing, Providers, Agents, Limits |
| **Admin** | Settings, Users |

The Setup card sits below the groups until setup is complete. Overline labels name groups only. They never sit above a heading as an eyebrow.

**Control heights.** Every interactive control belongs to one height family, so controls in a row line up because of their size, not because of hand alignment. Each height includes a 1px border on every control (transparent on filled buttons), with `box-sizing: border-box`.

| Height | Controls | Padding (block × inline) |
|---|---|---|
| **32px** (default) | Primary, cancel and destructive-commit buttons; inputs and selects (selects set `height` explicitly); nav items; the segmented track | 7 × 13px (buttons), 7 × 11px (inputs), 7 × 9px (nav items) |
| **24px** (small) | Ghost buttons, the endpoint chip, filter chips, the Live pill, inspector Prev / Next; a small select in a row of 24px controls (the Requests agent filter, a Targets cell's picker) | 3 × 10px (ghost buttons), 3 × 8px (small select) |
| **26px** | Segmented options, inside the 32px track's 2px padding | 4 × 11px inside a 1px edge |
| **20px** | Static chips (tags, which are not controls) and the toggle track (36 × 20px; 32 × 18px small) | 2 × 8px (chips) |
| **44px** | Every control under a coarse pointer or below `narrow`, in the block axis. Icon-only controls are also 44px wide. | 13px block |

- **Centering:** a toggle, chip or icon inside a taller row is centered in it (`align-self: center`), never baseline-aligned.
- **One row, one height:** controls that share a row share a height, so mix only one height class per row.

**Tables.** Requests, Batches, Agents and Users share one table spec:
- **Rows:** at least 32px tall, with a Soft Hairline between rows and 16px inline cell padding.
- **Head row:** 32px, using the Overline role.
- **Alignment:** figures are right-aligned with tabular figures. Text and identifiers are left-aligned.
- **Overflow:** identifiers truncate (see Long content). Figures never truncate.
- **States:** hover takes Hover Tone, and the selected row takes the Selected state.
- **Columns** carry a priority, so a narrower container drops detail before it drops a row's meaning:
  - **Requests — P1, always shown:** time, model, status, cost. **P2:** tokens, latency. **P3:** provider, tier, decided-by.
  - **Batches — P1:** submitted, model, status, cost, with the row action on line one. **P2:** progress, wall time. **P3:** provider, tier, results-until.
  - **The agent is never a column.** It is the group boundary above its rows, and it survives every form: one line, both narrowed forms, the docked list and stacked records.
- **Narrowing:** below the table's fit width, P3 moves to a second line under the model, then P2 joins it. The table becomes stacked records only below 640px of container width. While the inspector is docked, the list shows P1 only, and a row that can't open (running, finishing, a live batch job) keeps every field on a second line.

Below the locked `narrow` threshold (768px viewport), the nav collapses to a 56px icon rail with each label available as the control's name and tooltip. Page grids drop to one column, the gutter becomes 16px, and card padding becomes 12px. That is the only spacing change; controls also grow to 44px and input text to 16px. Wide tables and composite surfaces reflow by **container** width, not viewport width. Container thresholds, re-measured whenever text or control sizes change:
- Requests moves its P3 fields to a second line at 980px and its P2 fields at 640px (its one-line and two-line fits); Batches does so at 1000px and 700px. Both become stacked records only below 640px.
- Agents reflows at 740px and Users at 660px.
- The Targets matrix reflows at 900px.
- The Pipeline reflows at 820px (two-line rows) and again at 540px (phone records).
- Layers cells stack at 480px.
- The subscription picker shows its plan list and the chosen plan's detail as two steps below a 660px card.

**Docked inspector.** On the Requests page, at viewports of 1440px and wider, the inspector docks as a 480px panel at the right edge (see Request Inspector), and the page grid gives up that width. The Overview card's inspector stays modal at every width. A request list shows its P1 columns while docked, so the table never falls into stacked records just because the inspector is open. The page and the docked panel count as one view for The Indigo Budget Rule.

**The Literal Breakpoint Rule.** Breakpoints are literal numbers inside media and container queries, mirrored in `STYLESEED.md`, because `@media (max-width: var(--x))` is invalid and fails silently. Change the stylesheet and the lock together, never one alone.

**The Class-Not-Inline Rule.** Any geometry that changes at a breakpoint lives in an `rs-*` class. An inline `style` outranks every class, so a responsive rule aimed at it parses, matches and does nothing. `responsive.test.ts` guards the known sites.

## Elevation & Depth

The system is flat, and separation is drawn rather than cast:
- **Lines:** every surface is defined by a 1px Hairline.
- **Depth from tone:** the Canvas sits behind Panel White, and inputs drop back to the Canvas.
- **Shadows:** only faint whispers (≤ 8% alpha), on panels, popovers, the drawer, toasts and the toggle knob. All of them are `none` in dark mode, where tone alone carries the layers.
- **Scrims:** modal overlays dim the page with a near-black scrim, 28% behind the drawer and 32% behind modals.
- **Docked inspector:** no scrim and no shadow, only a Hairline on its leading edge. It is part of the board, not a layer above it.

### Shadow Vocabulary
- **Whisper** (`box-shadow: 0 1px 3px rgba(20, 20, 25, 0.05)`): the resting panel, barely there beneath the hairline.
- **Pop** (`box-shadow: 0 18px 50px rgba(10, 10, 14, 0.08)`): modal cards.
- **Drawer** (`box-shadow: -12px 0 32px rgba(10, 10, 14, 0.08)`): the right-hand drawer's leading edge.
- **Toast** (`box-shadow: 0 8px 24px rgba(10, 10, 14, 0.08)`): the floating confirmation pill.
- **Knob** (`box-shadow: 0 1px 2px rgba(10, 10, 14, 0.08)`): the toggle knob.

### Named Rules

**The Hairline Rule.** Separation is always a 1px border: Hairline around a surface, Soft Hairline inside it. Never use a shadow, a heavier border or a filled band to separate surfaces. Tonal fills mark *state* (hover, selected, a notice), never structure. For example, a group-boundary row in a table is an Overline label above a Soft Hairline, not a filled band. Inset notes and key–value boxes (Canvas fill, 6px radius) are the one structural tone: like inputs, they read as wells cut into the panel.

**The Dark-Is-Flat Rule.** In dark mode every shadow token is `none`. Depth comes only from the tonal steps from canvas to panel to chip.

## Shapes

Corners are gently rounded. There are four radii, and they step down as surfaces nest:

| Radius | Token | Used for |
|---|---|---|
| **16px** | `sheet` | Bottom sheets below `narrow`, top corners only |
| **10px** | `surface` | Panels, modals, popovers, toasts, the toggle track (a 20px track makes this an exact capsule) |
| **6px** | `control` | Buttons, inputs, selects, nav items, chips, the endpoint chip, inset notes, key–value boxes, the segmented track |
| **4px** | `mark` | Segments inside the segmented track, bar tracks and their fills, skeleton blocks, keyboard hints |

- **Chips:** at 20px tall and 6px radius they read as soft tags, not pills.
- **Circles:** only in status dots, Route Trace nodes, the toggle knob and the brand mark.
- **Flush edges:** a surface flush with the viewport has square corners on that side, as the docked inspector does.

**The Dashed-Means-Absent Rule.** A dashed *border* means something is absent. There are three cases: not set up yet (the Setup card), not available on this instance (an unavailable switch), and never contacted (a skipped Route Trace attempt). A solid border means present. In charts, a dashed *line* is a reference line (a threshold or ceiling) or a non-focal series, always labelled directly.

**The Nested Radius Rule.** An inner element's radius is its container's radius minus the gap between them. A 6px track with 2px padding holds 4px segments; a 10px toggle track holds an 8px knob. Where the padding is larger than the outer radius (a 10px panel with 16px padding), the inner element simply takes its own role's radius.

## Components

### Route Trace (signature)
The board's signature: a request's recorded route, drawn in the brand mark's grammar. It answers the product's defining question, "why did this request go there?", and it is the one place the inspector spends indigo. It sits at the top of the Request Inspector, above the verbatim reason row. The trace adds to that row and never replaces it.

- **Anatomy (top to bottom):**
  - A vertical spine in a 32px graph gutter (spine at 4px, attempt nodes at 16px) starts at the **source node**: the agent's name, or the text `(no agent)`, never a raw id.
  - Next is the **decision chip**, `router · <layer>`. Any layer value the dashboard doesn't recognise still renders here as a neutral chip.
  - Then one **branch per recorded attempt**, in attempt order, ending with the **served branch**.
  - Labels sit to the right of the gutter. Each row is at least 32px tall, and labels may wrap to two lines.
- **The lit route:** the served branch is a 2px Ink Indigo stroke ending in an 8px filled indigo node. Its label is the provider name, then the model id (Mono), then `served · 1.24s`. That is the only indigo in the trace.
- **Unlit outcomes:** a failed, cancelled or unrecognised final outcome ends in an unlit node stated in words. It names the recorded provider first when that provider was the last one tried: `OpenAI · gpt-4o · failed · 1.20s`; `OpenAI · failed · 2.10s` for an exhausted chain, whose last attempt already names the model; `OpenAI · gpt-4o · cancelled by client · 800ms`; or the provider, then the recorded value verbatim. Without such a provider it reads `failed · 2.10s` or `gpt-4o · cancelled by client · 800ms`. Only a served request lights its branch.
- **Failed attempts:** a 1px `border-control` stroke ends in an 8px hollow node with a `border-control` ring. The label is the model id, then the failure in Red Text, with the kind in Mono: `rate_limit · HTTP 429`, or the kind alone when no status was recorded. Recorded markers follow. In a cascade, the leg tag (`cheap leg` / `escalation`) is appended.
- **Skipped attempts (never dispatched):** a 1px dashed Ink 3 stroke ends in a hollow dashed node. The label is the full contract string, **`skipped — circuit open (provider not contacted)`**, never a shortened form.
- **Superseded cheap call (cascade):** shown only from what was recorded, e.g. `cheap attempt superseded · q=0.42 · $0.0031`, with no model name until the API exposes one.
- **Never drawn:** chain members that were never walked, and anything reconstructed from today's routing config. The trace shows history, never configuration.
- **Commit marker:** reserved for `committed at first token · 412ms` on the served node. It appears only when the served row records its commit time, which is not recorded yet (see As-built delta). Never infer it from keepalives or from the early response commit.
- **Text first:** the trace is an ordered list (`<ol>`), and each node's text states its outcome. Strokes, nodes and dashes are `aria-hidden` decoration, and color or dash pattern is never the only signal.
- **Edge cases:**
  - A recovered request shows its failed attempts and its served branch, with no ERROR card.
  - An error row adds the ERROR note above the trace: an inset note (Canvas fill, 6px radius; never a nested panel) whose headline is the failure in Red Text, e.g. `rate_limit · HTTP 429`, never a blank slot. If every attempt was skipped, the card says the terminal member was never contacted.
  - A recovered (`fallback`) row with no attempt data shows source, decision and served, with the caption *attempt history was not recorded for this request*. Error and success rows without attempts show no caption: they can't be told apart from legacy rows.
- **Motion:** none. The path never animates in, including when stepping between rows.

### Price Receipt
This block states what the request cost and on what terms. It sits under the Route Trace.

- **Header:** `Price snapshot` (Section style), with an Ink 3 caption. For a normal request: *Recorded with the request — later price changes never apply.* For a batch request: *Batch rate, recorded at submission.* Never claim pricing at request issue time: the snapshot is taken when the request completes, or when a batch is submitted.
- **Rows:** a key–value list split by Soft Hairline rules.
  - Input and output rows always render. A cache-read or cache-write row renders only when its count or its snapshot is recorded, showing the unit price alone when the count is null. Each reads count × unit price, with at most six significant digits on the price (`$3 / 1M`, `$0.1 / 1M`). Each marker follows its own figure: `310 · est. usage × $15 / 1M · est.`
  - A `source` row, e.g. `bundled`, `native family · estimate` or `provider-listed · estimate`.
  - An `attempts` row when earlier attempts cost money.
  - The **total**, above a Hairline rule, at 13px/600. It equals served cost plus attempt cost, computed exactly in micro-dollars.
- **Figures:** Geist with tabular figures. Identifiers (model, price version) use Mono. Estimate, unpriced, not-billed and free figures follow *Figures and their states*:
  - The total carries `· est.` whenever any price in it was estimated.
  - A not-billed request reads `$0 · not billed`, plus one note line, and never shows `· est.`.
  - A null snapshot reads `unpriced` and drops the "Recorded with the request" caption.

### Request Inspector
This is where the Route Trace and Price Receipt live, opened from a request row. Its presentation depends on viewport width, and its contents are the same at every width.

| Viewport | Presentation | Behavior |
|---|---|---|
| ≤ 768px (`narrow`) | Bottom sheet (see Overlays) | Modal |
| 769–1439px | 440px drawer anchored right, on the 28% scrim | Modal: traps focus, Escape closes, focus returns to the row |
| **≥ 1440px** (Requests page; the Overview card stays the drawer) | **480px panel docked at the right edge, with no scrim and no shadow, and a Hairline on its leading edge** | **Non-modal:** the list stays live and switches to its compact columns (time, model, status, cost). ArrowUp / ArrowDown step between rows while focus is in the list or on the panel's Prev / Next buttons (24px; 44px coarse). Escape closes the panel. Each step announces a one-line summary through a polite `role="status"` region. |

- **Keyboard:** stepping skips rows that can't open (running, finishing, group boundaries). It never steps past the last loaded row into a paging reset, and never into the "N new" offer.
- **Stability:** the panel keeps a snapshot of the selected row, so a list refresh that drops the row from page 1 never unmounts it. Changing account clears the selection, the snapshot and any cached payload text.

### Figures and their states
"Numbers never lie" is a component, not a slogan. Every slot that can hold a figure has exactly one rendering per state, and **the state is always in words**. Color repeats the words; it never replaces them. The strings below are contract strings, so quote them exactly.

**Value states: what the number is**

| State | Rendering | Notes |
|---|---|---|
| **Exact** | Ink, Geist tabular figures: `$12.40`, `1,204` | The default |
| **Estimated price** | The figure + `· est.` in Ink 3. Provenance rows read `native family · estimate` or `provider-listed · estimate`. | Never amber; an estimate is provenance, not a warning. Never `~`. |
| **Estimated usage** (tokens the provider didn't report) | The count + `· est. usage` in Ink 3 | Never merged with the price estimate: they are different axes. |
| **Below display precision** | `<` + one unit of the field's precision, no space: `<$0.01` for cent fields, `<$0.0001` for four-decimal fields | A non-zero amount never prints as zero. Unit prices keep up to six significant digits instead (`$0.1 / 1M`). |
| **Free** | `$0` + `free` in green text; an estimated free price reads `$0 free · est.` | Local or free-tier models. Never `unpriced`. |
| **Not billed** | `$0 · not billed` in Ink 2, plus one note line | Never `· est.`. Aggregates add one muted caption, e.g. `3 not billed`, and no caption when there are none. |
| **Unpriced / unknown** | The word, `unpriced` or `unknown`, in Ink 3. No dash, never `$0.00`. Aggregates qualify the total, e.g. `· 4 unpriced`. | Provider pricing reads `unpriced — cost not tracked`. |
| **Notional** | The figure + `valued at API rates` | Subscription usage. It is never called cash. |

**Availability states: whether there is a number**

| State | Rendering | Notes |
|---|---|---|
| **Pending** (in flight) | A lone `—` in Ink 3 | The *only* meaning of a lone dash in a figure slot. In prose, a dash is ordinary punctuation. |
| **Loading** | A skeleton block the width of the expected figure (Chip Tone, 4px radius, 1.6s pulse), with visually hidden text `Loading <what>` | On a refetch, keep the old figures visible instead. Surfaces whose contract says "absent until loaded" render nothing. |
| **Failed** | Figures removed (never shown stale), plus a neutral notice: `<What> couldn't be loaded.`, a **Retry** button, and `Routing is unaffected.` where that is true | After Retry, focus returns to the panel. A hidden tab, an idle poll and a missing stream are **not** failures: they show no error. |
| **Unavailable** | `Unavailable` + the reason, e.g. `per-stage counts are unavailable from this server` | Distinct from Failed: nothing was attempted. Never `0` or `0%`. |
| **Absent** | Nothing: no slot, no zero, no placeholder chip | Where the contract says a null aggregate renders nothing |
| **Not applicable** | `not applicable` in Ink 3 | Never `NaN%`. Example: shares of zero evaluated traffic. |
| **Zero vs no data** | A measured zero renders `0` / `$0.00` with zero-activity copy. No data renders a sentence (`No requests in this range`). | Never draw zeros for missing data, and never a zero in place of loading or failed. |

**Freshness states: how old the number is**

| State | Rendering | Notes |
|---|---|---|
| **Stale** (data kept after a failed refresh, or older than 45s) | The figure stays in Ink, with a caption `as of 14:02 · stale` in amber text (UTC, after the period's `Resets … UTC`), plus **Retry** | Only on polled surfaces that keep their data, such as Limits. The snapshot time never advances on a failed refresh. Surfaces whose contract says "absent, never stale" use Failed instead. The plan-usage line is not one of them: it is an observation and states its own time (Observation, below). |
| **Expired** | `expired · awaiting refresh` | The previous period's balance after the UTC rollover |
| **Observation** (plan usage) | `as of 13:02 UTC` in Ink 3, ending the line, with the date when it is not today | The time of the **oldest** figure the line shows, so the line never claims newer data than it has. Absolute, never relative, so it needs no ticking clock. Never stale: no amber caption and no Retry, even after a failed Refresh usage, which keeps the line and its time and reports the failure beside the button. |
| **Reset** (plan usage) | `<label> reset · awaiting new data` in Ink 3 | A usage window whose reset has passed, shown at the instant it passes and in place of its old percent. Mirrors Expired, but names a reset rather than a refresh: passive sources have no refresh to await, only the next response. |
| **Newer rows exist** | A `12 new` button in Deep Ink | Loads them on request. It never resets paging silently. |
| **Unverified** | One notice per surface, in amber text: `Routing may have changed and the refresh failed.`, plus **Retry**. Actions that depend on it are disabled. | One notice, never one per cell. |

**Lifecycle states: where the work is**

| State | Rendering | Notes |
|---|---|---|
| **Queued / Running** | An Ink 3 dot pulsing every 1.5s, plus the word `Queued` / `Running`, plus elapsed time | The pulse is required. Neutral, not indigo. Under reduced motion the dot is steady and the word stays. |
| **Finishing** (settling) | A steady Ink 3 dot + `Finishing` | Never presented as Running |
| **Cancelling** | An Ink 3 dot pulsing every 1.5s + `Cancelling` | Neutral, like Running |
| **Reconciling** | An Ink 3 dot pulsing every 1.5s + `reconciling with provider` | The batch's outcome is still being confirmed upstream |
| **Paused / off** | A full-contrast phrase in Ink 2, e.g. `paused — needs Layer 1` | Never dimmed. An opt-in layer being off is normal configuration, never a warning. |
| **Inert / waiting** | A phrase, e.g. `waiting for the semantic source` | Inert controls are explained in text, never with opacity. |
| **Reserved** | `≤ $3.00` in Ink 2, rounded *up* to the cent so the bound stays true, with the fixed label `reserved, not spent` beneath it | Never styled as a cost. This "reserved" is money only: reserved workload classes and reserved chain rows are different ideas, with different copy. |
| **Pending batches** (Limits) | `$3.00 pending` + `pending batches occupy the allowance` | Not added to the spend line |
| **Over budget** | `106%` and `$1.50 over budget` in red text | A disabled budget shows its overage with `disabled`, and never claims `blocked`. |
| **Partial coverage** | A qualifier in Ink 3, e.g. `based on 812 of 1,024 requests` | No warning styling |
| **Mixed revision** | `request figures span 2 classifier revisions` | |
| **Inherited** | `instance defaults` in Ink 3 | Never shown as uncalibrated or zero |

**Formatting**
- **Money:** USD, with the browser locale's grouping through `Intl.NumberFormat`. Cents when the magnitude is at least $0.01. Fields that need sub-cent precision (savings, unit prices) declare it.
- **Percent:** at the precision the field's contract pins: whole numbers for budget progress (`106%`), one decimal for shares (`49.6%`).
- **Durations:** `412ms` below one second, `1.24s` below a minute, `2m 05s` above that.
- **Token counts:** compact in readouts (`12.4k`, `1.2M`, `3.1B`), exact with grouping in the inspector.
- **Zero:** `$0` inside a state rendering (free, not billed); `$0.00` as a measured zero in a cent field.
- **Time:** relative in lists (`12m ago`), with the absolute local time on hover and focus and in the inspector. Budget periods name their reset in UTC, e.g. `resets 00:00 UTC`.

**The Words-Not-Zeros Rule.** A zero is a measurement. Never use it to mean unknown, loading, failed, unavailable or absent. Each of those has its own words.

**The One-Dash Rule.** A lone `—` in a figure slot means *pending* and nothing else. A dash never prefixes or stands in for a state word (`— unpriced` is wrong, `unpriced` is right). Inside a phrase it is ordinary punctuation (`unpriced — cost not tracked`).

### Buttons
Crisp and tactile: small, exact, plainly pressable, and with every state visible. All buttons have a 6px radius and a 1px border (transparent on fills), sit in the height family, and are labelled with a verb.

| Variant | Use it for | Rest | Hover | Pressed |
|---|---|---|---|---|
| **Primary** (32px, 13px/500) | The view's one committed action (The Indigo Budget Rule) | Ink Indigo fill, white text | `accent-fill-hover` | `accent-fill-pressed` |
| **Secondary** (32px, 13px/500) | Cancel, and every other action at button size | Hairline border, Ink 2 text | Hover Tone fill, Ink text | Chip Tone fill |
| **Ghost** (24px, 12px/500) | Inline row and card-header actions (`Details`, `Retry`, `Copy`) | Hairline border, Ink 2 text | Deep Ink border and text | Indigo Wash fill |
| **Destructive ghost** (24px, 12px/500) | The trigger for Delete, Remove, Purge, Disable and Cancel batch | Signal Red border (3.91:1), Red Text label | Red Wash fill | Red Wash fill, 2px Red Text border inside the same box |
| **Destructive commit** (32px, 13px/500) | The commit inside a destructive confirm dialog only | Red Fill, white text | `red-fill-hover` | `red-fill-pressed` |

States that apply to every button:
- **Focus:** the shared focus ring (see Focus ring).
- **Disabled:** natively `disabled` at 60% opacity, for a temporarily unavailable action only. An action the user may never take isn't rendered at all.
- **Busy:** natively disabled with `aria-busy="true"` and a progressive label (`Saving…`, `Deleting…`). It keeps full opacity, because busy is not unavailable, and it keeps its width, so nothing beside it shifts.
- **Motion:** pressed states apply immediately, with no transition. Never lift, glow or scale.

Recoverable actions use Secondary or Ghost, never a destructive variant: rotate a key, revert, sync, test, clear a target. Amber is not a button color, because amber is status.

### State matrix
Every interactive control covers every state that applies to it. "—" means the state doesn't apply.

| Control | Hover | Pressed | Selected | Focus | Disabled | Busy | Invalid |
|---|---|---|---|---|---|---|---|
| Buttons | per variant | per variant | — | ring | native, 60% | progressive label | — |
| Input / select | Ink 3 border | — | — | Indigo border + ring | Chip Tone fill, Ink 3 text | — | Red border + message |
| Toggle | — | — | on = Ink track | ring | unavailable (dashed, `aria-disabled`) | on/off look kept, `aria-disabled`, focus kept | — |
| Nav item / segment / filter chip | Hover Tone | Chip Tone | Selected state | ring (inset on nav) | — | — | — |
| Table row | Hover Tone | — | Selected state, inset | inset ring | — | — | — |
| Endpoint chip | Deep Ink border | Indigo Wash | — | ring | — | `Copied` label | — |

### Chips
- **Static chip (tag):** a 20px tag with a Chip Tone fill, 2px × 8px padding, 11px Ink 2 text and a 6px radius. It is not a control.
- **Filter chip:** a 24px control with a 1px Control Edge border, 3px × 8px padding, 12px text and a 6px radius. Active filters take the Selected state.
- **Endpoint chip:** a 24px Panel White control with a Hairline border, a 6px radius and 12px Geist Mono in Ink 2. Its copy glyph is Ink 3. Hover turns its border Deep Ink and its text Ink. It is a copyable machine string.

### Cards / Containers
- **Corner Style:** 10px.
- **Background:** Panel White on the Canvas.
- **Shadow Strategy:** the Whisper shadow in light mode, none in dark (see Elevation & Depth).
- **Border:** a 1px Hairline.
- **Internal Padding:** 16px, or 12px below `narrow`.
- **Never nested:** a panel inside a panel is a defect. Inside a panel, group with spacing, Soft Hairline rules or an inset note (6px radius, Canvas fill).

### Inputs / Fields
- **Style:** a 32px field with a Canvas fill (so it sits *into* the panel), a 1px Control Edge (3.26:1 against its own fill), a 6px radius, 7px × 11px padding and 13px text. The label above it is 12px/500 in Ink 2, 4px above the field.
- **Focus:** the border turns Ink Indigo, plus the shared focus ring when focus comes from the keyboard.
- **Help text:** 11px Ink 3, 4px under the field, linked with `aria-describedby`. It says what the field takes, e.g. `https URL, or http on localhost in self-host mode`.
- **Invalid:** a 1px Signal Red border (3.75:1 on Canvas), `aria-invalid="true"`, and a message under the field in red text. The message names the problem and the fix, e.g. `Base URL must start with https://`, and replaces the help text while the field is invalid. The typed value is always kept. Validate on blur and on submit, never on each keystroke.
- **Read-only:** a Panel fill, a Hairline border and Ink text. It stays focusable and selectable, and its value can be copied.
- **Disabled:** a Chip Tone fill and Ink 3 text, natively `disabled`. Use it only for a control that is temporarily unavailable. A control the user isn't permitted to use is not rendered at all.
- **Hit target:** at least 24px tall at every width, and 44px under a coarse pointer or below `narrow`. At those sizes, input text is **16px** so iOS doesn't zoom the page on focus.

### Navigation
- **Sidebar:** 208px, with the 20px brand mark and the 15px/600 wordmark at the top, then the three Overline-labelled groups (see Layout). Nav items are 32px tall, with 7px × 9px padding inside a 1px transparent border, a 6px radius, an 8px gap between icon and label, and counts aligned right in Ink 3 tabular figures. Idle items are 13px Ink 2, and hover adds Hover Tone. The **active** item takes the Selected state (below) and `aria-current="page"`.
- **Narrow:** the sidebar collapses to a 56px icon rail. When expanded, it is a modal dialog with a scrim.
- **Segmented control:** a 32px Panel White track with a Hairline border, a 6px radius and 2px inner padding, holding 26px options with a 4px radius and 4px × 11px padding inside a 1px edge. Idle options are 12px/400 Ink 3. The selected option takes the Selected state and `aria-pressed="true"`. The Routing page's tabs are this control.

### Selected state (one treatment everywhere)
Everything that marks "this is the current one" uses a single treatment: the active nav item, the selected segment (range, mode, metric, tabs), the active filter chip, the selected table row, the open inspector's row, the selected provider-kind card and the current Setup step.
- **Fill:** Indigo Wash.
- **Label and icon:** Deep Ink (`accent-deep`) at weight 500.
- **Edge:** a 1px Deep Ink border (5.92:1 light / 4.99:1 dark against the wash). On a table row it is drawn inset, so the row's geometry doesn't change.
- **Not used:** no shadow, no colored side stripe. The border is drawn with `border` or an outline, never `box-shadow`, so it survives dark mode, where every shadow token is `none`.
- **Semantics:** the state also lives in the markup: `aria-current`, `aria-pressed`, `aria-selected` or `aria-expanded`.

### Focus ring
- **Ring:** 2px solid Ink Indigo with `outline-offset: 2px`, shown on `:focus-visible` only and never suppressed. At that offset the ring only ever touches surface colors, at 3.07:1 or better (the dark Amber Wash).
- **Fills:** never use a zero or negative offset on an indigo fill, a red fill or the off toggle track. The ring would merge with it, at 1.00–1.42:1.
- **Rows and list items:** these sit flush with their container, so they draw the ring inset (offset −2px), where it sits on the row's own fill.
- **Clearance:** keep at least 4px between a focusable element and any `overflow: hidden` edge, so the ring isn't clipped.

### Toggle
- **Track:** 36px × 20px (32px × 18px for the small size) with a 10px radius, so it is an exact capsule that centers on whole pixels in 24, 32 and 44px rows. The hit area extends to 24px with a `::before`, and to 44 × 44px under a coarse pointer. There are four states, and each looks distinct:

| State | Track | Knob |
|---|---|---|
| **On** | Ink | Panel color |
| **Off** | Filled Control Edge | Panel color |
| **Unavailable** (the instance cannot enable it) | Transparent, with a 1px dashed Ink 3 border | Ink 3 |
| **Busy** | Unchanged from on/off; `aria-disabled="true"` and focus kept while the change saves (never native `disabled`) | Unchanged |

  - On and off differ by 5.22:1 (light) and 4.56:1 (dark) in fill alone, and the knob position repeats the difference.
  - Indigo is not used on switches (The Indigo Budget Rule).
- **Knob:** a 16px circle (14px small), inset 2px, in the panel color: white in light mode, `#16171b` in dark, so it always contrasts with the near-white dark-mode on track. In light mode it carries the Knob shadow; dark mode has none. The knob slides over 0.15s and the track color fades over 0.15s.

### Overlays
- **Drawer:** 440px wide and anchored right, on a 28% scrim, with a Hairline leading edge and the Drawer shadow. It slides in from 24px over 0.18s with ease-out. The head is 16px × 20px over a Soft Hairline rule, with a 15px/600 title. The body has 20px padding and a 16px gap. The tuning drawers (self-calibration, semantic learning) are always this drawer. Only the Request Inspector docks.
- **Modal:** a 480px card (at most 92vw) with a 10px radius and the Pop shadow, on a 32% scrim. It has 24px padding, a 16px gap and a 15px/600 title.
- **Subscription picker:** the provider modal's one wide mode. Choosing the Subscription kind for a new provider widens the same card to 800px (still at most 92vw) and drops its outer padding for three bands, each with its own padding over a Soft Hairline rule:
  - a header (title, the "Add provider · Subscription" subtitle, a Change kind ghost);
  - a body with a 272px plan list (32px entries in the Selected state) beside the chosen plan's detail;
  - a footer holding Cancel and the one primary action.
  Below the `picker-fit` container width (660px) the list and the detail become two steps, and below `narrow` it is the same full-width sheet as every modal.
- **Narrow:** the drawer, all modals and confirmations become bottom sheets: the same DOM with 16px top corners, 20px × 16px padding plus the safe area, and a 56px strip of page left visible above.
- **Toast:** an inverted 32px bar. The background is Ink and the text is the Canvas color, at 13px/500 with 8px × 16px padding and a 10px radius. It floats 24px from the bottom, centered, and spans the full width minus 12px each side below `narrow`.
  - It confirms a completed action (`Agent created`, `Copied`) with `role="status"`, and dismisses after 4s. The timer pauses while the toast is hovered or focused.
  - It is **not** the place for failures. A failure appears inline where the action was, with `role="alert"`.
  - The one exception is an action with no inline home, such as a failed clipboard write. That toast leads with the state in words (`Copy failed — select the text manually`), uses `role="alert"`, and stays 8s.

### Notices
A notice is a status message inside a panel, or across the top of a page.
- **Anatomy:**
  - A status-word title in the Section role (13px/600), in the state's text color: `Couldn't load`, `Over budget`, `Unverified`.
  - One or two sentences of Ink 2 body.
  - At most one action, as a ghost button on a Panel fill (`Retry`, `Review budget`), so its label never sits on a wash.
- **Shape:** the state's wash fill, a 6px radius and 12px padding. There is no icon-only variant and no colored side stripe.
- **Tones:**

| Tone | Fill | Title color | ARIA role |
|---|---|---|---|
| Info | Chip Tone | Ink 2 | `status` |
| Success | Green Wash | Green Text | `status` |
| Caution | Amber Wash | Amber Text | `status` |
| Failure | Red Wash | Red Text | `alert` |

- **Page-level notices** sit at the top of the page content, for example `Agent "ci-bot" hit its block budget — requests are being refused until 00:00 UTC.` A notice about a condition that ends once its cause is fixed has no dismiss: it stays until the condition ends (a blocking budget, Reconnect needed, Unverified, Couldn't load, a failure).
- **Dismiss:** only a standing advisory carries one. A standing advisory states a property of the configuration that nothing in the dashboard can fix, for example a subscription provider's Terms risk.
  - The dismiss is an icon-only `×` at the end of the title's row, apart from its one ghost action. The title wraps before it, and the body keeps the notice's full width.
  - It is 24px, growing to the 44px comfort target, in Ink 3, and Ink on hover (never red, since dismissing is not a deletion).
  - Its accessible name says what it dismisses: `Dismiss terms risk for <provider>`.
  - A dismissal is remembered where the advisory lives. Terms risk's is remembered on the server, per provider.
- **Live regions:** a polite region announces a notice once when it appears. Background list refreshes never announce.

### Confirm dialog
A confirm dialog is a modal card that asks before a destructive action: one that destroys data, abandons in-flight work, or cuts off access.
- **Title:** the action and the resource, e.g. `Delete agent "ci-bot"?`.
- **Body:** one or two sentences on the consequence. Say what stops working and what is kept, e.g. `New requests with its key will be refused. Past requests stay in the log.` Never overpromise.
- **Actions:** Cancel, then the commit button, labelled with the verb (`Delete agent`), never `OK`.
- **Initial focus:** Cancel for a destructive action; the commit button otherwise.
- **Dismissal:** Escape or a click on the scrim cancels, unless the dialog is busy.
- **Busy:** the commit label becomes progressive (`Deleting…`) and both buttons are natively disabled.
- **Failure:** shown inline in the dialog, and the dialog stays open.
- **Consent confirmations** (enabling body capture) use the same structure and commit with the Primary button.
- Recoverable actions (rotate a key, revert to defaults, clear a target) don't ask first.

### Secret reveal (shown once)
For a new agent key:
- The **full value** shows in Mono 12px in a read-only field (Panel fill, Hairline border; see Inputs › Read-only). It is never masked, because the user has to copy it.
- A **Copy** ghost button changes its own label to `Copied` for 2s and announces it.
- The copy above the value says plainly: `This key is shown once. Store it now — it can't be shown again.`
- Closing (a `Done` button, Escape, or the scrim) is always allowed. The sentence above carries the warning.

### Empty states
An empty surface teaches its next action. It is one sentence saying what will appear here, plus the action that makes it appear. Example: `No requests yet. Point an agent at your endpoint to see traffic here.` followed by the endpoint chip.
- It sits left-aligned inside the panel, with no illustration and no zero chart.
- A filter that matches nothing says so and offers `Clear filters`.

### Long content and localisation
- **Identifiers** (model ids, agent names, URLs) truncate with an end ellipsis in tables. The full value is the element's accessible name and its hover and focus title. They wrap (`overflow-wrap: anywhere`) in the inspector and in dialogs. **Figures never truncate.**
- **Formatting:** numbers and dates go through `Intl`. Layouts use logical properties (`margin-inline`, `padding-inline-start`). Text containers leave 30–40% room for longer translations, and buttons size to their label.
- **Zoom:** every surface works at 200% browser zoom and reflows down to 320px wide.

### Readout strip
This is how a page states its headline figures (Overview, Costs). It replaces a row of identical number cards: **one** panel holding a focal cell and, beside it, the other figures as rows, ruled apart by Soft Hairlines.
- **The focal cell:** it holds the view's one focal figure in Display (26px). On Overview and Costs that is the headline spend for the range. Its 12px Ink 3 label sits above the figure, and its 11px Ink 3 qualification below. A secondary figure, when there is one, gets its own line between them at Body (13px) in Ink 2, e.g. Overview's `$3.12 served on subscription, at API rates · excluded from spend`.
- **The rows:** every other figure is one row: the 12px Ink 3 label, the figure at Title size (15px/600), then its 11px Ink 3 qualification, e.g. `all on subscription plans`. The rows share their label and figure columns, so every figure starts at one x, and the widest label or figure sets the column for all of them.
- **Level sides:** the rows divide the panel's height between them, so the focal cell and the rows column end level and neither leaves a blank band under a short figure. A Soft Hairline rules the rows column from the focal cell, and each row from the one above. With no other figures, the focal cell fills the panel alone, with no column and no rule.
- **Narrow:** below the narrow threshold the rows stack under the focal cell, ruled from it by a top hairline. Each row keeps its label, figure and qualification, and a long qualification wraps in its own column.
- **No hero template:** no accent fill and no icon chips. The focal figure is plain Ink. Its prominence comes from size, never from color.

### Live lamp
A 6px dot in the top bar's 24px Live pill, followed by the word `Live` or `Polling`. The words carry the state, and the dot repeats it.
- **Live:** a Signal Green dot that rests steady and **blinks once** each time an event arrives (opacity 1 → 0.35 → 1 over 600ms, ease-out). A burst of events gives at most one blink per second. The lamp moves only when something happened, so its motion is literally true.
- **Polling:** a steady Faint dot. It's decorative, because the word beside it carries the state.
- **Reduced motion:** a steady dot with no blink.

### Motion
Snap: quick and decisive, and only ever conveying state.

| Kind | Timing | Applies to |
|---|---|---|
| State changes | 150ms | Colors, the toggle knob and track |
| Entrances | 180ms ease-out, from 24px | The drawer, sheets, the nav rail |
| Disclosure | 120ms | The chevron rotates 180° |
| Required loops (neutral; never indigo) | 1.5s pulse | Running, queued, cancelling and reconciling dots |
| Required loops (neutral; never indigo) | 1.6s pulse | Skeleton blocks |

- **Never animated:** page loads (no choreography), Route Trace paths, and figures, which never count up or tween.
- **Reduced motion:** every animation and transition collapses to an instant change. Loops stop, the Live lamp is steady, and the words still say what is happening.

### Browser surfaces
The parts nobody draws still carry the system:
- **Native widgets:** `color-scheme` is set to `light` or `dark` with the theme, so native controls, scrollbars and form widgets follow it. `accent-color` is Ink Indigo for any native checkbox or radio: a state mark, like the focus ring, outside the Indigo Budget.
- **Selection and caret:** `::selection` is an Indigo Wash background with Ink text. `caret-color` is Ink Indigo.
- **Scrollbars:** thin, with a Control Edge thumb on a transparent track. They appear only in scrolling panes: tables, the inspector, the drawer body.
- **Links:** Deep Ink, underlined on hover and focus, with `text-underline-offset: 2px`. **Links inside prose are always underlined**, because Deep Ink alone isn't 3:1 against the surrounding text.
- **Figures:** `font-variant-numeric: tabular-nums` on every figure.
- **Theme:** the first visit follows `prefers-color-scheme`. A manual choice is remembered per browser and wins from then on.

## Do's and Don'ts

### Do:
- **Do** explain traffic with the Route Trace. When a surface answers "where did this go, and why", draw the route in the brand mark's grammar. Don't add another table.
- **Do** spend indigo by the Indigo Budget: one indigo-filled control and one indigo data series per view. Indigo text is `accent-deep`, never `--accent`.
- **Do** write color as tokens: `var(--accent)` and its `color-mix` derivations, never a hex in a component.
- **Do** give every figure slot its states from *Figures and their states*, in words: `· est.`, `unpriced`, `<$0.01`, `$0 · not billed`, `≤ $3.00`, `$1.50 over budget`.
- **Do** draw entry controls with Control Edge (3:1+), and show every state by a change in shape, border or weight, never by a tint alone.
- **Do** keep every control in the height family (24 / 32px, 44px coarse), and every space on the 4px scale.
- **Do** give every pressable control visible hover, pressed, focus and busy states, as tone, border or label changes.
- **Do** confirm destructive actions with the resource and the consequence in words, and commit with the red Destructive commit button.
- **Do** meet the 24px hit-target floor at every width, and 44px below 768px or under a coarse pointer. Set input text at 16px there.
- **Do** put any geometry that changes at a breakpoint in an `rs-*` class. Change `STYLESEED.md`, `styles.css` and the contract tests together, and remove the matching As-built delta row.

### Don't:
- **Don't** build a rainbow dashboard: no hue per card, series or category, and no colored stripes or icons used only for identity. Identity is carried by text.
- **Don't** slide into enterprise grey sludge. That means heavy or doubled borders, Control Edge on surfaces that aren't controls, text below 11px, text lighter than Ink 3, and screens where every panel has equal weight.
- **Don't** use the hero-metric template (big number, small label, supporting stats, accent) as a row of identical cards. Use one Readout strip with one Display figure.
- **Don't** let a zero mean unknown, loading, failed, unavailable or absent. Don't pair a dash with a word (`— unpriced`), and don't print an estimate without `· est.`.
- **Don't** set figures in Mono, or prose in Mono. Mono is for identifiers.
- **Don't** separate surfaces with drop shadows, nest a panel inside a panel, or show any shadow in dark mode. Selected edges are borders, never `box-shadow`.
- **Don't** use pure black (#000) text. Ink is #17181a.
- **Don't** use amber for an action, or an indigo commit inside a destructive dialog.
- **Don't** animate figures, Route Trace paths or page loads. Don't loop anything except the in-progress pulses (running, queued, cancelling, reconciling) and skeletons; the Live lamp blinks only on an event.
- **Don't** fetch fonts or assets from a third party, or set a responsive dimension in an inline `style`. An inline style outranks the breakpoint rule and silently ignores it.
