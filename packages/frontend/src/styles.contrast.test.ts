import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** WCAG contrast floors for the shipped theme tokens (dashboard-core spec "Dashboard text
 * and control colors meet contrast floors"): meaningful text ≥ 4.5:1, and control
 * boundaries and state indicators ≥ 3:1, on every surface they sit on, in both themes —
 * parsed from the real styles.css so tokens can't drift. Derived (`color-mix`) tokens are
 * EVALUATED, never skipped: --accent-bg, --accent-deep and the primary fills are all mixes,
 * and they are exactly where the old suite had no eyes (adopt-design-tokens-v2). */

const SRC = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(SRC, 'styles.css'), 'utf8');
/** Comments are prose; a `--name: value;` written in one must never read as a token. */
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');

function themeBlock(selector: string): Record<string, string> {
  const start = cssCode.indexOf(selector);
  expect(start, `selector ${selector} present in styles.css`).toBeGreaterThanOrEqual(0);
  const open = cssCode.indexOf('{', start);
  const close = cssCode.indexOf('}', open);
  const body = cssCode.slice(open + 1, close);
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
 * The accent derivations are mixes, not hexes, so a hex-only parser cannot read them. The
 * evaluator below resolves `var()` against the theme's own variables and evaluates
 * `color-mix(in oklab, …)` the way the browser does, so every derived token is held to its
 * floor like any literal one.
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

/** Split a CSS argument list on its top-level commas (a nested `var(a, b)` stays whole). */
function splitArgs(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

type Vars = Record<string, string>;

/** Resolve a CSS color expression — a hex, a `var()` or a `color-mix(in oklab, …)` — to a
 * 6-digit hex, against one theme's variables. Anything else throws, naming the label, so a
 * token rewritten into a form this cannot read fails loudly instead of being skipped. */
function evalColor(expr: string, vars: Vars, label: string, seen: readonly string[] = []): string {
  const e = expr.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(e);
  if (short)
    return `#${short[1]!.repeat(2)}${short[2]!.repeat(2)}${short[3]!.repeat(2)}`.toLowerCase();
  if (/^#[0-9a-f]{6}$/i.test(e)) return e.toLowerCase();
  const ref = /^var\(\s*--([\w-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(e);
  if (ref) {
    const name = ref[1] as string;
    if (seen.includes(name)) throw new Error(`${label}: --${name} refers to itself`);
    const value = vars[name];
    if (value !== undefined) return evalColor(value, vars, label, [...seen, name]);
    if (ref[2] !== undefined) return evalColor(ref[2], vars, label, seen);
    throw new Error(`${label}: --${name} is not defined`);
  }
  const mix = /^color-mix\(\s*in\s+oklab\s*,([\s\S]+)\)$/.exec(e);
  if (mix) {
    const stops = splitArgs(mix[1] as string).map((stop) => {
      const trailing = /^([\s\S]+?)\s+(\d+(?:\.\d+)?)%$/.exec(stop);
      if (trailing) return { color: trailing[1] as string, pct: Number(trailing[2]) };
      const leading = /^(\d+(?:\.\d+)?)%\s+([\s\S]+)$/.exec(stop);
      if (leading) return { color: leading[2] as string, pct: Number(leading[1]) };
      return { color: stop, pct: undefined };
    });
    if (stops.length !== 2) throw new Error(`${label}: color-mix takes two colours ("${e}")`);
    const [a, b] = stops as [(typeof stops)[number], (typeof stops)[number]];
    const pa = a.pct ?? (b.pct === undefined ? 50 : 100 - b.pct);
    const pb = b.pct ?? 100 - pa;
    // Percentages that do not sum to 100 scale alpha; no token here is translucent, so
    // that form is refused rather than evaluated wrongly.
    if (Math.abs(pa + pb - 100) > 1e-9) throw new Error(`${label}: unsupported mix "${e}"`);
    return mixOklab(
      evalColor(a.color, vars, label, seen),
      pa,
      evalColor(b.color, vars, label, seen),
    );
  }
  throw new Error(`${label}: cannot evaluate "${e}"`);
}

/** The light block is `:root`; the dark block only overrides it. `data-theme` is set on
 * the root element itself (App.tsx, appState.ts), so a derivation declared only in
 * `:root` — `--accent-bg: color-mix(…, var(--panel))` — resolves against the DARK panel in
 * dark mode. Evaluating each theme's merged variables lazily reproduces exactly that. */
const LIGHT: Vars = themeBlock(':root');
const THEMES: Record<'light' | 'dark', Vars> = {
  light: LIGHT,
  dark: { ...LIGHT, ...themeBlock("[data-theme='dark']") },
};

/** A token (`accent-deep`) or a literal colour (`#fff`), resolved in one theme. */
function color(vars: Vars, ref: string, label: string): string {
  return evalColor(ref.startsWith('#') ? ref : `var(--${ref})`, vars, label);
}
const named = (ref: string): string => (ref.startsWith('#') ? ref : `--${ref}`);

interface Pair {
  /** The foreground token (text, edge, ring, knob) or a literal such as `#fff`. */
  fg: string;
  /** The surface token it is drawn on or against. */
  bg: string;
  floor: 3 | 4.5;
}

/** Register one `it` per theme per pair. Each title and message names the pair as
 * `--fg/--bg`, so a failure says which token fell below which floor on which surface. */
function floors(pairs: readonly Pair[]): void {
  for (const [themeName, vars] of Object.entries(THEMES)) {
    for (const { fg, bg, floor } of pairs) {
      const pair = `${named(fg)}/${named(bg)}`;
      it(`${themeName}: ${named(fg)} on ${named(bg)} ≥ ${String(floor)}:1`, () => {
        const label = `${themeName} ${pair}`;
        const r = ratio(color(vars, fg, label), color(vars, bg, label), label);
        expect(
          r,
          `${label} = ${r.toFixed(2)}:1, under the ${String(floor)}:1 floor`,
        ).toBeGreaterThanOrEqual(floor);
      });
    }
  }
}
const pairs = (fgs: readonly string[], bgs: readonly string[], floor: 3 | 4.5): Pair[] =>
  fgs.flatMap((fg) => bgs.map((bg) => ({ fg, bg, floor })));

/** A leaf rule's declarations, found by one exact selector in its selector list. */
function ruleBodies(selector: string): string[] {
  const out: string[] = [];
  for (const m of cssCode.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (m[1] ?? '').split(',').map((x) => x.trim().replace(/\s+/g, ' '));
    if (selectors.includes(selector)) out.push(m[2] ?? '');
  }
  return out;
}
function declaration(selector: string, property: string): string {
  const values = ruleBodies(selector).flatMap((body) =>
    [...body.matchAll(new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+);`, 'g'))].map((m) =>
      (m[1] as string).trim(),
    ),
  );
  expect(values, `${selector} declares exactly one ${property}`).toHaveLength(1);
  return values[0] as string;
}
const channelsNear = (hex: string, want: string, tolerance: number): boolean => {
  const a = hexToRgb(hex);
  const b = hexToRgb(want);
  return a.every((v, i) => Math.abs(v - (b[i] as number)) * 255 <= tolerance);
};

const TEXT_TOKENS = ['text', 'text2', 'text3'] as const;
const SURFACE_TOKENS = ['bg', 'panel', 'chip'] as const;

describe('the color-mix evaluator is sound', () => {
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
  it('reads a mix with one, two or no percentages, and a stop given percentage-first', () => {
    const vars: Vars = { a: '#4f5dff', b: '#17181a' };
    const want = mixOklab('#4f5dff', 78, '#17181a');
    expect(evalColor('color-mix(in oklab, var(--a) 78%, var(--b))', vars, 't')).toBe(want);
    expect(evalColor('color-mix(in oklab, var(--a) 78%, var(--b) 22%)', vars, 't')).toBe(want);
    expect(evalColor('color-mix(in oklab, var(--a), 22% var(--b))', vars, 't')).toBe(want);
    expect(evalColor('color-mix(in oklab, var(--a), var(--b))', vars, 't')).toBe(
      mixOklab('#4f5dff', 50, '#17181a'),
    );
  });
  it('refuses what it cannot evaluate rather than skipping it', () => {
    expect(() => evalColor('var(--missing)', {}, 't')).toThrow(/--missing is not defined/);
    expect(() => evalColor('color-mix(in oklab, #000 40%, #fff 40%)', {}, 't')).toThrow(
      /unsupported/,
    );
    expect(() => evalColor('rgb(0 0 0)', {}, 't')).toThrow(/cannot evaluate/);
  });
  it('resolves a root derivation against the dark theme’s own surfaces', () => {
    // A derivation declared once in :root (as --accent-bg is, mixed with var(--panel)) must
    // mix with the DARK panel in dark mode, or every wash pair below is measured on the
    // wrong colour. Shown on a synthetic pair so the check does not encode a token value.
    const root: Vars = {
      surface: '#ffffff',
      wash: 'color-mix(in oklab, #4f5dff 9%, var(--surface))',
    };
    const dark: Vars = { ...root, surface: '#16171b' };
    expect(evalColor('var(--wash)', dark, 't')).toBe(mixOklab('#4f5dff', 9, '#16171b'));
    expect(evalColor('var(--wash)', root, 't')).toBe(mixOklab('#4f5dff', 9, '#ffffff'));
    // And the real dark block does override the surfaces the derivations mix with.
    expect(THEMES.dark['panel']).not.toBe(THEMES.light['panel']);
    expect(THEMES.dark['text']).not.toBe(THEMES.light['text']);
  });
});

describe('the Costs mix-bar accent intensities are numerically distinguishable', () => {
  // The two Costs mix-bar segments (`--accent-bg` beside `--accent`) must be shown to be
  // distinguishable NUMERICALLY, in both themes, rather than by eye
  // (split-subscription-spend). Adjacent tints of one hue are exactly where that fails.
  for (const [themeName, vars] of Object.entries(THEMES)) {
    it(`${themeName}: --accent-bg and --accent differ enough to read as two segments`, () => {
      const label = `${themeName} --accent-bg/--accent`;
      const r = ratio(color(vars, 'accent-bg', label), color(vars, 'accent', label), label);
      // 3:1 is the WCAG floor for a meaningful non-text object. Colour is never the SOLE
      // channel here — each segment also carries a text label and a count — but two
      // adjacent tints of one hue must still be separable at a 10px bar height.
      expect(r, `${label} = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    });
  }
});

describe('theme token contrast floors', () => {
  describe('meaningful text on the neutral surfaces (≥ 4.5:1)', () => {
    floors(pairs(TEXT_TOKENS, SURFACE_TOKENS, 4.5));
  });

  describe('indigo text is the deep derivation, legible on every surface it reaches (≥ 4.5:1)', () => {
    floors(pairs(['accent-deep'], ['bg', 'panel', 'chip', 'hover', 'accent-bg'], 4.5));
  });

  describe('text set on the selected wash (≥ 4.5:1)', () => {
    // Selected text is Ink on the wash (11.3:1 in the requirement's rounding), and the
    // selected request row sets its cell text on the wash. Ink 3 is the thin pair
    // (≈ 4.68 / 4.87:1): a heavier wash mix is what fails first.
    floors(pairs(TEXT_TOKENS, ['accent-bg'], 4.5));
  });

  describe('white on the primary fill at rest, hovered and pressed (≥ 4.5:1)', () => {
    floors(pairs(['#fff'], ['accent', 'accent-fill-hover', 'accent-fill-pressed'], 4.5));
  });

  describe('Control Edge bounds every entry control on every neutral surface (≥ 3:1)', () => {
    // Fields, filter chips and the off switch track draw it (design.md D2). The chip
    // margin is thin (≈ 3.01 / 3.04:1), so any later lightening of --chip fails here.
    floors(pairs(['border-control'], ['bg', 'panel', 'chip', 'hover'], 3));
  });

  describe('the switch: on track vs off track, and the knob vs each track (≥ 3:1)', () => {
    // design.md D3: the on track is Ink (--text), the off track Control Edge, the knob the
    // panel colour. The tracks differ by lightness, not hue (today 1.08:1 light, 1.42:1 dark).
    floors([
      { fg: 'text', bg: 'border-control', floor: 3 },
      { fg: 'panel', bg: 'text', floor: 3 },
      { fg: 'panel', bg: 'border-control', floor: 3 },
    ]);
  });

  describe('the selected edge against the selected wash (≥ 3:1)', () => {
    // The wash alone never carries the state: the 1px --accent-deep edge does.
    floors([{ fg: 'accent-deep', bg: 'accent-bg', floor: 3 }]);
  });

  describe('the invalid edge against the field fill (≥ 3:1)', () => {
    // Fields are filled with --bg (`.input`, `.select`, `.mp-input`).
    floors([{ fg: 'red', bg: 'bg', floor: 3 }]);
  });

  describe("an invalid field's message on the surfaces a form sits on (≥ 4.5:1)", () => {
    // `.field-error` (task 8.2) is red TEXT, so it takes the text variant: a form sits on a
    // panel (the modals, the page cards) or the page background (sign-in's card margin).
    floors(pairs(['red-text'], ['bg', 'panel'], 4.5));
  });

  describe("a notice's title and body on its tone's wash (≥ 4.5:1)", () => {
    // Notices (task 10.1, design.md D15; `.notice--<tone>`): the status-word title is its
    // tone's text colour on its tone's wash, and the body is Ink 2 on every wash. Both are
    // text, so both take the 4.5:1 floor. The tightest pairs are light --green-text on
    // --green-bg (≈ 4.84:1) and dark --red-text on --red-bg (≈ 4.65:1).
    floors([
      { fg: 'text2', bg: 'chip', floor: 4.5 },
      { fg: 'green-text', bg: 'green-bg', floor: 4.5 },
      { fg: 'amber-text', bg: 'amber-bg', floor: 4.5 },
      { fg: 'red-text', bg: 'red-bg', floor: 4.5 },
    ]);
    floors(pairs(['text2'], ['green-bg', 'amber-bg', 'red-bg'], 4.5));
  });

  describe('the focus ring against every surface it can touch (≥ 3:1)', () => {
    // A notice's ghost action draws its ring on its status wash, so the washes count. The
    // tightest pair is dark --amber-bg (≈ 3.07:1).
    floors(
      pairs(
        ['accent'],
        ['bg', 'panel', 'chip', 'hover', 'accent-bg', 'green-bg', 'amber-bg', 'red-bg'],
        3,
      ),
    );
  });
});

describe('the primary button draws its fills from the derivations, darkening in both themes', () => {
  // adopt-design-tokens-v2 D1. The token floors above only hold if the button actually uses
  // those tokens, so the rules are read too — a hover pointed back at --accent-deep (which
  // mixes toward --text and so LIGHTENS to #6c83ff in dark) fails here. The rules are read
  // inside each `it`, so a missing rule fails as a named test, not as a collection error.
  const primaryFills = (): Record<'rest' | 'hover' | 'pressed', string> => ({
    rest: declaration('.btn-primary', 'background'),
    hover: declaration('.btn-primary:hover', 'background'),
    pressed: declaration('.btn-primary:active', 'background'),
  });

  it('rest, hover and pressed take --accent, --accent-fill-hover and --accent-fill-pressed', () => {
    expect(primaryFills()).toEqual({
      rest: 'var(--accent)',
      hover: 'var(--accent-fill-hover)',
      pressed: 'var(--accent-fill-pressed)',
    });
  });

  for (const [themeName, vars] of Object.entries(THEMES)) {
    it(`${themeName}: hover ≈ #414fc7 and pressed ≈ #3947aa, never the old dark #6c83ff`, () => {
      const fills = primaryFills();
      const hover = evalColor(fills.hover, vars, `${themeName} hover`);
      const pressed = evalColor(fills.pressed, vars, `${themeName} pressed`);
      expect(channelsNear(hover, '#414fc7', 2), `${themeName} hover fill = ${hover}`).toBe(true);
      expect(channelsNear(pressed, '#3947aa', 2), `${themeName} pressed fill = ${pressed}`).toBe(
        true,
      );
      expect(hover).not.toBe('#6c83ff');
    });

    it(`${themeName}: each state is darker than the last, and white clears 4.5:1 on all three`, () => {
      const fills = primaryFills();
      const label = declaration('.btn-primary', 'color');
      const lum = (expr: string, state: string): number =>
        hexLuminance(evalColor(expr, vars, `${themeName} ${state}`), `${themeName} ${state}`);
      expect(lum(fills.hover, 'hover'), `${themeName} hover fill is darker than rest`).toBeLessThan(
        lum(fills.rest, 'rest'),
      );
      expect(
        lum(fills.pressed, 'pressed'),
        `${themeName} pressed fill is darker than hover`,
      ).toBeLessThan(lum(fills.hover, 'hover'));
      const text = evalColor(label, vars, `${themeName} label`);
      for (const [state, fill] of Object.entries(fills)) {
        const pairLabel = `${themeName} ${text}/.btn-primary ${state}`;
        const r = ratio(text, evalColor(fill, vars, pairLabel), pairLabel);
        expect(r, `${pairLabel} = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

describe('the amber ghost’s hover text clears the text floor (interim, adopt-design-tokens-v2 D18)', () => {
  // The --amber FILL read 2.81:1 as hover text on white. Until adopt-red-destructive-actions
  // deletes the class, its hover text takes --amber-text; the rule is read, so pointing it
  // back at the fill fails here.
  for (const [themeName, vars] of Object.entries(THEMES)) {
    it(`${themeName}: .btn-ghost--amber:hover text ≥ 4.5:1 on bg / panel / chip`, () => {
      const text = declaration('.btn-ghost--amber:hover', 'color');
      for (const s of SURFACE_TOKENS) {
        const label = `${themeName} ${text}/--${s}`;
        const r = ratio(evalColor(text, vars, label), color(vars, s, label), label);
        expect(r, `${label} = ${r.toFixed(2)}:1, under the 4.5:1 floor`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    });
  }
});

describe('the lock names every accent derivation styles.css defines (STYLESEED.md L9)', () => {
  // STYLESEED.md and styles.css change together, never one alone: the Key color line lists
  // the derivations agents may use, so a derivation added to (or dropped from) one side
  // alone fails here.
  const lock = readFileSync(join(SRC, '..', '..', '..', 'STYLESEED.md'), 'utf8');
  const keyLine = lock.split('\n').find((line) => line.startsWith('- Key color (accent):')) ?? '';

  it('the Key color line is present', () => {
    expect(keyLine, 'STYLESEED.md lost its "- Key color (accent):" line').not.toBe('');
  });
  it('lists exactly the --accent-* derivations of var(--accent) in :root', () => {
    const defined = Object.entries(LIGHT)
      .filter(([name, value]) => name.startsWith('accent-') && /var\(--accent\)/.test(value))
      .map(([name]) => `--${name}`)
      .sort();
    const locked = [...new Set(keyLine.match(/--accent-[\w-]+/g) ?? [])].sort();
    expect(defined).toEqual(
      expect.arrayContaining(['--accent-fill-hover', '--accent-fill-pressed']),
    );
    expect(locked).toEqual(defined);
  });
});

describe('the lock states the Indigo Budget the accent guard enforces (STYLESEED.md, task 7.4)', () => {
  // STYLESEED.md and styles.css change together (D17): the lock's focal-point rule is the
  // prose of the guard below and of browser/indigoBudget.spec.ts, so it must say what they hold
  // — one filled control plus one series per view, with state marks unbudgeted — and no longer
  // the single-element rule they replaced.
  const lock = readFileSync(join(SRC, '..', '..', '..', 'STYLESEED.md'), 'utf8');
  const rule =
    lock.split('\n').find((line) => line.startsWith('- **One focal point per screen')) ?? '';

  it('the focal-point rule is present', () => {
    expect(rule, 'STYLESEED.md lost its "One focal point per screen" rule').not.toBe('');
  });
  it('states one filled control plus one series per view, with state marks unbudgeted', () => {
    expect(rule).toMatch(/Indigo Budget/);
    expect(rule).toMatch(/Each view\b/);
    expect(rule).toMatch(/one indigo-filled control/);
    expect(rule).toMatch(/one indigo data series/);
    expect(rule).toMatch(/State marks are unbudgeted/);
    // The marks the stylesheet allowlist admits as state marks, and the identity site.
    for (const mark of ['focus ring', 'caret', '`accent-color`', '--accent-deep', 'Selected state'])
      expect(rule, mark).toContain(mark);
    expect(rule).toMatch(/brand mark's lit route/);
    expect(rule).not.toMatch(/marks the single most important element/);
  });
  it('names the two checks that hold it', () => {
    expect(rule).toContain('styles.contrast.test.ts');
    expect(rule).toContain('browser/indigoBudget.spec.ts');
  });
});

describe('the unavailable switch is drawn in a 3:1 token', () => {
  // split-auto-routing-readout-setup D7: the dashed border and the knob of an unavailable
  // switch carry its shape, so they take --text3, which the floors above hold at >= 3:1
  // on bg and panel in both themes. A cheaper token here would fail silently.
  const rule = (selector: string): string => {
    const start = css.indexOf(`${selector} {`);
    expect(start, `${selector} present in styles.css`).toBeGreaterThanOrEqual(0);
    return css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  };
  it('the track is transparent with a dashed --text3 border', () => {
    const body = rule('.toggle--unavailable');
    expect(body).toMatch(/background:\s*transparent/);
    expect(body).toMatch(/border:\s*1px dashed var\(--text3\)/);
  });
  it('the knob is --text3', () => {
    expect(rule('.toggle--unavailable .toggle-knob')).toMatch(/background:\s*var\(--text3\)/);
  });
});

describe('the switch draws the D3 tokens, so the pairs above are the pairs it renders', () => {
  // adopt-design-tokens-v2 task 5.1 / design.md D3. The switch pairs above are token-level;
  // they only hold if the rules use those tokens. Read inside each `it`, so a missing rule
  // fails as a named test.
  it('on is Ink, off is Control Edge, and the knob is the panel colour', () => {
    expect(declaration('.toggle--on', 'background')).toBe('var(--text)');
    expect(declaration('.toggle--off', 'background')).toBe('var(--border-control)');
    expect(declaration('.toggle-knob', 'background')).toBe('var(--panel)');
  });

  it('no .toggle rule references the accent (a switch is never indigo)', () => {
    const offenders: string[] = [];
    for (const m of cssCode.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = (m[1] ?? '').split(',').map((x) => x.trim().replace(/\s+/g, ' '));
      if (!selectors.some((sel) => /\.toggle/.test(sel))) continue;
      for (const d of (m[2] ?? '').matchAll(/([\w-]+):\s*([^;]+);/g)) {
        if (/var\(--accent\b/.test(d[2] ?? ''))
          offenders.push(`${selectors.join(', ')} { ${d[0]} }`);
      }
    }
    expect(offenders, `switch rules drawing indigo: ${offenders.join(' | ')}`).toEqual([]);
  });

  it('Toggle.tsx draws nothing inline, so these rules are the whole presentation', () => {
    const toggle = readFileSync(join(SRC, 'components/Toggle.tsx'), 'utf8');
    expect(toggle).not.toMatch(/style=/);
    expect(toggle).not.toMatch(/var\(--accent\b/);
  });
});

/* ── The Indigo Budget: where the raw accent may appear (adopt-design-tokens-v2 task 7.1) ──
 * design.md D11, dashboard-core "Indigo is spent by a per-view budget". This generalises the
 * old "Auto routing tab spends its accent on one element" check to the whole stylesheet and
 * every component. The RAW accent is `var(--accent)` itself; its derivations (`--accent-deep`
 * text and edges, the `--accent-bg` wash, the `--accent-fill-*` tones) are state marks and are
 * not budgeted. A use of the raw accent is allowed only where it is named below, by kind:
 *
 * - the stylesheet: the primary fill, the focus ring, a focused field's edge, the caret,
 *   `accent-color`, and the focal-series classes — each by selector AND property, so an
 *   allowed selector cannot quietly grow a second indigo property;
 * - components (inline styles, read through the TypeScript AST, so a comment never counts and
 *   a site is placed by the element it sits in, not by its line): the Costs request mix and
 *   its legend square, inside the element marked `data-measure="request-mix"`; the brand
 *   mark's lit route, inside the `<svg data-brand-mark>`; and Chart.tsx's series 0, read
 *   through `cssVar('--accent', …)` only while `accentFirst()` holds. `BarRows` is not a site.
 *
 * The rendered half — at most one filled control and one focal measure per view, and no other
 * element computing the raw accent — is `browser/indigoBudget.spec.ts`. */

/** `var(--accent)` itself, never a derivation (`--accent-deep`, `--accent-bg`, …). */
const RAW_ACCENT = /var\(\s*--accent\s*[,)]/;

interface AccentRule {
  kind: 'primary fill' | 'focus ring' | 'input focus' | 'caret' | 'accent-color' | 'focal series';
  why: string;
  /** A selector, matched exactly, or a pattern every allowed selector matches. */
  selector: string | RegExp;
  props: readonly string[];
}
const ACCENT_RULES: readonly AccentRule[] = [
  {
    kind: 'primary fill',
    why: "the view's one indigo-filled control",
    selector: '.btn-primary',
    props: ['background', 'background-color'],
  },
  {
    kind: 'focus ring',
    why: 'the focus ring, a state mark (D8)',
    selector: /:focus-visible$/,
    props: ['outline', 'outline-color'],
  },
  {
    kind: 'input focus',
    why: "a focused field's edge, a state mark",
    selector: /^(?:input|select|textarea):focus$/,
    props: ['border-color'],
  },
  { kind: 'caret', why: 'the caret, a state mark', selector: /^/, props: ['caret-color'] },
  {
    kind: 'accent-color',
    why: 'a checked native checkbox or radio, a state mark',
    selector: /^/,
    props: ['accent-color'],
  },
  {
    kind: 'focal series',
    why: "the Pipeline bars, the Auto routing section's one indigo series",
    selector: '.ar-bar-fill',
    props: ['background'],
  },
  {
    kind: 'focal series',
    why: "each batch's progress fill, the Batches page's one indigo series",
    selector: '.rs-batch-bar > span',
    props: ['background'],
  },
];
/** The derivations `:root` may build from the raw accent. A custom property anywhere else that
 * carries it would launder the accent past the selector check. */
const ACCENT_DERIVATIONS = ['accent-bg', 'accent-deep', 'accent-fill-hover', 'accent-fill-pressed'];

interface AccentLeaf {
  selector: string;
  body: string;
  context: string;
}
/** Leaf rules with their at-rule context: a brace-depth scan, so a rule inside a media or
 * container query is read as itself (the `[^}]*` pattern the old check used attributed it to
 * the at-rule's prelude). */
function accentLeaves(source: string): AccentLeaf[] {
  const src = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: AccentLeaf[] = [];
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
      for (const sel of prelude.split(','))
        out.push({
          selector: sel.trim().replace(/\s+/g, ' '),
          body: src.slice(i + 1, close),
          context: stack.join(' '),
        });
      i = close;
      start = i + 1;
    } else if (ch === '}') {
      stack.pop();
      start = i + 1;
    }
  }
  return out;
}

/** Every stylesheet use of the raw accent that no rule allows, named by selector and
 * declaration; and the selector rules that allowed something. */
function stylesheetAccent(source: string): { offenders: string[]; used: Set<AccentRule> } {
  const offenders: string[] = [];
  const used = new Set<AccentRule>();
  for (const leaf of accentLeaves(source)) {
    for (const m of leaf.body.matchAll(/(?:^|;)\s*([-\w]+)\s*:\s*([^;]+)/g)) {
      const prop = (m[1] as string).trim();
      const value = (m[2] as string).trim();
      if (!RAW_ACCENT.test(value)) continue;
      const where = `${leaf.context ? `${leaf.context} ` : ''}${leaf.selector} { ${prop}: ${value} }`;
      if (prop.startsWith('--')) {
        if (leaf.selector !== ':root' || !ACCENT_DERIVATIONS.includes(prop.slice(2)))
          offenders.push(
            `${where} — a custom property carries the raw accent only as a :root derivation`,
          );
        continue;
      }
      const rule = ACCENT_RULES.find(
        (r) =>
          r.props.includes(prop) &&
          (typeof r.selector === 'string'
            ? r.selector === leaf.selector
            : r.selector.test(leaf.selector)),
      );
      if (rule) used.add(rule);
      else offenders.push(`${where} — not an allowlisted accent use`);
    }
  }
  return { offenders, used };
}

interface InlineSite {
  kind: 'series' | 'chart' | 'identity';
  why: string;
  file: string;
  /** Exactly this many uses at this site, so a stale or a doubled site fails too. */
  count: number;
  /** Whether one use sits at this site. */
  holds: (hit: InlineHit) => boolean;
}
interface InlineHit {
  file: string;
  line: number;
  text: string;
  /** `var` for a `var(--accent)` in a string; `name` for a bare `'--accent'` (a `cssVar` read
   * or any other property lookup). */
  form: 'var' | 'name';
  /** The data-* markers on the JSX elements enclosing the use, innermost first. */
  marks: Record<string, string>[];
  /** The condition text of each conditional expression whose TRUE branch holds the use. */
  whenTrue: string[];
  /** The callee, when the use is a call's argument. */
  callee: string | null;
}

const inBrandMark = (h: InlineHit): boolean =>
  h.form === 'var' && h.marks.some((m) => 'data-brand-mark' in m);
const inFocalMeasure =
  (measure: string) =>
  (h: InlineHit): boolean =>
    h.form === 'var' &&
    h.marks.some((m) => m['data-series'] === 'focal' && m['data-measure'] === measure);

const INLINE_SITES: readonly InlineSite[] = [
  {
    kind: 'series',
    why: 'the Costs request mix: its other-priced segment and its legend square',
    file: 'pages/Costs.tsx',
    count: 2,
    holds: inFocalMeasure('request-mix'),
  },
  {
    kind: 'chart',
    why: "Chart.tsx's series 0, stroke and fill, only while accentFirst() holds",
    file: 'components/Chart.tsx',
    count: 2,
    holds: (h) =>
      h.form === 'name' && h.callee === 'cssVar' && h.whenTrue.includes('accentFirst()'),
  },
  ...['components/Sidebar.tsx', 'pages/Login.tsx', 'pages/AcceptInvite.tsx'].map(
    (file): InlineSite => ({
      kind: 'identity',
      why: "the brand mark's lit route: one node and its edge",
      file,
      count: 2,
      holds: inBrandMark,
    }),
  ),
];

/** Every raw-accent use in one component, read from its AST. */
function inlineAccentHits(file: string, source: string): InlineHit[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: InlineHit[] = [];
  const marksOf = (node: ts.Node): Record<string, string>[] => {
    const out: Record<string, string>[] = [];
    for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
      const attrs = ts.isJsxElement(n)
        ? n.openingElement.attributes
        : ts.isJsxSelfClosingElement(n)
          ? n.attributes
          : null;
      if (attrs === null) continue;
      const marks: Record<string, string> = {};
      for (const a of attrs.properties) {
        if (!ts.isJsxAttribute(a)) continue;
        const name = a.name.getText(sf);
        if (!name.startsWith('data-')) continue;
        marks[name] = a.initializer && ts.isStringLiteral(a.initializer) ? a.initializer.text : '';
      }
      out.push(marks);
    }
    return out;
  };
  const whenTrueOf = (node: ts.Node): string[] => {
    const out: string[] = [];
    for (let n: ts.Node = node; n.parent; n = n.parent) {
      const p = n.parent;
      if (ts.isConditionalExpression(p) && p.whenTrue === n) out.push(p.condition.getText(sf));
    }
    return out;
  };
  const visit = (node: ts.Node): void => {
    const isText =
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node);
    if (isText) {
      const raw = node.getText(sf);
      const value = ts.isStringLiteralLike(node) ? node.text : raw;
      const form: InlineHit['form'] | null = RAW_ACCENT.test(raw)
        ? 'var'
        : value === '--accent'
          ? 'name'
          : null;
      if (form !== null) {
        const call = ts.isCallExpression(node.parent) ? node.parent : null;
        hits.push({
          file,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          text: raw,
          form,
          marks: marksOf(node),
          whenTrue: whenTrueOf(call ?? node),
          callee: call ? call.expression.getText(sf) : null,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/** Every component source (not tests, not the test helpers). */
const componentFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'test' ? [] : componentFiles(full);
    return /\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full) ? [full] : [];
  });

/** Every inline use no site allows, by file and line; and every site whose count is off. */
function inlineAccent(sources: readonly (readonly [string, string])[]): {
  offenders: string[];
  stale: string[];
} {
  const offenders: string[] = [];
  const found = new Map<InlineSite, number>();
  for (const [file, src] of sources) {
    for (const h of inlineAccentHits(file, src)) {
      const site = INLINE_SITES.find((s) => s.file === file && s.holds(h));
      if (site) found.set(site, (found.get(site) ?? 0) + 1);
      else
        offenders.push(
          `${file}:${String(h.line)} ${h.text} — not an allowlisted accent site (series, chart or identity)`,
        );
    }
  }
  const stale = INLINE_SITES.filter((s) => (found.get(s) ?? 0) !== s.count).map(
    (s) =>
      `${s.file} (${s.kind}: ${s.why}) expects ${String(s.count)} uses, found ${String(found.get(s) ?? 0)}`,
  );
  return { offenders, stale };
}

describe('the Indigo Budget: the raw accent appears only on allowlisted sites (task 7.1, design.md D11)', () => {
  it('every stylesheet use of the raw accent is an allowlisted selector and property', () => {
    const { offenders } = stylesheetAccent(css);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('every named stylesheet site is still in use (a stale entry is a hole)', () => {
    const { used } = stylesheetAccent(css);
    const named = ACCENT_RULES.filter((r) => typeof r.selector === 'string');
    expect(named.filter((r) => !used.has(r)).map((r) => r.selector)).toEqual([]);
  });

  it('every inline raw-accent use sits on an allowlisted site, and each site has its count', () => {
    const sources = componentFiles(SRC).map(
      (f) => [f.slice(SRC.length + 1), readFileSync(f, 'utf8')] as const,
    );
    expect(sources.length, 'the guard reads the components').toBeGreaterThan(30);
    const { offenders, stale } = inlineAccent(sources);
    expect(offenders, offenders.join('\n')).toEqual([]);
    expect(stale, stale.join('\n')).toEqual([]);
  });

  it("the Auto routing section's band chart is drawn neutral (its one series is the Pipeline)", () => {
    const routing = readFileSync(join(SRC, 'pages/Routing.tsx'), 'utf8');
    const chart = /<Chart[\s\S]*?\/>/.exec(routing)?.[0] ?? '';
    expect(chart).toContain('accentFirst={false}');
  });

  describe('self-checks: the guard reads what it guards', () => {
    it('names a stylesheet use inside a media query, by selector and declaration', () => {
      const probe = `.btn-primary { background: var(--accent); color: var(--accent); }
        @media (max-width: 768px) { .chip { border-color: var(--accent); } }
        .x:focus-visible { outline: 2px solid var(--accent); background: var(--accent); }
        .y { color: var(--accent-deep); background: var(--accent-bg); }
        .z { --tint: var(--accent); }
        :root { --accent-bg: color-mix(in oklab, var(--accent) 9%, var(--panel)); }`;
      expect(stylesheetAccent(probe).offenders).toEqual([
        '.btn-primary { color: var(--accent) } — not an allowlisted accent use',
        '@media (max-width: 768px) .chip { border-color: var(--accent) } — not an allowlisted accent use',
        '.x:focus-visible { background: var(--accent) } — not an allowlisted accent use',
        '.z { --tint: var(--accent) } — a custom property carries the raw accent only as a :root derivation',
      ]);
    });

    it('places an inline use by the element it sits in, and ignores comments', () => {
      const probe = `export function A() {
  // style="color:var(--accent)" in a comment is prose
  return (
    <div>
      <div data-series="focal" data-measure="request-mix">
        <span style={{ background: 'var(--accent)' }} />
      </div>
      <span style="color:var(--accent)" />
      <svg data-brand-mark><circle fill="var(--accent)" /></svg>
      <svg><circle fill="var(--accent)" /></svg>
    </div>
  );
}`;
      const hits = inlineAccentHits('pages/Costs.tsx', probe);
      expect(hits.map((h) => h.line)).toEqual([6, 8, 9, 10]);
      expect(hits.map((h) => inFocalMeasure('request-mix')(h))).toEqual([
        true,
        false,
        false,
        false,
      ]);
      expect(hits.map((h) => inBrandMark(h))).toEqual([false, false, true, false]);
    });

    it('reads a cssVar("--accent") and whether accentFirst() guards it', () => {
      const probe = `const a = accentFirst() ? cssVar('--accent', '#4f5dff') : cssVar('--text', '#000');
const b = cssVar("--accent", '#4f5dff');
const c = getComputedStyle(el).getPropertyValue('--accent');`;
      const hits = inlineAccentHits('components/Chart.tsx', probe);
      expect(hits.map((h) => [h.line, h.form, h.callee, h.whenTrue])).toEqual([
        [1, 'name', 'cssVar', ['accentFirst()']],
        [2, 'name', 'cssVar', []],
        [3, 'name', 'getComputedStyle(el).getPropertyValue', []],
      ]);
      const chart = INLINE_SITES.find((s) => s.kind === 'chart');
      expect(hits.map((h) => chart?.holds(h))).toEqual([true, false, false]);
    });
  });
});

describe('--faint stays decorative-only in TSX', () => {
  // Pinned allowlist of decorative color:var(--faint) usages (glyphs & legend keys).
  // A new `color: var(--faint)` site fails here until consciously allowlisted —
  // meaningful copy/status must use a contrast-passing token (dashboard-core spec).
  const ALLOWED: Record<string, number> = {
    // The copy glyph left this list in adopt-design-tokens-v2: it carries meaning, so it
    // takes --text3 like the chevrons and close glyphs (dashboard-core contrast floors).
    'components/Inspector.tsx': 2, // flow arrows between chips
    // The ⋮⋮ drag glyph left this list in fix-tier-chain-drag-reorder: it became a real
    // reorder BUTTON, so it is an interactive control and takes --text3 (≥ 3:1), styled
    // in styles.css. Only the flow arrow remains decorative here.
    'pages/Routing.tsx': 1, // rule arrow
    // Costs left this list in replace-fallback-symbol-glyphs: the ■ legend key was a text
    // GLYPH taking a text colour, and is now a styled element taking `background`. It is
    // still decorative — it just no longer colours any text, so nothing here can regress.
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

/* ── Status words are set in the -text tokens, never in the fills ─────────────────────────────
 * dashboard-core "Dashboard text and control colors meet contrast floors": status words and
 * every other meaningful text clear 4.5:1 in BOTH themes. The status FILLS (`--red`, `--amber`,
 * `--green`) are for dots, bars, borders and chip fills; as light-theme text they read 3.75–
 * 3.91:1 (red) and 2.54–2.81:1 (amber) on the canvas, a panel and their own wash. Text takes
 * `--red-text` / `--amber-text` / `--green-text`, whose pairs are held above. The token pairs
 * cannot see WHICH token a site uses, so this guard reads the sites (adopt-design-tokens-v2
 * review fix; notes/flags.md F12 item 5, option a):
 *
 * - the stylesheet: no `color` declaration takes a fill, and no custom property launders one;
 * - components, through the TypeScript AST (a comment never counts): a fill in a `color`
 *   declaration — an inline `style` string, a style-object key, either branch of a ternary
 *   under one — fails. A fill under any other property (`background`, `border-*`, `fill`,
 *   `stroke`) is an edge or a fill and passes. A fill held in a map or a helper (a status dot's
 *   colour by status) is followed to every place that names the map or helper, and each of
 *   those must be a non-text property too, so a dot helper cannot later colour a label. */
const STATUS_FILL = /var\(\s*--(?:red|amber|green)\s*[,)]/;
/** A bare fill NAME, the form a `cssVar('--red', …)` canvas read would take. */
const STATUS_FILL_NAME = /^--(?:red|amber|green)$/;
/** Properties that draw text in a fill's colour. Every other property is an edge or a fill. */
const TEXT_PROPS = new Set(['color', '-webkit-text-fill-color']);

function stylesheetStatusText(source: string): string[] {
  const out: string[] = [];
  for (const leaf of accentLeaves(source)) {
    for (const m of leaf.body.matchAll(/(?:^|;)\s*([-\w]+)\s*:\s*([^;]+)/g)) {
      const prop = (m[1] as string).trim();
      const value = (m[2] as string).trim();
      if (!STATUS_FILL.test(value)) continue;
      const where = `${leaf.context ? `${leaf.context} ` : ''}${leaf.selector} { ${prop}: ${value} }`;
      if (prop.startsWith('--'))
        out.push(`${where} — a custom property would carry a status fill past this guard`);
      else if (TEXT_PROPS.has(prop)) out.push(`${where} — text takes the -text token`);
    }
  }
  return out;
}

/** The CSS property a string literal is the value of, or null when it is held indirectly. */
function propertyOf(node: ts.Node, sf: ts.SourceFile): string | null {
  for (let n: ts.Node = node; n.parent; n = n.parent) {
    const p = n.parent;
    if (
      ts.isConditionalExpression(p) ||
      ts.isParenthesizedExpression(p) ||
      ts.isBinaryExpression(p) ||
      ts.isTemplateSpan(p) ||
      ts.isTemplateExpression(p) ||
      ts.isAsExpression(p)
    )
      continue;
    if (ts.isPropertyAssignment(p) && p.initializer === n) {
      const name = p.name;
      return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : name.getText(sf);
    }
    if (ts.isJsxAttribute(p)) return p.name.getText(sf);
    if (ts.isJsxExpression(p)) continue;
    return null;
  }
  return null;
}

/** The name a value is declared under (`const STATUS_DOT = {…}`, `function statusColor`), so
 * an indirect fill can be followed to where that name is used. */
function declaredName(node: ts.Node): string | null {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) return n.name.text;
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
  }
  return null;
}

/** Every text use of a status fill in one component, by line, with why. */
function inlineStatusText(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const line = (n: ts.Node): string =>
    `${file}:${String(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1)}`;
  const uses = (name: string): ts.Identifier[] => {
    const found: ts.Identifier[] = [];
    const walk = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && n.text === name) {
        const p = n.parent;
        const isDecl = (ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p)) && p.name === n;
        if (!isDecl) found.push(n);
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
    return found;
  };
  /** Follow a held fill to every use of its holder; each must land on a non-text property. */
  const follow = (holder: string, depth: number, origin: string): void => {
    const refs = uses(holder);
    if (refs.length === 0) out.push(`${origin} — held in ${holder}, which nothing uses`);
    for (const ref of refs) {
      // `STATUS_DOT[s]`, `dot()`, `statusColor(job())`: climb to the expression the value is.
      let expr: ts.Node = ref;
      while (
        ts.isPropertyAccessExpression(expr.parent) ||
        ts.isElementAccessExpression(expr.parent) ||
        (ts.isCallExpression(expr.parent) && expr.parent.expression === expr) ||
        ts.isNonNullExpression(expr.parent)
      )
        expr = expr.parent;
      const prop = propertyOf(expr, sf);
      if (prop !== null) {
        if (TEXT_PROPS.has(prop))
          out.push(`${origin} — reaches \`${prop}\` through ${holder} at ${line(ref)}`);
        continue;
      }
      const next = declaredName(expr);
      if (next !== null && next !== holder && depth < 3) follow(next, depth + 1, origin);
      else out.push(`${origin} — reaches ${holder} at ${line(ref)}, which this guard cannot place`);
    }
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const raw = node.getText(sf);
      const value = ts.isStringLiteralLike(node) ? node.text : raw;
      const origin = `${line(node)} ${raw}`;
      if (STATUS_FILL_NAME.test(value)) {
        out.push(`${origin} — a status fill read by name (a canvas colour) is not allowed`);
      } else if (STATUS_FILL.test(value)) {
        // An inline style string: each declaration speaks for itself.
        const decls = [...value.matchAll(/(?:^|;)\s*([-\w]+)\s*:\s*([^;]+)/g)];
        if (decls.length > 0 && decls.some((d) => STATUS_FILL.test(d[2] as string))) {
          for (const d of decls)
            if (STATUS_FILL.test(d[2] as string) && TEXT_PROPS.has((d[1] as string).trim()))
              out.push(`${origin} — text takes the -text token`);
        } else {
          const prop = propertyOf(node, sf);
          if (prop !== null) {
            if (TEXT_PROPS.has(prop)) out.push(`${origin} — text takes the -text token`);
          } else {
            const holder = declaredName(node);
            if (holder === null) out.push(`${origin} — held where this guard cannot place it`);
            else follow(holder, 0, origin);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe('status words are set in the -text tokens, never in the status fills', () => {
  describe('each -text token clears the text floor on the neutral surfaces (≥ 4.5:1)', () => {
    floors(pairs(['red-text', 'amber-text', 'green-text'], [...SURFACE_TOKENS, 'hover'], 4.5));
  });

  it('no stylesheet rule sets text in --red, --amber or --green', () => {
    const offenders = stylesheetStatusText(css);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('no component sets text in --red, --amber or --green, directly or through a helper', () => {
    const sources = componentFiles(SRC).map(
      (f) => [f.slice(SRC.length + 1), readFileSync(f, 'utf8')] as const,
    );
    expect(sources.length, 'the guard reads the components').toBeGreaterThan(30);
    const offenders = sources.flatMap(([file, src]) => inlineStatusText(file, src));
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  describe('self-checks: the guard reads what it guards', () => {
    it('names a stylesheet text use, inside a media query too, and passes edges and fills', () => {
      const probe = `.a { color: var(--red); }
        @media (max-width: 768px) { .b:hover { color: var(--amber); } }
        .c { border-color: var(--red); background: var(--green); color: var(--red-text); }
        .d { --x: var(--amber); }`;
      expect(stylesheetStatusText(probe)).toEqual([
        '.a { color: var(--red) } — text takes the -text token',
        '@media (max-width: 768px) .b:hover { color: var(--amber) } — text takes the -text token',
        '.d { --x: var(--amber) } — a custom property would carry a status fill past this guard',
      ]);
    });

    it('places a fill by its property, through ternaries, and follows a helper to its uses', () => {
      const probe = `const DOT = { ok: 'var(--green)', bad: 'var(--red)' };
const dot = (s: string): string => DOT[s] ?? 'var(--text3)';
function tone(t: string): string { return t === 'bad' ? 'var(--red)' : 'var(--text3)'; }
export function A(props: { s: string }) {
  // style="color:var(--red)" in a comment is prose
  return (
    <div>
      <span style={{ background: dot(props.s) }} />
      <span style={{ color: tone(props.s) }} />
      <span style="width:6px;background:var(--green)" />
      <span style="color:var(--amber);margin:0" />
      <span style={{ color: props.s === 'x' ? 'var(--text2)' : 'var(--red)' }} />
      <span style={{ background: props.s ? 'var(--green)' : 'var(--red)' }} />
    </div>
  );
}`;
      expect(inlineStatusText('pages/A.tsx', probe)).toEqual([
        "pages/A.tsx:3 'var(--red)' — reaches `color` through tone at pages/A.tsx:9",
        'pages/A.tsx:11 "color:var(--amber);margin:0" — text takes the -text token',
        "pages/A.tsx:12 'var(--red)' — text takes the -text token",
      ]);
    });
  });
});

describe('the visible-focus indicator survives (README: "all enforced by regression test suites")', () => {
  // The README's accessibility bullet lists visible focus among the properties "enforced by
  // regression test suites" — and until this test, it was the one item on that list nothing
  // enforced: keyboard/dialog semantics have a11y.test.tsx, contrast and reduced-motion have
  // their suites here, but the focus ring existed only as an unguarded CSS rule. A refactor
  // deleting it would have shipped with every suite green.
  it('declares a global :focus-visible outline that is real, not none', () => {
    const block = /:focus-visible\s*\{([^}]*)\}/.exec(css);
    expect(block, 'the global :focus-visible rule left styles.css').not.toBeNull();
    const body = block![1]!;
    expect(body).toMatch(/outline:\s*(?!none)/);
    // 2px solid accent with offset — the shape locked when the rule was written. Width and
    // offset are asserted as minimums of visibility, not exact pixels, so a deliberate
    // restyle can move them without touching this test's reason to exist.
    expect(body, 'outline thinner than visible').toMatch(/outline:\s*[2-9](\d)?px/);
    expect(body, 'outline-offset removed').toMatch(/outline-offset:/);
  });

  it('never suppresses the outline on a focus-visible selector', () => {
    // `outline: none` on :focus-visible is the classic accessibility regression — allowed
    // nowhere. (Plain `outline: none` with a replacement style is a different pattern and is
    // judged by the contrast suites, not here.)
    for (const m of css.matchAll(/([^{}]+)\{([^}]*outline:\s*none[^}]*)\}/g)) {
      expect(m[1], 'a :focus-visible selector suppresses its outline').not.toContain(
        ':focus-visible',
      );
    }
  });
});

/* ── Browser-drawn surfaces follow the theme (adopt-design-tokens-v2 task 11.3, D9) ──────────
 * dashboard-core "Browser-drawn surfaces follow the theme". Each declaration is read from the
 * shipped stylesheet and held in BOTH theme blocks: `color-scheme` is declared per block (never
 * `light dark` on the root, which would give a user who chose light on a dark OS dark native
 * widgets); every other declaration is made once, the dark block does not override it, and the
 * tokens it draws resolve — and clear their floor — in each theme. */
describe('browser-drawn surfaces follow the theme (task 11.3)', () => {
  /** The first top-level declaration of `prop` on exactly `selector`. */
  const decl = (selector: string, prop: string): string | undefined => {
    for (const leaf of accentLeaves(css)) {
      if (leaf.selector !== selector || leaf.context !== '') continue;
      const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(leaf.body);
      if (m) return (m[1] as string).trim();
    }
    return undefined;
  };
  const DARK = "[data-theme='dark']";

  it('each theme block declares its own color-scheme, never `light dark`', () => {
    expect(decl(':root', 'color-scheme'), ':root').toBe('light');
    expect(decl(DARK, 'color-scheme'), DARK).toBe('dark');
  });

  it('the dark block overrides none of the shared surface declarations', () => {
    for (const prop of ['accent-color', 'caret-color', 'scrollbar-color', 'scrollbar-width'])
      expect(decl(DARK, prop), `${DARK} ${prop}`).toBeUndefined();
  });

  for (const [themeName, vars] of Object.entries(THEMES)) {
    it(`${themeName}: a checked checkbox or radio and the caret take the accent`, () => {
      expect(decl(':root', 'accent-color')).toBe('var(--accent)');
      expect(decl(':root', 'caret-color')).toBe('var(--accent)');
      expect(color(vars, 'accent', `${themeName} --accent`)).toBe('#4f5dff');
    });

    it(`${themeName}: selected text is Ink on the Indigo Wash (≥ 4.5:1)`, () => {
      expect(decl('::selection', 'background')).toBe('var(--accent-bg)');
      expect(decl('::selection', 'color')).toBe('var(--text)');
      const label = `${themeName} ::selection --text/--accent-bg`;
      const r = ratio(color(vars, 'text', label), color(vars, 'accent-bg', label), label);
      expect(r, `${label} = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    });

    it(`${themeName}: a scrolling pane draws a thin Control Edge thumb on a transparent track`, () => {
      expect(decl('*', 'scrollbar-width')).toBe('thin');
      expect(decl('*', 'scrollbar-color')).toBe('var(--border-control) transparent');
      // The thumb is a control boundary on the surfaces a pane can be.
      for (const surface of ['bg', 'panel']) {
        const label = `${themeName} scrollbar thumb --border-control/--${surface}`;
        const r = ratio(color(vars, 'border-control', label), color(vars, surface, label), label);
        expect(r, `${label} = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
      }
    });

    it(`${themeName}: links are Deep Ink, underlined on hover and focus with a 2px offset, and always inside prose`, () => {
      expect(decl('a', 'color')).toBe('var(--accent-deep)');
      expect(decl('a', 'text-decoration')).toBe('none');
      expect(decl('a', 'text-underline-offset')).toBe('2px');
      expect(decl('.link-accent', 'text-underline-offset')).toBe('2px');
      for (const sel of [
        'a:hover',
        'a:focus-visible',
        '.link-accent:hover',
        '.link-accent:focus-visible',
      ])
        expect(decl(sel, 'text-decoration'), sel).toBe('underline');
      for (const sel of ['.prose a', '.prose .link-accent'])
        expect(decl(sel, 'text-decoration'), `${sel} is underlined at rest`).toBe('underline');
      for (const surface of ['bg', 'panel']) {
        const label = `${themeName} link --accent-deep/--${surface}`;
        const r = ratio(color(vars, 'accent-deep', label), color(vars, surface, label), label);
        expect(r, `${label} = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('the one sentence that holds a link is marked as prose', () => {
    // Setup's "…any time under Routing." is the app's only link set inside body text.
    const setup = readFileSync(join(SRC, 'pages/Setup.tsx'), 'utf8');
    expect(setup).toMatch(/class="t-caption prose"[^>]*>\s*Tune tiers/);
  });
});
