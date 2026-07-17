---
'@polyrouter/frontend': minor
---

Bring dashboard elevation to the flat-borders design lock (StyleSeed fix #3). All overlay shadows now pass through theme tokens (`--shadow-pop/-drawer/-toast/-knob`), with light-theme alphas clamped to the ≤8% whisper cap (the modal shipped 18%, the toast 25%, the toggle knob 25%) and geometry unchanged. The dark theme renders no drop shadows at all — every shadow token overrides to `none`, with separation carried by the existing hairline borders or intrinsically high-contrast fills (the inverted toast) — replacing the 35%-alpha shadow that sat on every dark panel. A new elevation test parses the shipped stylesheet and enforces the cap, requires the dark override set to exactly mirror the root token set (a forgotten dark override fails), and scans component sources so no inline `box-shadow`/`drop-shadow` can bypass the tokens.
