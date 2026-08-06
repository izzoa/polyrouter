# StyleSeed — Design Lock
<!-- Locked design decisions. The agent re-reads this on every UI prompt and must obey it.
     Editing a value here changes the design project-wide; never restyle ad hoc. -->

- App domain:        infra / analytics dashboard (self-hosted LLM router console)
- Skin:              custom (polyrouter prototype)
- Preset:            (none)          # set later by /ss-restyle — the gate reads this
- Palette mode:      single-accent   # green/amber/red are semantic STATUS only; add +categorical via /ss-update when multi-series charts land
- Key color (accent): #4F5DFF       # both modes; use var(--accent) + its color-mix derivations (--accent-bg, --accent-deep) — never hardcode
- Radius personality: soft           # 10px panels; nested radius = outer − padding
- Elevation:         flat-borders    # 1px hairline borders are the separation language; whisper shadow stays ≤ 8%
- Density:           compact         # 16–18px card padding, tight data rhythm, 4px grid
- Motion seed:       Snap            # quick/decisive (Linear/Vercel family); keyword moves (pulse-beat, shimmer, stagger-cascade) allowed
- Type:              Geist + Geist Mono  # bundled locally in packages/frontend/public/fonts — no third-party fetches, ever
- Locked:            2026-07-17

### Responsive (locked 2026-08-06)

| Token | Value | Applies to |
|---|---|---|
| `narrow` | **768px** viewport | Nav collapses to the rail; page grids drop columns; gutters shrink; `target-comfort` applies |
| `table-fit-requests` | **960px** container | The 9-column requests table reflows to stacked records |
| `table-fit-agents` | **680px** container | The 7-column agents table reflows |
| `table-fit-users` | **660px** container | Both semantic `<table>`s on the Users page reflow |
| `rail-collapsed` | **56px** | Width of the collapsed icon rail (44px target + 6px each side) |
| `gutter-narrow` | **18px 16px** | Page padding below `narrow` (from `22px 26px`) |
| `density-narrow` | `.card` `16px 18px` → **`14px 14px`**; gaps unchanged | The only density steps that change below `narrow` |
| `target-base` | **24px** in BOTH axes | Minimum hit target at **every** width (WCAG 2.5.8 AA) |
| `target-comfort` | **44px in the block axis**, and 44px in the inline axis for icon-only controls | Below `narrow`, and under `pointer: coarse` at any width |
| `sheet-strip` | **56px** | Page left visible above a sheet. An absolute strip, not a `vh` fraction, so it reads the same on a 568px phone and an 844px one |
| `sheet-radius` | **16px**, top corners only | Drawer, modal and confirmation sheets below `narrow` |
| `sheet-padding` | **20px 18px**, plus the safe area on the bottom | Modal and confirmation sheets (the drawer keeps its own `18px 20px` body) |
| `toast-narrow` | **12px** each side, full width | Below `narrow`. It has no width of its own, so `left: 50%` had it shrink-wrapping into half the screen |
| `safe-area` | `calc(<design value> + var(--safe-area-bottom))` | Every bottom-anchored surface |
| Verification matrix | 320×568 · 390×844 · 768×1024 · 1025×768 · 1440×900, plus a coarse-pointer context above 768px | Where responsive assertions run |

**These are literals in `styles.css`, not custom properties.** `@media (max-width: var(--narrow))` is invalid CSS and fails silently, so the query preludes carry the numbers directly — the lock and the stylesheet must therefore be changed together, never one alone.

**Overlays are not exempt from `narrow`.** Phase 1 excluded them; phase 2 does not. Below the
threshold the drawer, all six modal kinds and both confirmation dialogs are presented as
**bottom sheets** — same DOM, restyled, so the dismissal path, focus trap, layer registration
and accessible name stay the same objects at both widths and cannot drift apart. Above the
threshold every one of them renders exactly as before, verified against geometry pinned from
the pre-change tree.

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

**Table thresholds are per table and were measured, not chosen** — see `measurements.md` in the responsive change. They are container widths, not viewport widths: a table cares about the space it actually gets, which is roughly `viewport − 208px sidebar − gutters`.

**Known and intended consequence:** because `table-fit-requests` is 960px, the requests table reflows to cards below roughly a **1220px viewport** — on narrow desktops, not only phones. At 946px of panel that table has a sub-60px column, so the wide layout is genuinely unreadable there. This is the one sanctioned exception to "desktop rendering is unchanged", alongside controls growing to meet `target-base`.

**What the comfort floor does and does not promise.** It is 44px of *height* on every
interactive control, plus 44px of *width* on controls with no text to widen them (the rail
toggle, `.icon-x`, `.drag-handle`, `.drawer-close`). Text controls sitting in a group — a
range segment, a filter chip, an inline "Copy" link — may be 27–41px wide; they clear the
24px AA floor in both axes and widening them would break the group's rhythm for no
accessibility gain. A control MAY meet the floor by an expanded hit area rather than its own
box: the switch keeps its locked 30×17 visual and reaches 44×44 through a `::before`, which
is verified by hit-testing, not by measuring its rectangle. Checkboxes and radios are
excluded — a floor there stretches the control, not its tap area.

**Density is not relitigated by this.** The locked `compact` desktop rhythm stands; `density-narrow` applies only below `narrow`. `target-base` is the sole floor that touches desktop, because an accessibility minimum is not a density preference.

## How agents must use this lock

- **One focal point per screen, one accent.** `#4F5DFF` marks the single most important element; everything else is greyscale plus green/amber/red for semantic status. Never introduce a second emphasis hue; never hardcode accent hexes — use `var(--accent)` and its derivations from `packages/frontend/src/styles.css`.
- **Quality gate before showing any UI:** run `/ss-score` (Claude Code) or `$ss-score` (Codex) on the changed **UI screens and components** — not tests, OpenSpec artifacts, package metadata, or changelogs, where a design score is meaningless. If < 80, apply the fix-first list and re-score (up to ~3 loops) until ≥ 80. Only then present the result, stating the score. For a full screen, run `/ss-build` — it enforces this entire loop.
- **Responsive conformance is a gate failure, not a deduction.** A screen that does not adapt at the locked `narrow` threshold, or a table that does not adapt at its `table-fit`, fails the gate outright regardless of score. The evidence is the **browser assertions** (document does not overflow at every matrix viewport, hit targets meet their floor) — a static file score cannot prove narrow rendering, so it must never be treated as having done so.
- **Stack:** SolidJS + Vite + custom CSS (NOT React/Tailwind — StyleSeed's scaffolding does not apply). Use StyleSeed as rulebook + gate only: express the Snap seed as CSS transitions/keyframes on the tokens in `styles.css`; never import StyleSeed's React `engine/` components, Tailwind classes, or framer-motion. Respect `prefers-reduced-motion` on any non-trivial motion; never animate the payload (numbers, costs, results).
- **Process:** UI feature work still goes through OpenSpec changes (see CLAUDE.md); this lock governs how that UI must look, not whether to build it.
