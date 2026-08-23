/** Responsive layer regression guards (phase1-responsive-dashboard-layout).
 *
 * WHAT THESE TESTS ARE. `happy-dom` performs no layout, so nothing here can prove a page
 * does not scroll horizontally, that a table is readable, or that a hit target is 44px on
 * screen. These assert the shipped DECLARATIONS in `styles.css` — the same contract
 * `shellLayout.test.tsx` makes. Real layout is proven by the browser suite (tasks 8.x),
 * which measures `scrollWidth`, bounding boxes and hit rectangles at each locked viewport.
 *
 * The values asserted here are LITERALS on purpose. `@media (max-width: var(--narrow))` is
 * invalid CSS and fails silently — the block never matches and nothing errors — so a
 * refactor to a custom property must fail loudly here rather than in production.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(SRC, 'styles.css'), 'utf8');

/** Comments stripped. The responsive block's own comments quote the invalid
 * `max-width: var(...)` form and the word `font-size` as things NOT to write, so asserting
 * against the raw text would fail on the documentation rather than the declarations. */
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');

/** Body of the first at-rule whose prelude matches, with balanced-brace scanning —
 * a naive `indexOf('}')` would stop at the first nested rule's closing brace. */
function atRuleBody(prelude: string): string {
  const start = css.indexOf(prelude);
  if (start < 0) throw new Error(`at-rule not found: ${prelude}`);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced at-rule: ${prelude}`);
}

describe('responsive query layer', () => {
  it('declares the narrow breakpoint as a literal, not a custom property', () => {
    // The locked value (STYLESEED.md § Responsive). A var() here would never match.
    expect(css).toContain('@media (max-width: 768px)');
    expect(css).not.toMatch(/@media\s*\([^)]*max-width:\s*var\(/);
    expect(css).not.toMatch(/@container[^{]*\([^)]*max-width:\s*var\(/);
  });

  it('gives coarse pointers the comfort target at any width', () => {
    // A 1024px tablet is touch-first but nowhere near the narrow threshold.
    const body = atRuleBody('@media (pointer: coarse)');
    expect(body).toContain('min-height: 44px');
  });

  it('applies the baseline target floor outside any media query', () => {
    // 24px (WCAG 2.5.8 AA) holds at EVERY width — it is the one floor that touches
    // desktop, because an accessibility minimum is not a density preference.
    const narrow = atRuleBody('@media (max-width: 768px)');
    const coarse = atRuleBody('@media (pointer: coarse)');
    const outside = css.replace(narrow, '').replace(coarse, '');
    expect(outside).toContain('min-height: 24px');
  });

  it('wraps implicit flex rows and reflows page grids below narrow', () => {
    const body = atRuleBody('@media (max-width: 768px)');
    expect(body).toContain('.rs-wrap');
    expect(body).toContain('flex-wrap: wrap');
    for (const cls of ['.rs-grid-2', '.rs-grid-3', '.rs-grid-4', '.rs-grid-label']) {
      expect(body, `${cls} missing from the narrow block`).toContain(cls);
    }
  });

  it('shrinks the page gutter below narrow', () => {
    // 22px 26px spends 52px of a 390px viewport.
    expect(atRuleBody('@media (max-width: 768px)')).toContain('padding: 18px 16px');
  });

  it('reaches the target floors without touching font-size', () => {
    // Padding/min-height only — a font-size change would move the type scale and every
    // assertion in styles.contrast.test.ts with it.
    for (const prelude of ['@media (max-width: 768px)', '@media (pointer: coarse)']) {
      expect(atRuleBody(prelude)).not.toMatch(/font-size/);
    }
  });
});

describe('page grids reflow', () => {
  // The 13 in-flow page-grid sites. Modals.tsx is phase 2 and deliberately excluded; the
  // five table sites are driven by GRID constants and are asserted separately (6.8).
  const PAGE_GRID_FILES = [
    'pages/Costs.tsx',
    'pages/Limits.tsx',
    'pages/Setup.tsx',
    'pages/Users.tsx',
    'pages/Routing.tsx',
    'pages/Settings.tsx',
    'pages/Providers.tsx',
    'pages/Overview.tsx',
    'components/BodyCaptureCard.tsx',
  ];
  const sources = PAGE_GRID_FILES.map((f) => [f, readFileSync(join(SRC, f), 'utf8')] as const);

  it('leaves no inline grid-template-columns at a page-grid site', () => {
    // An inline declaration outranks any class, so a survivor here is a site the media
    // query silently cannot reach — the exact failure this change exists to prevent.
    for (const [name, src] of sources) {
      const inline = src.match(/style="[^"]*grid-template-columns:[^"]*"/g) ?? [];
      expect(inline, `${name} still declares grid-template-columns inline`).toEqual([]);
    }
  });

  it('declares every grid class at desktop as well as narrow', () => {
    // Moving the declaration out of the inline style means the class must supply the
    // desktop value too — otherwise the columns vanish above the breakpoint.
    const narrow = atRuleBody('@media (max-width: 768px)');
    const desktop = css.replace(narrow, '');
    for (const cls of [
      '.rs-grid-2',
      '.rs-grid-2-1',
      '.rs-grid-label',
      '.rs-grid-3',
      '.rs-grid-4',
      '.rs-grid-main-side',
    ]) {
      const re = new RegExp(`\\${cls}\\s*\\{[^}]*grid-template-columns`);
      expect(desktop, `${cls} has no desktop template`).toMatch(re);
    }
  });

  it('applies a grid class wherever display:grid is used at a converted site', () => {
    for (const [name, src] of sources) {
      const grids = src.match(/<div[^>]*style="display:grid[^"]*"/g) ?? [];
      for (const g of grids) {
        expect(g, `${name}: display:grid without a responsive class -> ${g.slice(0, 90)}`).toMatch(
          /class="[^"]*rs-grid-/,
        );
      }
    }
  });
});

describe('rows, gutters and fixed widths', () => {
  const read = (f: string): string => readFileSync(join(SRC, f), 'utf8');

  it('holds the page gutter in a class, not inline', () => {
    // An inline `padding` on the page container would outrank the narrow override and the
    // media query would silently do nothing — the same trap the grids had.
    for (const f of [
      'pages/Agents.tsx',
      'pages/Overview.tsx',
      'pages/Costs.tsx',
      'pages/Limits.tsx',
      'pages/Providers.tsx',
      'pages/Requests.tsx',
      'pages/Routing.tsx',
      'pages/Settings.tsx',
      'pages/Users.tsx',
    ]) {
      const src = read(f);
      expect(src, `${f} still sets the page gutter inline`).not.toContain('padding:22px 26px');
      expect(src, `${f} is missing the rs-page container`).toContain('rs-page');
    }
    expect(css).toMatch(/\.rs-page\s*\{[^}]*padding:\s*22px 26px/);
  });

  it('wraps the rows that cannot fit a phone', () => {
    expect(read('pages/Requests.tsx')).toMatch(/class="rs-wrap"[^>]*style="display:flex/);
    expect(read('pages/Setup.tsx')).toMatch(/class="rs-wrap"[^>]*style="display:flex/);
    // fix-workload-mix-phone-overflow: these children are individually below the global
    // 100px fixed-width guard, but their minima + gaps + spend compose wider than the
    // 202px card interior. Pin the narrow-only wrapping intent at the actual row.
    expect(read('pages/Routing.tsx')).toMatch(
      /<div\s+class="rs-wrap"\s+data-testid="workload-row"/,
    );
  });

  it('leaves no fixed width or min-width at or above 100px that a phone cannot honour', () => {
    // 100px is the threshold the inventory used; anything at or above it forces overflow
    // on a 390px viewport once the gutter and rail are accounted for.
    for (const f of ['pages/Routing.tsx', 'components/BodyCaptureCard.tsx']) {
      const src = read(f);
      const offenders = (src.match(/(?<!max-)(?:min-)?width:\s*(\d{3,})px/g) ?? []).filter((m) => {
        const px = Number(/(\d+)px/.exec(m)?.[1] ?? 0);
        return px >= 100;
      });
      expect(offenders, `${f} still pins a width a phone cannot honour`).toEqual([]);
    }
  });

  it('leaves the already-fluid widths alone (5.4 — verify, do not change)', () => {
    // These three shipped correct: a fixed width WITH a cap shrinks fine. The inventory's
    // first pass called them work because it never checked for the sibling max-width.
    expect(read('pages/Setup.tsx')).toContain('width:680px;max-width:100%');
    expect(read('pages/Login.tsx')).toContain('width:380px;max-width:92vw');
    expect(read('pages/AcceptInvite.tsx')).toContain('width:380px;max-width:92vw');
  });
});

describe('interactive target floors', () => {
  /** Selectors carrying `min-height: <px>` anywhere in the sheet, by floor value. */
  /** Leading class token of a selector, e.g. `.btn-ghost:hover span` -> `.btn-ghost`. */
  const classToken = (sel: string): string | null => {
    const s = sel.trim();
    if (!s.startsWith('.')) return null;
    return s.split(/[:\s]/)[0] ?? null;
  };

  function flooredAt(px: number): Set<string> {
    const out = new Set<string>();
    const re = new RegExp(`([^{}]+)\\{[^}]*min-height:\\s*${px}px`, 'g');
    for (const m of css.matchAll(re)) {
      for (const sel of (m[1] ?? '').split(',')) {
        const c = classToken(sel);
        if (c !== null) out.add(c);
      }
    }
    return out;
  }

  /** Every class that declares `cursor: pointer` — the app's own signal for "this is an
   * interactive control". Using the codebase's marker rather than a hand-written list is
   * what makes this guard self-maintaining: a NEW control fails it automatically. */
  function interactiveClasses(): string[] {
    const out = new Set<string>();
    for (const m of css.matchAll(/([^{}]+)\{[^}]*cursor:\s*pointer/g)) {
      for (const sel of (m[1] ?? '').split(',')) {
        if (sel.includes(':')) continue; // :hover etc. re-state an already-counted class
        const c = classToken(sel);
        if (c !== null) out.add(c);
      }
    }
    return [...out];
  }

  it('gives every interactive control the baseline floor at all widths', () => {
    const base = flooredAt(24);
    const missing = interactiveClasses().filter((c) => !base.has(c));
    expect(
      missing,
      `these controls declare cursor:pointer but no 24px target floor: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('raises the same controls to the comfort floor below narrow and on coarse pointers', () => {
    const narrow = atRuleBody('@media (max-width: 768px)');
    const coarse = atRuleBody('@media (pointer: coarse)');
    for (const block of [narrow, coarse]) {
      for (const cls of ['.nav-item', '.btn-primary', '.btn-ghost', '.rs-seg']) {
        expect(block, `${cls} missing from a comfort-floor block`).toContain(cls);
      }
      expect(block).toContain('min-height: 44px');
    }
  });

  it('grows the switch hit target without resizing the switch', () => {
    // The 30x17 / 34x19 switch is locked design. The floor is met by an invisible centred
    // ::before, so the target grows and not one drawn pixel moves.
    expect(css).toMatch(/\.toggle::before\s*\{[^}]*position:\s*absolute/);
    expect(atRuleBody('@media (max-width: 768px)')).toContain('.toggle::before');
    // The switch itself must NOT have been given a min-height.
    expect(css).not.toMatch(/\.toggle\s*\{[^}]*min-height/);
  });
});

describe('table query containers', () => {
  it('declares inline-size containers with distinct names', () => {
    expect(css).toContain('container-type: inline-size');
    for (const name of ['rs-requests', 'rs-agents', 'rs-users']) {
      expect(css).toContain(`container-name: ${name}`);
    }
  });

  it('never establishes a query container on a shell pane', () => {
    // A shell pane is bound by dashboard-core's scroll-containment contract; establishing
    // containment there would couple this change to that contract.
    expect(css).not.toMatch(/\[data-pane[^{]*\{[^}]*container-type/);
  });

  it('keeps query containers off the classes that wrap position:fixed elements', () => {
    // `.mp-panel` and the two BodyCaptureCard overlays are position:fixed and render inline
    // in the page tree. Establishing a query container on an ancestor risks changing what
    // they are positioned against, so containers live on the table panel only — never on a
    // page wrapper. This asserts the container class is not merged into a page-level class.
    for (const cls of ['.rs-page', '.panel:not(.rs-table-panel)']) {
      const re = new RegExp(`\\${cls}[^{]*\\{[^}]*container-type`);
      expect(css).not.toMatch(re);
    }
  });
});
