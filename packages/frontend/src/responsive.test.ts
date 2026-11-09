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
import { DOCK_MIN_WIDTH, DOCK_QUERY, DOCK_WIDTH, PICKER_FIT } from './state/appState';

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
    // The 24px desktop gutter would spend 48px of a 390px viewport; below narrow it is
    // 16px (STYLESEED.md `gutter-narrow`, adopt-design-tokens-v2 task 3.3).
    expect(atRuleBody('@media (max-width: 768px)')).toMatch(/\.rs-page\s*\{\s*padding:\s*16px;/);
  });

  it('reaches the target floors without touching font-size, except 16px input text', () => {
    // Padding/min-height only — a font-size change would move the type scale and every
    // assertion in styles.contrast.test.ts with it. The one exception is the entry fields'
    // 16px text in the comfort context (adopt-design-tokens-v2 task 8.1; DESIGN.md Inputs /
    // Fields), so a mobile browser does not zoom the page on focus: one rule per block,
    // naming only entry fields, at exactly `1rem`.
    const FIELD =
      /^(?:\.input|\.select|\.mp-input|select|textarea|input(?::not\(\[type='(?:checkbox|radio)'\]\))*)$/;
    for (const prelude of ['@media (max-width: 768px)', '@media (pointer: coarse)']) {
      const body = atRuleBody(prelude);
      const rules = [...body.matchAll(/([^{}]+)\{([^{}]*font-size[^{}]*)\}/g)];
      expect(rules, `${prelude}: one font-size rule`).toHaveLength(1);
      const [, selectors = '', decls = ''] = rules[0] ?? [];
      for (const s of selectors.split(',').map((x) => x.trim())) {
        expect(s, `${prelude}: ${s} is an entry field`).toMatch(FIELD);
      }
      expect(decls.trim(), prelude).toMatch(/^font-size:\s*1rem;$/);
    }
    // The lock states the same value (STYLESEED.md `input-text-comfort`), so the two move
    // together.
    const lock = readFileSync(join(SRC, '../../../STYLESEED.md'), 'utf8');
    expect(lock).toMatch(/\| `input-text-comfort` \| \*\*16px\*\* \(`1rem`\) \|/);
  });
});

describe('the subscription picker reads one fit (redesign-subscription-picker D5)', () => {
  // The script constant that decides the narrow focus moves, the `@container` literal that
  // decides the two-step layout, and the lock row: three copies of one measured value.
  it('PICKER_FIT, the container query and the lock row agree', () => {
    const lock = readFileSync(join(SRC, '..', '..', '..', 'STYLESEED.md'), 'utf8');
    const row = /\|\s*`picker-fit`\s*\|\s*\*\*(\d+)px\*\*/.exec(lock);
    expect(Number(row?.[1])).toBe(PICKER_FIT);
    const queries = [...css.matchAll(/@container rs-picker \(width < (\d+)px\)/g)].map((m) =>
      Number(m[1]),
    );
    expect(queries).toEqual([PICKER_FIT]);
  });

  it('keeps the picker geometry that changes at the fit in classes, never inline', () => {
    const src = readFileSync(join(SRC, 'components', 'SubscriptionPicker.tsx'), 'utf8');
    for (const cls of ['rs-picker-body', 'rs-picker-fields', 'sp-list', 'sp-detail']) {
      expect(src, cls).toContain(cls);
    }
    expect(src).not.toMatch(/style="[^"]*grid-template/);
    expect(src).not.toMatch(/style="[^"]*(?:^|;)\s*(?:width|padding):/);
  });
});

