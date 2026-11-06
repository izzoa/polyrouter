# StyleSeed — Design Lock
<!-- Locked design decisions. The agent re-reads this on every UI prompt and must obey it.
     Editing a value here changes the design project-wide; never restyle ad hoc. -->

- App domain:        infra / analytics dashboard (self-hosted LLM router console)
- Skin:              custom (polyrouter prototype)
- Preset:            (none)          # set later by /ss-restyle — the gate reads this
- Palette mode:      single-accent   # green/amber/red are semantic STATUS; red also marks destructive intent (destructive ghost + commit only); add +categorical via /ss-update when multi-series charts land
- Key color (accent): #4F5DFF       # both modes; use var(--accent) + its color-mix derivations (--accent-bg, --accent-deep, --accent-fill-hover, --accent-fill-pressed) — never hardcode; indigo text is --accent-deep, never the raw accent
- Radius personality: soft           # 4 / 6 / 10 / 16px (mark / control / surface / sheet); circles only for dots, knobs and nodes; nested radius = outer − gap
- Elevation:         flat-borders    # 1px hairline borders are the separation language; whisper shadow stays ≤ 8%
- Density:           compact         # 16px card padding, 24px gutter; 4px scale (0 / 4 / 8 / 12 / 16 / 20 / 24 / 32px), off-scale only for a control's derived padding; tight data rhythm
- Motion seed:       Snap            # quick/decisive (Linear/Vercel family); state moves only: loops only where required (`pulse` on running, queued, cancelling and reconciling dots, and on skeletons); the Live lamp's event-driven `lamp-blink` (once per data event, at most one a second); surfaces enter with `slidein` / `slideinleft` / `sheetin`; no page-load choreography; reduced motion collapses every move
- Type:              Geist + Geist Mono  # 5 sizes 11 / 12 / 13 / 15 / 26px, authored in rem (px ÷ 16) so the user's font-size setting scales them; line heights 16 / 20 / 32px; 11px floor; 26px Display only for the view's one focal figure; Mono for identifiers only; figures tabular; bundled locally in packages/frontend/public/fonts — no third-party fetches, ever
- Locked:            2026-07-17

### Responsive (locked 2026-08-06)

| Token | Value | Applies to |
|---|---|---|
| `narrow` | **768px** viewport | Nav collapses to the rail; page grids drop columns; gutters shrink; `target-comfort` applies |
| `table-fit-requests` | **980px** container | The 9-column requests table reflows to stacked records (re-measured 2026-11-02 on the adopt-design-tokens-v2 geometry: a track drops under 60px at 975, rounded up) |
| `table-fit-batches` | **1000px** container | The 10-column batches table reflows to stacked records (measured on its own 2026-11-02, no longer set equal to requests: a track drops under 60px at 981, rounded up) |
| `table-fit-agents` | **740px** container | The 7-column agents table reflows (re-measured 2026-11-02: a track drops under 60px at 734, rounded up; the one-line Actions cell holds its content width) |
| `table-fit-users` | **660px** container | Both semantic `<table>`s on the Users page reflow (re-measured 2026-11-02: with identifiers cut no cell wraps; the Members User cell paints past its box at 643, rounded up) |
| `table-fit-targets` | **900px** container | The Routing page's 4-track Targets matrix (Workload, Claim, Strong, Cheap) reflows to one stacked record per workload row (re-measured 2026-11-02 on 16px gaps and inset: the 220px cell pickers overflow at 891, rounded up; set by the pickers, not by text) |
| `pipeline-fit` (two-line) | **820px** container | The Auto routing Pipeline's rows move their status to line 2, keeping number, name, figure and action on line 1 (re-measured 2026-11-02: the Classify status runs past two lines at 816; rounded up) |
| `pipeline-fit` (phone) | **540px** container | The Pipeline's rows become phone records: number, name and a 44×44 icon-only action, then the status, then the figure, every field under its visible label (re-measured 2026-11-02: a stage name wraps at 528; rounded up) |
| `layers-fit` | **480px** container | The Setup panel's three Layers cells stack to one column (re-measured 2026-11-02: a cell's name line wraps at 478; rounded up) |
| `rail-collapsed` | **56px** | Width of the collapsed icon rail (44px target + 6px each side) |
| `gutter-narrow` | **16px** | Page padding below `narrow` (from the 24px desktop gutter) |
| `density-narrow` | `.card` `16px` → **`12px`**; gaps unchanged | The only density steps that change below `narrow` |
| `target-base` | **24px** in BOTH axes | Minimum hit target at **every** width (WCAG 2.5.8 AA) |
| `target-comfort` | **44px in the block axis**, and 44px in the inline axis for icon-only controls | Below `narrow`, and under `pointer: coarse` at any width |
| `input-text-comfort` | **16px** (`1rem`) | Text in every entry field (input, select, textarea, combobox) below `narrow` and under `pointer: coarse`, so a mobile browser does not zoom the page on focus; the one `font-size` the comfort blocks set |
| `height-family` | **32px** default · **24px** small (ghost buttons, filter chips, the endpoint chip, the Live pill, and `select--sm`, a select in a row of 24px controls) · **26px** segmented option (in its 32px track) · **20px** static chip; each a border-box `min-height` with a 1px border, transparent on fills | Every single-line control at desktop; one row, one height; `target-comfort` raises the family to 44px |
| `switch` | **36×20** drawn track (**32×18** small), 10px radius, 16 / 14px knob inset 2px; hit area **24px** tall at desktop, **44×44** below `narrow` and under `pointer: coarse` | Every `Toggle` (`toggle--md` / `toggle--sm`); never indigo |
| `sheet-strip` | **56px** | Page left visible above a sheet. An absolute strip, not a `vh` fraction, so it reads the same on a 568px phone and an 844px one |
| `sheet-radius` | **16px**, top corners only | Drawer, modal and confirmation sheets below `narrow` |
| `sheet-padding` | **20px 16px**, plus the safe area on the bottom | Modal and confirmation sheets (the drawer keeps its own `20px` body) |
| `toast-narrow` | **12px** each side, full width | Below `narrow`. It has no width of its own, so `left: 50%` had it shrink-wrapping into half the screen |
| `toast-offset` | **24px** from the bottom | At every width; below `narrow` it adds the safe area and the occluded keyboard. A positional offset, so a lock value rather than a guarded space |
| `safe-area` | `calc(<design value> + var(--safe-area-bottom))` | Every bottom-anchored surface |
| Verification matrix | 320×568 · 390×844 · 768×1024 · 1025×768 · 1440×900, plus a coarse-pointer context above 768px | Where responsive assertions run |

