import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Flat-borders elevation lock (STYLESEED.md / dashboard-core spec): light shadows are
 * whispers (alpha ≤ 0.08) passing through theme tokens; dark renders NO drop shadows;
 * nothing hardcodes a shadow outside the tokens — in CSS or inline TSX styles. */

const SRC = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(SRC, 'styles.css'), 'utf8');

function block(selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `selector ${selector} present`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  return css.slice(open + 1, css.indexOf('}', open));
}

function shadowTokens(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--(shadow[\w-]*):\s*([^;]+);/g)) {
    out[m[1] as string] = (m[2] as string).trim();
  }
  return out;
}

interface LeafRule {
  selector: string;
  body: string;
  /** The enclosing at-rule preludes, e.g. `@media (max-width: 768px)`; empty at top level. */
  context: string;
}

/** Every leaf rule, one entry per selector in its list, with the at-rules it sits in (a
 * brace-depth scan, so a rule inside a media or container query is read as itself, not
 * folded into its prelude). Comments are dropped first. */
function leafRules(source: string): LeafRule[] {
  const src = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: LeafRule[] = [];
  const stack: string[] = [];
  let start = 0;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') {
      const prelude = src.slice(start, i).trim();
      const close = src.indexOf('}', i);
      const nextOpen = src.indexOf('{', i + 1);
      if (prelude.startsWith('@') || (nextOpen !== -1 && nextOpen < close)) {
        stack.push(prelude);
        start = i + 1;
        continue;
      }
      for (const sel of prelude.split(',')) {
        out.push({
          selector: sel.trim().replace(/\s+/g, ' '),
          body: src.slice(i + 1, close),
          context: stack.join(' '),
        });
      }
      i = close;
      start = i + 1;
    } else if (ch === '}') {
      stack.pop();
      start = i + 1;
    }
  }
  return out;
}

/** A selector that marks the Selected state (design.md D8): the current / pressed / expanded /
 * selected ARIA states, or a selected-state class. */