describe('the docked inspector reads one dock threshold and one docked width (add-docked-inspector D4)', () => {
  // dashboard-core "The dock threshold leaves the docked list room for its columns": the dock
  // threshold and the docked width are each ONE value, read identically by the stylesheet and
  // by the script that decides the inspector's modality, with a check that fails when any two
  // copies disagree. Four copies of each: the script constant, the media prelude (or the two
  // 480px declarations), and the lock row.
  const lock = readFileSync(join(SRC, '..', '..', '..', 'STYLESEED.md'), 'utf8');
  const lockPx = (token: string): number => {
    const m = new RegExp(`\\|\\s*\`${token}\`\\s*\\|\\s*\\*\\*(\\d+)px\\*\\*`).exec(lock);
    expect(m?.[1], `${token} is missing from the STYLESEED.md lock`).toBeDefined();
    return Number(m?.[1]);
  };

  it('the script reads the same query the stylesheet docks in, at the locked threshold', () => {
    expect(DOCK_QUERY).toBe(`(min-width: ${String(DOCK_MIN_WIDTH)}px)`);
    expect(lockPx('inspector-dock')).toBe(DOCK_MIN_WIDTH);
    // Every min-width media query in the sheet is the dock's, at the constant's value: a second
    // copy of the threshold, or a prelude moved without the constant, fails here.
    const preludes = [...css.matchAll(/@media \(min-width: (\d+)px\)/g)].map((m) => Number(m[1]));
    expect(preludes, 'the dock media prelude').toEqual([DOCK_MIN_WIDTH]);
    // Literal, never a custom property — a var() prelude never matches.
    expect(css).not.toMatch(/@media\s*\([^)]*min-width:\s*var\(/);
  });

  it('both 480px declarations equal the docked width and its lock row, inside the dock prelude only', () => {
    expect(lockPx('inspector-dock-width')).toBe(DOCK_WIDTH);
    const body = atRuleBody(`@media ${DOCK_QUERY}`);
    const pane = /\.rs-docked\s*\{([^}]*)\}/.exec(body)?.[1] ?? '';
    expect(pane, 'the content pane gives up the docked width').toMatch(
      new RegExp(`margin-inline-end:\\s*${String(DOCK_WIDTH)}px;`),
    );
    const panel = /\.rs-inspector-docked\s*\{([^}]*)\}/.exec(body)?.[1] ?? '';
    expect(panel, 'the panel is the docked width').toMatch(
      new RegExp(`(?:^|[;\\s])width:\\s*${String(DOCK_WIDTH)}px;`),
    );
    // No shadow, no entrance, its body contained (design D3, D14), and nothing else that
    // would change the shared drawer's geometry.
    expect(panel).toMatch(/box-shadow:\s*none;/);
    expect(panel).toMatch(/animation:\s*none;/);
    expect(body).toMatch(
      /\.rs-inspector-docked \.drawer-body\s*\{\s*overscroll-behavior-y:\s*contain;/,
    );
    // The look exists ONLY under the prelude, so a stale class can never dock below 1440 — and
    // `.drawer` itself is untouched there, so the tuning drawers stay modal drawers.
    const outside = css.replace(body, '');
    expect(outside, 'a docked rule outside the dock prelude').not.toMatch(
      /\.rs-docked(?![\w-])|\.rs-inspector-docked(?![\w-])/,
    );
    expect(body, 'the dock prelude restyles .drawer itself').not.toMatch(
      /(?:^|[}\s,])\.drawer\s*[{,]/,
    );
  });

  it('the docked compact list’s look lives only inside the dock prelude (D4)', () => {
    // `.rs-docked-list` is the table panel's class while the inspector is docked beside it. The
    // `(?![\w-])` lookahead above deliberately lets `.rs-docked-list` through, so it needs its own
    // guard: every selector that names it is inside the prelude, so a stale class can never
    // compact the list below 1440px.
    const stripComments = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '');
    const body = stripComments(atRuleBody(`@media ${DOCK_QUERY}`));
    const outside = stripComments(css.replace(atRuleBody(`@media ${DOCK_QUERY}`), ''));
    expect(body, 'the dock prelude styles the docked list').toMatch(/\.rs-docked-list/);
    expect(outside, 'a docked-list rule outside the dock prelude').not.toMatch(/\.rs-docked-list/);
    // The status cell's copy of the state marks is inert everywhere else: its one rule outside
    // the prelude is `display: none`, and nothing outside the prelude shows it.
    const marks = [...outside.matchAll(/([^{}]*\.rs-docked-marks[^{}]*)\{([^}]*)\}/g)];
    expect(marks.length, 'the base rule hiding the docked marks').toBeGreaterThan(0);
    for (const m of marks) {
      expect(m[2]!.replace(/\s+/g, ' ').trim(), `${m[1]!.trim()} outside the prelude`).toBe(
        'display: none;',
      );
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
      expect(src, `${f} still sets the page gutter inline`).not.toMatch(
        /class="rs-page"[^>]*style="[^"]*padding/,
      );
      expect(src, `${f} is missing the rs-page container`).toContain('rs-page');
    }
    // The 24px desktop gutter (adopt-design-tokens-v2 task 3.2), outside any query.
    const narrow = atRuleBody('@media (max-width: 768px)');
    expect(css.replace(narrow, '')).toMatch(/\.rs-page\s*\{\s*padding:\s*24px;/);
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
    // The request inspector joined in add-route-trace-inspector (task 4.3): its route trace
    // has to fit a 320px sheet, which leaves its labels 248px (design Risks, "Narrow sheet").
    for (const f of [
      'pages/Routing.tsx',
      'components/BodyCaptureCard.tsx',
      'components/Inspector.tsx',
    ]) {
      const src = read(f);
      const offenders = (src.match(/(?<!max-)(?:min-)?width:\s*(\d{3,})px/g) ?? []).filter((m) => {
        const px = Number(/(\d+)px/.exec(m)?.[1] ?? 0);
        return px >= 100;
      });
      expect(offenders, `${f} still pins a width a phone cannot honour`).toEqual([]);
    }
  });

  it('the request inspector declares no inline grid template (add-route-trace-inspector 4.3)', () => {
    // An inline template would outrank the narrow sheet's layout, the trap the page grids had.
    // A component holds no stylesheet, so any occurrence is inline: a style string, either
    // quote, or a style-object key.
    const src = read('components/Inspector.tsx');
    expect(src, 'Inspector.tsx declares grid-template-columns inline').not.toMatch(
      /grid-template-columns/,
    );
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

  /** Controls that meet the floor by an expanded hit area instead of their own box. The
   * switch's drawn track is the height family's 20 / 18px member (adopt-design-tokens-v2
   * D3), so a `min-height` would restyle it; its `::before` carries the floor, asserted in
   * "grows the switch hit target without resizing the switch" below. */
  const HIT_AREA_FLOORED = new Set(['.toggle']);

  it('gives every interactive control the baseline floor at all widths', () => {
    const base = flooredAt(24);
    const missing = interactiveClasses().filter((c) => !base.has(c) && !HIT_AREA_FLOORED.has(c));
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

  it('gives the inspector’s Previous / Next the comfort target in BOTH axes below narrow and on coarse pointers (add-docked-inspector 4.3)', () => {
    // Icon-only, so the inline axis needs its own floor in each comfort context; the base floor
    // (24px) is covered by the cursor:pointer sweep above. The browser suite measures the boxes.
    const flooredIn = (block: string, prop: 'min-height' | 'min-width'): boolean =>
      [...block.matchAll(/([^{}]+)\{([^}]*)\}/g)].some(
        (m) =>
          (m[1] ?? '').split(',').some((sel) => sel.trim() === '.rs-inspector-step') &&
          new RegExp(`${prop}:\\s*44px`).test(m[2] ?? ''),
      );
    for (const query of ['@media (max-width: 768px)', '@media (pointer: coarse)']) {
      const block = atRuleBody(query);
      expect(flooredIn(block, 'min-height'), `${query}: no 44px height`).toBe(true);
      expect(flooredIn(block, 'min-width'), `${query}: no 44px width`).toBe(true);
    }
    // The fine-pointer desktop box is the height family's small member, in both axes.
    expect(css).toMatch(/\.rs-inspector-step\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px/);
  });

  it('gives the icon-only controls the inline comfort floor on coarse pointers at any width (add-docked-inspector flag F1)', () => {
    // `target-comfort`: 44px in the inline axis for icon-only controls under `pointer: coarse`,
    // not only below `narrow`. The inspector's Close sits beside the 44 x 44 Previous / Next.
    const coarse = atRuleBody('@media (pointer: coarse)');
    const rule = [...coarse.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(
      (m) =>
        /min-width:\s*44px/.test(m[2] ?? '') &&
        (m[1] ?? '').split(',').some((sel) => sel.trim() === '.drawer-close'),
    );
    expect(rule, 'no coarse rule gives .drawer-close a 44px inline floor').toBeDefined();
    const selectors = (rule?.[1] ?? '').split(',').map((sel) => sel.trim());
    for (const cls of ['.drawer-close', '.icon-x', '.drag-handle', '.rs-inspector-step']) {
      expect(selectors, `${cls} missing from the coarse inline floor`).toContain(cls);
    }
    expect(rule?.[2]).toContain('justify-content: center');
  });

  it('grows the switch hit target without resizing the switch', () => {
    // The 36x20 / 32x18 switch is locked design (D3). The floor is met by an invisible centred
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
    for (const name of [
      'rs-requests',
      'rs-batches',
      'rs-agents',
      'rs-users',
      'rs-targets',
      'rs-pipeline',
      'rs-layers',
      'rs-picker',
    ]) {
      expect(css).toContain(`container-name: ${name}`);
    }
  });

  it('states every container threshold once, the same value in the lock as in its query (adopt-design-tokens-v2 task 14.1)', () => {
    // Every `table-fit-*`, `pipeline-fit` and `layers-fit` row of the lock against the literal
    // in its `@container` prelude, both ways: a lock row whose query carries another number,
    // and a query whose number no lock row states, each fail here. The four table rows had no
    // such check before (only Targets, Pipeline and Layers did).
    //
    // add-docked-inspector task 6.2: the Requests and Batches tables have three thresholds each
    // — the one-line fit, the two-line fit, and the shared stack width, written in the range
    // form `(width < 640px)` so a 640px container keeps line one — and all three are read here.
    const lock = readFileSync(join(SRC, '..', '..', '..', 'STYLESEED.md'), 'utf8');
    const ROWS = [
      ['table-fit-requests', 'rs-requests'],
      ['table-fit-requests-2', 'rs-requests'],
      ['table-stack', 'rs-requests'],
      ['table-fit-batches', 'rs-batches'],
      ['table-fit-batches-2', 'rs-batches'],
      ['table-stack', 'rs-batches'],
      ['table-fit-agents', 'rs-agents'],
      ['table-fit-users', 'rs-users'],
      ['table-fit-targets', 'rs-targets'],
      ['pipeline-fit` (two-line)', 'rs-pipeline'],
      ['pipeline-fit` (phone)', 'rs-pipeline'],
      ['layers-fit', 'rs-layers'],
      ['picker-fit', 'rs-picker'],
    ] as const;
    const locked = ROWS.map(([token, container]) => {
      const esc = token.replace(/[()]/g, '\\$&');
      const m = new RegExp(`\\|\\s*\`${esc}\`?\\s*\\|\\s*\\*\\*(\\d+)px\\*\\*`).exec(lock);
      expect(m?.[1], `${token} is missing from the STYLESEED.md lock`).toBeDefined();
      return `${container} ${m?.[1] ?? '?'}`;
    });
    const queried = [
      ...css.matchAll(/@container (rs-[a-z]+) \((?:max-width: |width < )(\d+)px\)/g),
    ].map((m) => `${m[1] ?? ''} ${m[2] ?? ''}`);
    expect([...queried].sort(), 'the @container literals and the lock rows differ').toEqual(
      [...locked].sort(),
    );
  });

  it('stacks the Requests and Batches tables only below the locked stack width, and guards every narrowed form with it (add-docked-inspector 6.2)', () => {
    const lock = readFileSync(join(SRC, '..', '..', '..', 'STYLESEED.md'), 'utf8');
    const stack = Number(/\|\s*`table-stack`\s*\|\s*\*\*(\d+)px\*\*/.exec(lock)?.[1]);
    expect(stack, 'table-stack is missing from the lock').toBe(640);
    for (const name of ['rs-requests', 'rs-batches']) {
      const preludes = [...css.matchAll(new RegExp(`@container ${name} ([^{]+)\\{`, 'g'))].map(
        (m) => (m[1] ?? '').trim(),
      );
      // One-line fit, two-line fit, stack: in that source order (`recordTables.spec.ts` reads
      // the first `max-width` literal as the one-line fit).
      expect(preludes, `${name}: the forms`).toHaveLength(3);
      const [one, two, stacked] = preludes;
      expect(stacked, `${name}: the stacked query`).toBe(`(width < ${String(stack)}px)`);
      for (const narrowed of [one, two]) {
        expect(narrowed, `${name}: a narrowed form is not guarded by the stack width`).toMatch(
          new RegExp(`^\\(max-width: \\d+px\\) and \\(min-width: ${String(stack)}px\\)$`),
        );
      }
      const fit = (p: string | undefined): number =>
        Number(/max-width: (\d+)px/.exec(p ?? '')?.[1]);
      expect(fit(one), `${name}: the one-line fit is not the wider`).toBeGreaterThan(fit(two));
      expect(fit(two), `${name}: the two-line fit is below the stack width`).toBeGreaterThanOrEqual(
        stack,
      );
      // Only the stacked query restyles a row as a block.
      const rowBlock = /\.(?:req-row|rs-batch-row)\s*\{\s*display:\s*block;/;
      const body = (prelude: string): string => atRuleBody(`@container ${name} ${prelude}`);
      expect(body(stacked!), `${name}: the stacked query no longer stacks`).toMatch(rowBlock);
      for (const narrowed of [one, two]) {
        expect(body(narrowed!), `${name}: a narrowed form stacks`).not.toMatch(rowBlock);
      }
    }
  });

  it('describes the one-line fits as fits and only table-stack as the stacking width, in every lock line (add-docked-inspector 7.1)', () => {
    // add-docked-inspector task 7.1 / design D12: `table-fit-requests` and `table-fit-batches`
    // changed meaning, from the width below which the table stacks to its one-line fit. The
    // parity test above holds the numbers; this holds the words, so no lock line — the
    // "Known and intended consequence" paragraph included — still calls 980 or 1000 a
    // stacking width, and that paragraph states the stack bands the locked values produce.
    const lock = readFileSync(join(SRC, '..', '..', '..', 'STYLESEED.md'), 'utf8');
    const row = (token: string): string =>
      new RegExp(`^\\|\\s*\`${token}\`\\s*\\|.*$`, 'm').exec(lock)?.[0] ?? '';
    const px = (token: string): number => Number(/\*\*(\d+)px\*\*/.exec(row(token))?.[1]);
    const fits: number[] = [];
    for (const token of ['table-fit-requests', 'table-fit-batches']) {
      expect(row(token), `${token} is missing from the lock`).not.toBe('');
      expect(row(token), `${token} no longer names the one-line fit`).toMatch(/one-line fit/);
      expect(row(token), `${token} still describes a stacking width`).not.toMatch(/stack|card/i);
      fits.push(px(token));
    }
    expect(fits).toEqual([980, 1000]);
    expect(row('table-stack'), 'table-stack no longer names the stacking width').toMatch(
      /stacked records only below this width/,
    );
    // Sentence by sentence: none about the request or batch table pairs a one-line fit value
    // with stacking. (The Targets and Pipeline paragraphs name a 1000px *viewport* they were
    // read at; they are about neither table.)
    const stale = lock
      .split(/(?<=[.;])\s+|\n/)
      .filter(
        (s) =>
          /request|batch/i.test(s) &&
          /stack|card/i.test(s) &&
          fits.some((v) => new RegExp(`(?<![\\d.])${String(v)}(?!\\d)`).test(s)),
      );
    expect(stale, 'a lock sentence still calls a one-line fit a stacking width').toEqual([]);

    // The consequence paragraph, written from the measured forms (design D12, flag F4): a
    // container is `viewport − 258` above `narrow` (208px sidebar + 2 × 24px gutter + 2px
    // border) and `viewport − 90` at or below it (56px rail + 2 × 16px gutter + 2px border).
    const consequence = /^\*\*Known and intended consequence:\*\*.*$/m.exec(lock)?.[0] ?? '';
    expect(consequence, 'the consequence paragraph is missing').not.toBe('');
    const stack = px('table-stack');
    expect(consequence).toContain('`table-stack`');
    expect(consequence, 'the viewports above narrow that still stack').toContain(
      `769–${String(stack + 258 - 1)}px`,
    );
    expect(consequence, 'the viewports at narrow that do not').toContain(
      `${String(stack + 90)}–768px`,
    );
    expect(consequence, 'the dock threshold').toContain(`**${String(px('inspector-dock'))}px**`);
    // Each one-line fit as a viewport, "roughly" (the old paragraph's word, kept), with its
    // arithmetic: the fit + 258, rounded up to the next 20px.
    for (const [token, fit] of [
      ['table-fit-requests', fits[0] ?? 0],
      ['table-fit-batches', fits[1] ?? 0],
    ] as const) {
      const vw = fit + 258;
      expect(consequence, `${token} as a viewport`).toContain(
        `roughly a **${String(Math.ceil(vw / 20) * 20)}px viewport** (\`${token}\` ${String(fit)} + 258 = ${String(vw)})`,
      );
    }
    expect(consequence, 'the scrollbar caveat').toMatch(
      /leave out scrollbar width[^.]*each bound moves up by that scrollbar's width/,
    );

    // The Overlays paragraph says which surface docks, and that the tuning drawers do not.
    const overlays = /\*\*Overlays are not exempt from `narrow`\.\*\*[\s\S]*?(?=\n\n)/.exec(
      lock,
    )?.[0];
    expect(overlays, 'the Overlays paragraph is missing').toBeDefined();
    const flat = (overlays ?? '').replace(/\s+/g, ' ');
    expect(flat).toMatch(/\*\*Only the Request Inspector docks\*\*/);
    expect(flat).toMatch(/tuning drawers \(self-calibration, semantic learning\) never dock/);
  });

  it('reflows the Targets matrix at its locked table-fit, the same value in the lock and here', () => {
    // redesign-auto-routing-pipeline task 7.2. A literal, like every other threshold, and
    // changed together with STYLESEED.md — never one alone.
    const lock = readFileSync(join(SRC, '..', '..', '..', 'STYLESEED.md'), 'utf8');
    const locked = /\|\s*`table-fit-targets`\s*\|\s*\*\*(\d+)px\*\*/.exec(lock)?.[1];
    expect(locked, 'table-fit-targets is missing from the STYLESEED.md lock').toBeDefined();
    const body = atRuleBody(`@container rs-targets (max-width: ${locked ?? '?'}px)`);
    // The stacked record: the header row goes, the grid becomes a block, and the per-cell
    // field labels — real elements, visually hidden at desktop — are shown.
    expect(body).toMatch(/\.tm-head\s*\{[^}]*display:\s*none/);
    expect(body).toMatch(/\.rs-grid-targets\s*\{[^}]*display:\s*block/);
    // The header row carries BOTH classes, so its `display: none` must come later in the
    // block or the equal-specificity `display: block` keeps it on screen.
    expect(body.search(/\.tm-head\s*\{/)).toBeGreaterThan(body.search(/\.rs-grid-targets\s*\{/));
    expect(body).toMatch(/\.tm-label\s*\{[^}]*position:\s*static/);
    // The picker's cap gives way, so a 220px select cannot push a phone column wider.
    expect(body).toMatch(/\.tm-picker\s*\{[^}]*max-width:\s*min\(220px,\s*100%\)/);
  });

  it('takes the Pipeline and Layers thresholds from the lock, the same values here (split-auto-routing-readout-setup)', () => {
    // Literals, changed together with STYLESEED.md — never one alone.
    const lock = readFileSync(join(SRC, '..', '..', '..', 'STYLESEED.md'), 'utf8');
    const twoLine = /\|\s*`pipeline-fit` \(two-line\)\s*\|\s*\*\*(\d+)px\*\*/.exec(lock)?.[1];
    const phone = /\|\s*`pipeline-fit` \(phone\)\s*\|\s*\*\*(\d+)px\*\*/.exec(lock)?.[1];
    const layers = /\|\s*`layers-fit`\s*\|\s*\*\*(\d+)px\*\*/.exec(lock)?.[1];
    for (const [name, v] of [
      ['pipeline-fit (two-line)', twoLine],
      ['pipeline-fit (phone)', phone],
      ['layers-fit', layers],
    ] as const)
      expect(v, `${name} is missing from the STYLESEED.md lock`).toBeDefined();
    // Two-line: the status leaves line one for line two.
    expect(atRuleBody(`@container rs-pipeline (max-width: ${twoLine ?? '?'}px)`)).toMatch(
      /\.ar-status\s*\{[^}]*grid-row:\s*2/,
    );
    // Phone: three tracks, the column header gone, the field labels shown.
    const phoneBody = atRuleBody(`@container rs-pipeline (max-width: ${phone ?? '?'}px)`);
    expect(phoneBody).toMatch(
      /\.ar-stages\s*\{[^}]*grid-template-columns:\s*18px minmax\(0, 1fr\) 44px/,
    );
    expect(phoneBody).toMatch(/\.ar-colhead\s*\{[^}]*display:\s*none/);
    expect(phoneBody).toMatch(/\.ar-fieldlabel\s*\{[^}]*position:\s*static/);
    expect(atRuleBody(`@container rs-layers (max-width: ${layers ?? '?'}px)`)).toMatch(
      /\.ar-layers\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/,
    );
    // The container is the WRAPPER, never the grid it holds: a query styles only
    // descendants, so a container on `.ar-stages` could never restate its own tracks.
    expect(css).toMatch(/\.ar-pipeline\s*\{[^}]*container-name:\s*rs-pipeline/);
    expect(css).not.toMatch(/\.ar-stages\s*\{[^}]*container-(type|name)/);
    expect(css).toMatch(/\.ar-layers-wrap\s*\{[^}]*container-name:\s*rs-layers/);
  });

  it('holds the Targets grid, its display and the picker cap in classes a query can reach', () => {
    // An inline `display`, `grid-template-columns` or `max-width` outranks the container
    // query, which would then match and change nothing.
    const query = atRuleBody('@container rs-targets');
    const outside = css.replace(query, '');
    expect(outside).toMatch(/\.rs-grid-targets\s*\{[^}]*display:\s*grid[^}]*grid-template-columns/);
    expect(outside).toMatch(/\.tm-picker\s*\{[^}]*max-width:\s*220px/);
    const routing = readFileSync(join(SRC, 'pages/Routing.tsx'), 'utf8');
    expect(routing).toContain('class="rs-targets"');
    // The picker takes the shared select rule (adopt-design-tokens-v2 task 8.1); its cap
    // stays on `.tm-picker`.
    expect(routing).toContain('class="select select--sm tm-picker"');
    expect(routing, 'the picker cap moved back inline').not.toContain('max-width:220px');
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
