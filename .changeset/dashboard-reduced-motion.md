---
'@polyrouter/frontend': minor
---

Respect the user's reduced-motion preference (StyleSeed/design-lock fix #4). Under `prefers-reduced-motion: reduce`, every dashboard animation and transition — including pseudo-elements, delays, and the inline Live-dot pulse — collapses to an imperceptible single iteration, with all animated states still visible statically (the Live dot rests fully opaque, the inspector drawer appears in place, toggles switch instantly). The orphaned `rowin` keyframe is removed. A motion test enforces the guard block and cross-checks the animation inventory across the stylesheet and inline component styles: every used animation must be a stylesheet-local keyframe (covered by the guard) and every defined keyframe must actually be used.