function isSelected(selector: string): boolean {
  return (
    /\[aria-current(?:[=\]])/.test(selector) ||
    /\[aria-(?:pressed|expanded|selected)=['"]?true['"]?\]/.test(selector) ||
    /\.(?:active|selected|is-selected|current)\b(?!-)/.test(selector) ||
    /--(?:selected|active|current)\b/.test(selector)
  );
}

/** Every `box-shadow` value that is neither a theme token nor `none`. A token passes through
 * the whisper cap and the dark theme's `none`; `none` draws nothing, so removing a surface's
 * shadow (the docked inspector, add-docked-inspector 2.2) is not hardcoding one. */
function hardcodedShadows(source: string): string[] {
  return [...source.matchAll(/box-shadow:\s*([^;]+);/g)]
    .map((m) => (m[1] as string).trim())
    .filter((v) => !/^(?:var\(--shadow[\w-]*\)|none)$/.test(v));
}

/** Each selected-state declaration of `box-shadow`, named as `<context> <selector> { … }`. */
function selectedShadows(source: string): string[] {
  return leafRules(source)
    .filter((r) => isSelected(r.selector))
    .flatMap((r) =>
      [...r.body.matchAll(/(?:^|[;\s])box-shadow:\s*([^;]+);/g)].map(
        (m) =>
          `${r.context ? `${r.context} ` : ''}${r.selector} { box-shadow: ${(m[1] as string).trim()} }`,
      ),
    );
}

describe('elevation lock (flat-borders)', () => {
  const rootTokens = shadowTokens(block(':root'));
  const darkTokens = shadowTokens(block("[data-theme='dark']"));

  it('light shadow tokens exist and stay under the 8% whisper cap', () => {
    expect(Object.keys(rootTokens).length).toBeGreaterThanOrEqual(5);
    for (const [name, value] of Object.entries(rootTokens)) {
      const alphas = [...value.matchAll(/rgba?\([^)]*?,\s*([\d.]+)\)/g)].map((m) => Number(m[1]));
      expect(alphas.length, `--${name} declares an rgba alpha`).toBeGreaterThan(0);
      for (const a of alphas) {
        expect(a, `--${name} alpha ${a} ≤ 0.08`).toBeLessThanOrEqual(0.08);
      }
    }
  });

  it('the dark theme overrides EVERY root shadow token with none', () => {
    // Set equality: a new root token without a dark override must fail here.
    expect(Object.keys(darkTokens).sort()).toEqual(Object.keys(rootTokens).sort());
    for (const [name, value] of Object.entries(darkTokens)) {
      expect(value, `dark --${name}`).toBe('none');
    }
  });

  it('class rules never hardcode box-shadow outside the tokens', () => {
    expect(hardcodedShadows(css)).toEqual([]);
  });

  it('self-check: `none` removes a shadow and passes; a literal shadow still fails (add-docked-inspector 2.2)', () => {
    // The docked inspector drops the drawer's whisper shadow with `box-shadow: none`: a removed
    // shadow is not a hardcoded one. Any drawn shadow outside the tokens still fails.
    const probe = `.a { box-shadow: var(--shadow-drawer); }
      .b { box-shadow: none; }
      @media (min-width: 1440px) { .c { box-shadow: none; } }
      .d { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12); }
      .e { box-shadow: inset 0 0 0 1px var(--accent-deep); }
      .f { box-shadow: none, 0 0 4px red; }`;
    expect(hardcodedShadows(probe)).toEqual([
      '0 1px 2px rgba(0, 0, 0, 0.12)',
      'inset 0 0 0 1px var(--accent-deep)',
      'none, 0 0 4px red',
    ]);
  });

  describe('a selected state draws its edge with a border or an outline, never box-shadow (adopt-design-tokens-v2 D8)', () => {
    // Every shadow token is `none` in dark, so an edge drawn with box-shadow vanishes there and
    // the selection rests on its wash alone (1.07–1.16:1). The token check above would pass a
    // selected rule that uses `var(--shadow)`; this one passes no box-shadow at all.
    const offenders = selectedShadows(css);

    it('no rule matching a selected selector sets box-shadow', () => {
      expect(offenders, `selected-state box-shadow: ${offenders.join('; ')}`).toEqual([]);
    });

    it('the selector patterns reach every Selected rule the stylesheet draws (not vacuous)', () => {
      const seen = new Set(
        leafRules(css)
          .filter((r) => isSelected(r.selector))
          .map((r) => r.selector),
      );
      for (const sel of [
        ".nav-item[aria-current='page']",
        ".rs-seg[aria-pressed='true']",
        ".filter-chip[aria-pressed='true']",
        ".kind-card[aria-pressed='true']",
        ".btn-ghost[aria-pressed='true']",
        ".req-row[aria-expanded='true']",
        "[aria-current='step'] > .step-marker:not(.step-marker--done)",
        '.mp-option.active',
      ]) {
        expect(seen, sel).toContain(sel);
      }
    });

    it('self-check: a selected rule with a shadow edge is named, inside an at-rule too', () => {
      const probe = `.a { color: red; }
        .seg[aria-pressed="true"] { box-shadow: inset 0 0 0 1px var(--accent-deep); }
        @media (max-width: 768px) { .row[aria-expanded='true'] { box-shadow: var(--shadow); } }
        .x.selected:hover, .y { box-shadow: none; }
        .menu [aria-selected='true'] { outline: 1px solid red; }`;
      expect(selectedShadows(probe)).toEqual([
        '.seg[aria-pressed="true"] { box-shadow: inset 0 0 0 1px var(--accent-deep) }',
        "@media (max-width: 768px) .row[aria-expanded='true'] { box-shadow: var(--shadow) }",
        '.x.selected:hover { box-shadow: none }',
      ]);
      // Not selected: a pressed-false or collapsed state is not the Selected state.
      expect(isSelected(".seg[aria-pressed='false']")).toBe(false);
      expect(isSelected(".row[aria-expanded='false']")).toBe(false);
      expect(isSelected('.nav-item:hover')).toBe(false);
    });
  });

  it('TSX inline styles never introduce shadows (box-shadow / drop-shadow)', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) return name === 'test' ? [] : walk(full);
        return full.endsWith('.tsx') && !full.endsWith('.test.tsx') ? [full] : [];
      });
    for (const file of walk(SRC)) {
      const source = readFileSync(file, 'utf8');
      expect(source, `${file} has no inline box-shadow`).not.toMatch(/box-shadow/i);
      expect(source, `${file} has no drop-shadow filter`).not.toMatch(/drop-shadow/i);
    }
  });
});
