# Building with the polyrouter design kit

These components are the polyrouter dashboard's real code (its SolidJS app compiled and wrapped for React). They are self-contained: **no provider or wrapper is required** — each block brings its own state, seeded with realistic demo data (models `claude-sonnet-5`, `gpt-5-mini`, `llama-3.3-70b`; agents `openclaw`, `ci-summarizer`, `support-bot`). Interop rules: pass **data props only — never JSX children** to kit components; changing a data prop remounts the block (cheap and correct); callbacks like `onToggle` work with normal React state. Every component also accepts `theme="dark"` (scopes the dark token set to that block) and `height={px}` (fixed host height, content scrolls).

## Styling idiom: CSS custom properties + the app's small class vocabulary
No Tailwind, no CSS-in-JS. Style your own layout glue with inline styles or classes, always through the tokens:

- Surfaces: `--bg` (page), `--panel` (cards), `--hover`, `--chip`; borders `--border` (primary hairline), `--border2` (subtler)
- Text: `--text`, `--text2` (secondary), `--text3` (tertiary), `--faint`
- Accent: `--accent` (#4F5DFF), `--accent-bg` (soft fill), `--accent-deep` (text-on-light) — **the only emphasis hue**
- Status (semantic only, never decorative): `--green`/`--green-bg`, `--amber`/`--amber-bg`, `--red`/`--red-bg`
- Shadows are whispers: `--shadow`, `--shadow-pop`, `--shadow-drawer`, `--shadow-toast`

Reusable classes shipped in the stylesheet: `panel`, `card`, `section-title`, `upper-label`, `stat-label`, `stat-value`, `stat-sub`, `kv-box`, `btn-primary`, `btn-ghost`, `btn-cancel`, `input`, `select`, `field-label`, `chip`, `mono`, `link-accent`, `table-head`, `row-hover`, `nav-item`, `bar-track`/`bar-fill`, `snippet-box`.

Hard rules (the app's design lock): one focal point per screen, marked with the accent — everything else is greyscale + semantic status. Never hardcode `#4F5DFF`; use `var(--accent)`. 1px hairline borders are the separation language (flat design; shadows ≤ 8% alpha). Compact density: 16–18px card padding, 4px spacing grid. Panels radius 10px; nested radius = outer − padding. Type is Geist (UI) and Geist Mono (numbers, ids, code) — both bundled, no external fetches. Motion is quick and decisive (~120–180ms ease-out); respect `prefers-reduced-motion`; never animate data values.

## Where the truth lives
Read `styles.css` and its imports (fonts + the full token/component stylesheet) before inventing any style; read each component's `.prompt.md` for its props and composition. Demo data helpers ship on the namespace: `demoRequestRows(n)`, `demoSpend`, `demoChartData()`, `demoProviders`, `demoAgents`, `demoFakeOptions()` — use them instead of inventing lorem data.

## Idiomatic composition
```jsx
import { Chart, RequestRows, RequestTableHead, demoChartData, demoRequestRows } from '@polyrouter/design-kit';

<div style={{ display: 'grid', gap: 12 }}>
  <div className="panel card">
    <div className="stat-label">Requests · 24h</div>
    <div className="stat-value">641</div>
    <div className="stat-sub">19 fallbacks · 12 errors</div>
  </div>
  <div className="panel card">
    <div className="upper-label" style={{ marginBottom: 10 }}>Traffic</div>
    <Chart data={demoChartData()} height={150} />
  </div>
  <div className="panel" style={{ overflow: 'hidden' }}>
    <RequestTableHead />
    <RequestRows rows={demoRequestRows(6)} />
  </div>
</div>
```
Full screens (`Overview`, `Requests`, `Costs`, `Routing`, `Limits`, `Settings`, `Setup`, `Login`, `Agents`, `Providers`) ship as ready templates — compose new screens from the parts (`Sidebar`, `Topbar`, `Chart`, `BarRows`, `Toggle`, `Toast`, `Inspector`, `Modals`, `RangeSelector`, `HarnessSelect`) in that shell pattern.
