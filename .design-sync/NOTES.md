# design-sync NOTES — polyrouter

Repo-specific gotchas for the claude.ai/design sync. Target project: "Polyrouter
Design System" (pinned in config.json). Shape: package, via the experimental
Solid→React wrapper package `.design-sync/wrapper/` (@polyrouter/design-kit).

## Architecture (why this repo is unusual)
- The dashboard is **SolidJS**, but claude.ai/design renders React. The synced
  "package" is `.design-sync/wrapper/`: stage 1 compiles the app's real Solid
  sources (components, pages, state, FakeApiClient) with the repo's own
  vite-plugin-solid into `wrapper/solid/design-kit.{mjs,css}` (gitignored);
  stage 2 (tsc) builds thin typed React adapters in `wrapper/src/` → `wrapper/dist/`.
  Each adapter mounts the compiled Solid component into a host div
  (`solid-js/web` render); app-context components get the app's own store backed
  by the repo's own `FakeApiClient` seeded with the demo corpus in
  `wrapper/solid-src/lib.tsx`. **No component is reimplemented.**
- Interop contract: data-prop changes remount the Solid root (depKey =
  JSON.stringify minus functions); function props go through stable trampolines,
  so React `useState` wiring works (proven by Toggle "Interactive" cell).
  JSX children are NOT supported across the boundary (no adapter declares them).

## Build / toolchain
- Node: repo pins 24 (.nvmrc); system node was 22 — builds run with
  `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`.
- Fresh clone: `cd .design-sync/wrapper && npm install && npm run build`
  (buildCmd in config). Stage 1 needs `packages/shared/dist` to exist —
  build the shared package first if missing (`npm run build -w packages/shared`).
- Keep wrapper deps in lockstep with the app: solid-js ^1.9.14, uplot ^1.6.32,
  vite ^8, vite-plugin-solid ^2.11 (mirrors packages/frontend). react 18.3.1
  chosen for _vendor (UMD available).
- playwright for the render check: cached chromium build 1223 →
  **playwright@1.60.0** (installed in .ds-sync/). Newer playwright pins 1228+
  and fails to launch against this cache.

## CSS / fonts
- cssEntry = `solid/design-kit.css` (stage-1 output): the app's full
  `packages/frontend/src/styles.css` (tokens + component classes, light+dark)
  + uPlot's stylesheet, extracted by vite. Ships as _ds_bundle.css.
- The app's `public/fonts/fonts.css` uses absolute `/fonts/...` urls the
  converter can't resolve; `wrapper/assets/fonts.css` is a derived copy with
  relative urls. Regenerate after app font changes:
  `sed "s|url('/fonts/|url('../../../packages/frontend/public/fonts/|g" packages/frontend/public/fonts/fonts.css > .design-sync/wrapper/assets/fonts.css`
- Dark theme: adapters take `theme="dark"` → sets [data-theme] on the host div;
  the app's tokens are attribute-scoped, so it themes per-block.

## Card overrides
- Fixed-position overlays (Inspector, Modals, Toast) → cardMode "single" +
  viewport (multiple cells would stack on one page viewport). Modals 820x620
  fits ALL five kinds incl. the tall Channel/SMTP form — no per-kind viewport.
- The 10 full-page templates (Overview/Requests/Costs/Routing/Settings/Login/
  Setup/Agents/Providers/Limits) → cardMode "single" so each is one full-width
  row in the DS pane instead of cramping in the multi-column grid. Viewports
  tuned to content: dashboards 1180x760, Settings/Login/Setup 1180x680, the
  short config pages 1040×(470/450/380). Presentation-only — grades carry forward.

