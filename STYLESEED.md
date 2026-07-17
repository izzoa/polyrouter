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

## How agents must use this lock

- **One focal point per screen, one accent.** `#4F5DFF` marks the single most important element; everything else is greyscale plus green/amber/red for semantic status. Never introduce a second emphasis hue; never hardcode accent hexes — use `var(--accent)` and its derivations from `packages/frontend/src/styles.css`.
- **Quality gate before showing any UI:** run `/ss-score` (Claude Code) or `$ss-score` (Codex) on the changed files; if < 80, apply the fix-first list and re-score (up to ~3 loops) until ≥ 80. Only then present the result, stating the score. For a full screen, run `/ss-build` — it enforces this entire loop.
- **Stack:** SolidJS + Vite + custom CSS (NOT React/Tailwind — StyleSeed's scaffolding does not apply). Use StyleSeed as rulebook + gate only: express the Snap seed as CSS transitions/keyframes on the tokens in `styles.css`; never import StyleSeed's React `engine/` components, Tailwind classes, or framer-motion. Respect `prefers-reduced-motion` on any non-trivial motion; never animate the payload (numbers, costs, results).
- **Process:** UI feature work still goes through OpenSpec changes (see CLAUDE.md); this lock governs how that UI must look, not whether to build it.
