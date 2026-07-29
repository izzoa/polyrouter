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

/* ── color-mix(in oklab, …) evaluation ────────────────────────────────────────────
 * `--accent-bg` is a mix, not a hex, so the parser above cannot read it — and the two
 * Costs mix-bar segments (`--accent-bg` beside `--accent`) must be shown to be
 * distinguishable NUMERICALLY, in both themes, rather than by eye
 * (split-subscription-spend). Adjacent tints of one hue are exactly where that fails.
 */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
function hexToRgb(hex: string): [number, number, number] {
  const int = parseInt(hex.replace('#', ''), 16);
  return [((int >> 16) & 0xff) / 255, ((int >> 8) & 0xff) / 255, (int & 0xff) / 255];
}
function rgbToOklab([r, g, b]: [number, number, number]): [number, number, number] {
  const [lr, lg, lb] = [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s2 = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s2,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s2,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s2,
  ];
}
function oklabToHex([L, a, b]: [number, number, number]): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s2 = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s2,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s2,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s2,
  ].map((v) => Math.round(Math.min(1, Math.max(0, linearToSrgb(v))) * 255));
  return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
/** Evaluate `color-mix(in oklab, <a> P%, <b>)` to a hex. */
function mixOklab(aHex: string, pct: number, bHex: string): string {
  const A = rgbToOklab(hexToRgb(aHex));
  const B = rgbToOklab(hexToRgb(bHex));
  const t = pct / 100;
  return oklabToHex([0, 1, 2].map((i) => A[i]! * t + B[i]! * (1 - t)) as [number, number, number]);
}

const TEXT_TOKENS = ['text', 'text2', 'text3'] as const;
const SURFACE_TOKENS = ['bg', 'panel', 'chip'] as const;

describe('the Costs mix-bar accent intensities are numerically distinguishable', () => {
  const themes = {
    light: themeBlock(':root'),
    dark: themeBlock("[data-theme='dark']"),
  };
  themes.dark = { ...themes.light, ...themes.dark };

  // Self-check: if the mix implementation is wrong, every assertion below is worthless.
  // Asserted against the mix's own invariants rather than a recorded constant — the
  // `#eff0ff` fallback in Chart.tsx is a hand-approximation (the true oklab value is
  // #edf2ff), so pinning to it would encode the approximation as ground truth.
  it('round-trips a colour through oklab exactly', () => {
    for (const hex of ['#4f5dff', '#ffffff', '#16171b', '#fafafa']) {
      expect(mixOklab(hex, 100, '#000000')).toBe(hex);
    }
  });
  it('lands exactly on both endpoints of a mix', () => {
    expect(mixOklab('#4f5dff', 100, '#ffffff')).toBe('#4f5dff');
    expect(mixOklab('#4f5dff', 0, '#ffffff')).toBe('#ffffff');
  });

  for (const [themeName, vars] of Object.entries(themes)) {
    it(`${themeName}: --accent-bg and --accent differ enough to read as two segments`, () => {
      const accent = vars['accent'] as string;
      const panel = vars['panel'] as string;
      const tint = mixOklab(accent, 9, panel);
      const r = ratio(tint, accent, `${themeName} accent-bg/accent`);
      // 3:1 is the WCAG floor for a meaningful non-text object. Colour is never the SOLE
      // channel here — each segment also carries a text label and a count — but two
      // adjacent tints of one hue must still be separable at a 10px bar height.
      expect(r, `${themeName} --accent-bg vs --accent = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        3,
      );
    });
  }
});

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
    // The ⋮⋮ drag glyph left this list in fix-tier-chain-drag-reorder: it became a real
    // reorder BUTTON, so it is an interactive control and takes --text3 (≥ 3:1), styled
    // in styles.css. Only the → rule arrow remains decorative here.
    'pages/Routing.tsx': 1, // → rule arrow
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