## Preview authoring gotchas (folded from wave learnings)
- **`height` prop does not cascade** to the mounted Solid component — it only
  sizes the `display:block` host (overflow:auto). It cannot pin a flex footer
  (Sidebar) or stretch a top-aligned page (Setup); with `theme="dark"` the extra
  host height paints as dark dead space. Fixes used in previews: Sidebar dropped
  `height` + clamped to `<div style={{width:208}}>`; Setup dropped `height`;
  Login kept height:640 (its root is height:100vh so it fills). A true pinned
  full-height would need an **adapter change** (flex host / height:100%), not a
  preview edit — noted for a future improvement.
- **position:fixed components need a transformed containing block in the preview.**
  The cfg viewport alone is not enough (Toast anchors to the page viewport and
  clips). Wrap the adapter in a `div` with `transform:translateZ(0)` +
  `position:relative` + fixed height + overflow:hidden. Applies to any future
  toast/tooltip/drawer/overlay. (Candidate harness improvement: establish a
  containing block on the card root for fixed-position adapters.)
- **Dark cells for wrapper-framed components** (Topbar, RequestTableHead): put
  `data-theme="dark"` on the outer frame div AND `theme="dark"` on the adapter,
  and `border:none` on the frame — the frame is outside the adapter's themed
  root, so its own tokens resolve light otherwise.
- **Full-page templates: 720px is the right canonical cell height; compact
  (≤480) cells render partial content + a trailing void** (page paints fewer
  sections at a small host, host still reserves the height). Best 2nd cell for a
  self-loading page is the **dark** variant (same axes, high token coverage),
  not a compact light one.
- **RangeSelector's selected segment uses `--chip` (grey), not the accent** —
  by design; don't grade it against "accent applied".
- **Controlled inputs work through the adapter** (HarnessSelect via useState →
  onChange trampoline in mount.ts); React state interop is proven.
- **`demoRequestRows(n)` is deterministic** — curate exception/free-row slices
  with `.filter` (`r.escalated||r.status!=='success'`; `r.modelId==='m-llama'`)
  rather than hand-building rows. RequestTableHead + RequestRows share the GRID
  template, so compose them in one ~900px panel.

## Known cosmetic (data-layer, not preview-controllable)
- Endpoint chip port is the capture server's dynamic port (127.0.0.1:<port>) —
  differs per mount, harmless.
- Settings "Ops email" channel label renders in a thin weight (can read as
  "Ope email" at low zoom) — populated and plausible.

## Demo corpus
- Lives in `wrapper/solid-src/lib.tsx` (demoProviders/Agents/Models/Tiers/
  Rules/Budgets/Channels/RequestRows/Timeseries/Spend + demoFakeOptions()).
  Exported on window.Polyrouter for previews AND the design agent.
- Price snapshots are rounded (`toFixed(4)`) — an early version printed
  `$0.30000000000000004 / 1M` in the Inspector.

## Known render warns (triaged)
- (pre-authoring only) [RENDER_BLANK] on Chart's floor card — cured by the
  authored preview; should not recur while Chart.tsx preview exists.
- **Modals: `thin` (maxHeight=0) in .render-check.json** — measurement
  artifact, NOT a defect. Modals is a position:fixed overlay; the default grid
  probe measures 0 height because the backdrop escapes normal flow. The real
  cardMode:single card (820x620) renders every kind incl. the full Channel/SMTP
  form (the captured `texts` shows the complete form). Expected; do not chase.

## Re-sync risks
- Stage 1 imports app sources by path (`packages/frontend/src/**`): a component
  file move/rename breaks the wrapper build — update `wrapper/solid-src/lib.tsx`
  imports and the adapter, then full rebuild.
- Adapter props are hand-mirrored from the app's component props; when the app
  changes a component's API, the adapter + its .d.ts must follow (tsc catches
  removed/renamed Solid exports only at stage-1 import level).
- Demo corpus mirrors the API DTO shapes; schema changes (api.ts) can silently
  stale it — pages then show error banners in previews (loud, at least).
- conventions.md class/token names must be re-validated against the fresh
  styles.css on every sync (the base skill's conventions step does this).