**These are literals in `styles.css`, not custom properties.** `@media (max-width: var(--narrow))` is invalid CSS and fails silently, so the query preludes carry the numbers directly — the lock and the stylesheet must therefore be changed together, never one alone.

**Overlays are not exempt from `narrow`.** Phase 1 excluded them; phase 2 does not. Below the
threshold the drawer, all six modal kinds and both confirmation dialogs are presented as
**bottom sheets** — same DOM, restyled, so the dismissal path, focus trap, layer registration
and accessible name stay the same objects at both widths and cannot drift apart. Above the
threshold every one of them renders exactly as its pinned geometry records: geometry pinned
from the pre-change tree, or as a recorded change re-pinned it.

**Desktop geometry changes only through a recorded change.** A change that alters a desktop
dimension (the type, spacing, radius or control-height scale, the switch, a gutter, an
overlay's box) records the new values in this lock, changes `styles.css` in the same change,
and re-captures every pinned desktop measurement it moves, so the browser suite passes against
the recorded values. A desktop difference the lock does not record still fails the suite.
`adopt-design-tokens-v2` was the first such change.

**Safe-area insets are `calc`, not `max`, and require `viewport-fit=cover`.** `calc(design +
inset)` keeps the design's breathing room on a notched device; `max(design, inset)` would
absorb the padding into the inset and leave content clearing the home indicator by nothing.
`env()` is read once into `--safe-area-bottom` and every consumer uses that variable —
`env()` cannot be overridden from a test, so consuming it directly would leave the
positive-inset case permanently unverifiable while the zero case passed vacuously. Without
`viewport-fit=cover` on the viewport meta, `env()` reports 0 on every device.

**A bottom sheet is anchored to `--vv-occluded-bottom`, never to 0.** A `position: fixed`
element resolves against the *layout* viewport, which does not shrink when the on-screen
keyboard opens, so a sheet at `bottom: 0` sits behind the keyboard however tall it is. The
variable is published by `visualViewport.ts` and is 0 whenever nothing is covering the
screen. It divides the pinch-zoom scale back out — without that, zooming to 2× is
indistinguishable from a 422px keyboard and the sheet leaps up the screen.

**The account footer is pinned inside the expanded rail.** Below `narrow` the expanded nav
scrolls, and the footer is its last child — so once the nav is taller than the screen the
footer starts below the fold, and the account menu, which opens upward from a trigger
inside it, renders entirely off-screen. It is `position: sticky; bottom: 0` with the panel
background, which makes the shell contract's "the account stays reachable in the expanded
state" independent of how many pages the nav happens to carry. Adding the eleventh page is
what found this.

**Table thresholds are per table and were measured, not chosen** — see `measurements.md` in the responsive change. They are container widths, not viewport widths: a table cares about the space it actually gets, which is roughly `viewport − 208px sidebar − gutters`.

**Known and intended consequence:** because `table-fit-requests` is 980px, the requests table reflows to cards below roughly a **1240px viewport** (980 + 208px sidebar + 2 × 24px gutter + 2px panel border = 1238) — on narrow desktops, not only phones. At 975px of panel that table has a sub-60px column, so the wide layout is genuinely unreadable there. A table adapting to its own container is one of the desktop differences the layout contract allows, beside controls growing to meet `target-base`; every other desktop difference is a recorded change (above).

`table-fit-targets` was measured the same way in `redesign-auto-routing-pipeline`, re-measured in `split-auto-routing-readout-setup` when the Detected column left, and again in `adopt-design-tokens-v2` (the rig and its derivation are recorded beside the query in `styles.css`). Its container is the matrix's own content box, `viewport − 290px` (208px sidebar + 2 × 24px gutter + 2px panel border + 2 × 16px matrix inset; read at 1000, 1200 and 1400px viewports), so the Targets matrix shows stacked records below roughly a **1190px viewport** (900 + 290). A 1280px laptop keeps the grid.

`pipeline-fit` and `layers-fit` are measured the same way, on their own wrappers' content boxes: the Pipeline's rows are `viewport − 258px` wide (208px sidebar + 2 × 24px gutter + 2px panel border, with no padding inside the wrapper; read at 1000, 1200 and 1400px viewports), so they are one line from roughly a **1080px viewport** (820 + 258 = 1078), two lines on a 1025×768 or 768×1024 screen, and phone records at 390 and 320. These are container modes and do not line up with `narrow`; the rows never use `narrow` for their layout, only its comfort target for their action boxes.

**What the comfort floor does and does not promise.** It is 44px of *height* on every
interactive control, plus 44px of *width* on controls with no text to widen them (the rail
toggle, `.icon-x`, `.drag-handle`, `.drawer-close`). Text controls sitting in a group — a
range segment, a filter chip, an inline "Copy" link — may be 28–38px wide (re-measured at the
44px comfort height for `adopt-design-tokens-v2`: an inline Copy 28–31px, the `All` filter
chip 33px, the `7d` range segment 38px; every other group control is 44px or wider); they clear the
24px AA floor in both axes and widening them would break the group's rhythm for no
accessibility gain. A control MAY meet the floor by an expanded hit area rather than its own
box: the switch keeps its locked 36×20 drawn track (32×18 small) and reaches 44×44 through a
`::before`, which is verified by hit-testing, not by measuring its rectangle. Checkboxes and
radios are excluded — a floor there stretches the control, not its tap area.

**Density is not relitigated by this.** The locked `compact` desktop rhythm stands; `density-narrow` applies only below `narrow`. `target-base` is the sole floor that touches desktop, because an accessibility minimum is not a density preference.

## How agents must use this lock

- **One focal point per screen, spent by the Indigo Budget.** Each view (a page, or an open dialog or drawer) spends `#4F5DFF` on at most **one indigo-filled control** (its primary action) and **one indigo data series** (its focal measure; one measure repeated per record is one); everything else is greyscale plus green/amber/red for semantic status, and red for destructive intent. State marks are unbudgeted: the focus ring, a focused field's edge, the caret, `accent-color`, Deep Ink (`--accent-deep`) text and hover edges, and the Selected state. So is the brand mark's lit route, which is identity. Switches, running dots, the setup progress ring, hover fills and borders, icon chips and decorative accents are never indigo. Never introduce a second emphasis hue; never hardcode accent hexes — use `var(--accent)` and its derivations from `packages/frontend/src/styles.css`. The raw accent's allowed sites are guarded in `styles.contrast.test.ts`, and each view's count in `browser/indigoBudget.spec.ts`.
- **Quality gate before showing any UI:** run `/ss-score` (Claude Code) or `$ss-score` (Codex) on the changed **UI screens and components** — not tests, OpenSpec artifacts, package metadata, or changelogs, where a design score is meaningless. If < 80, apply the fix-first list and re-score (up to ~3 loops) until ≥ 80. Only then present the result, stating the score. For a full screen, run `/ss-build` — it enforces this entire loop.
- **Responsive conformance is a gate failure, not a deduction.** A screen that does not adapt at the locked `narrow` threshold, or a table that does not adapt at its `table-fit`, fails the gate outright regardless of score. The evidence is the **browser assertions** (document does not overflow at every matrix viewport, hit targets meet their floor) — a static file score cannot prove narrow rendering, so it must never be treated as having done so.
- **Stack:** SolidJS + Vite + custom CSS (NOT React/Tailwind — StyleSeed's scaffolding does not apply). Use StyleSeed as rulebook + gate only: express the Snap seed as CSS transitions/keyframes on the tokens in `styles.css`; never import StyleSeed's React `engine/` components, Tailwind classes, or framer-motion. Respect `prefers-reduced-motion` on any non-trivial motion; never animate the payload (numbers, costs, results).
- **Process:** UI feature work still goes through OpenSpec changes (see CLAUDE.md); this lock governs how that UI must look, not whether to build it.
