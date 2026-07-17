import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** WCAG contrast floors for the shipped theme tokens (dashboard-core spec):
 * meaningful text ≥ 4.5:1 and control tints ≥ 3:1 on every surface they sit on,
 * in both themes — parsed from the real styles.css so tokens can't drift. */

const SRC = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(SRC, 'styles.css'), 'utf8');

function themeBlock(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  expect(start, `selector ${selector} present in styles.css`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    const name = m[1];
    const value = m[2];
    if (name !== undefined && value !== undefined) vars[name] = value.trim();
  }
  return vars;
}

function hexLuminance(hex: string, label: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  expect(m, `${label} is a 6-digit hex (got "${hex}")`).not.toBeNull();
  const int = parseInt((m as RegExpExecArray)[1] as string, 16);
  const chan = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * chan((int >> 16) & 0xff) + 0.7152 * chan((int >> 8) & 0xff) + 0.0722 * chan(int & 0xff)
  );
}

function ratio(fg: string, bg: string, label: string): number {
  const l1 = hexLuminance(fg, label);
  const l2 = hexLuminance(bg, label);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT_TOKENS = ['text', 'text2', 'text3'] as const;
const SURFACE_TOKENS = ['bg', 'panel', 'chip'] as const;

describe('theme token contrast floors', () => {
  const themes = {
    light: themeBlock(':root'),
    dark: themeBlock("[data-theme='dark']"),
  };
  // The dark block only overrides; the light block is the base for anything missing.
  themes.dark = { ...themes.light, ...themes.dark };

  for (const [themeName, vars] of Object.entries(themes)) {
    for (const t of TEXT_TOKENS) {
      for (const s of SURFACE_TOKENS) {
        it(`${themeName}: --${t} on --${s} ≥ 4.5:1`, () => {
          const fg = vars[t];
          const bg = vars[s];
          expect(fg, `--${t} defined in ${themeName}`).toBeDefined();
          expect(bg, `--${s} defined in ${themeName}`).toBeDefined();
          const r = ratio(fg as string, bg as string, `${themeName} --${t}/--${s}`);
          expect(r, `${themeName} --${t} on --${s} = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
    it(`${themeName}: the switch off-track / icon control tint (--text3) ≥ 3:1 on bg+panel`, () => {
      for (const s of ['bg', 'panel'] as const) {
        const r = ratio(vars['text3'] as string, vars[s] as string, `${themeName} control/--${s}`);
        expect(r).toBeGreaterThanOrEqual(3);
      }
    });
  }
});

describe('--faint stays decorative-only in TSX', () => {
  // Pinned allowlist of decorative color:var(--faint) usages (glyphs & legend keys).
  // A new `color: var(--faint)` site fails here until consciously allowlisted —
  // meaningful copy/status must use a contrast-passing token (dashboard-core spec).
  const ALLOWED: Record<string, number> = {
    'components/Topbar.tsx': 1, // ⧉ copy glyph
    'components/Inspector.tsx': 2, // → flow arrows
    'pages/Routing.tsx': 2, // ⋮⋮ drag glyph + → rule arrow
    'pages/Costs.tsx': 1, // ■ legend key for the faint bar segment
  };

  const tsxFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return name === 'test' ? [] : tsxFiles(full);
      return full.endsWith('.tsx') && !full.endsWith('.test.tsx') ? [full] : [];
    });

  it('every color:var(--faint) occurrence is on the decorative allowlist', () => {
    const counts: Record<string, number> = {};
    for (const file of tsxFiles(SRC)) {
      const rel = file.slice(SRC.length + 1);
      const source = readFileSync(file, 'utf8');
      // Both CSS-property usage and JS token reads (e.g. uPlot axis config) count —
      // axis strokes color tick-label TEXT, so --faint may never reach them.
      const matches = source.match(/color:\s*['"]?var\(--faint\)|cssVar\(\s*'--faint'/g);
      if (matches) counts[rel] = matches.length;
    }
    expect(counts).toEqual(ALLOWED);
  });
});
