import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The type-scale guard (dashboard-core "Dashboard text uses five locked sizes";
 * adopt-design-tokens-v2 task 2.1, design.md D5).
 *
 * Dashboard text is set at five sizes (11 / 12 / 13 / 15 / 26px at the default root size),
 * authored in `rem` so the user's font-size setting scales it, on line heights from the 4px
 * grid (16 / 20 / 32px). This reads every place a size or a line height can be written —
 * `styles.css`, every component's inline styles (attribute strings, style objects and the
 * style-string constants they share), and the `style.cssText` literals of `index.html`'s
 * boot-failure script — and fails each declaration off the scale, naming it and where it is.
 *
 * Exemptions are named, never implied:
 * - `1rem` text, only in a comfort-context rule (`max-width: 768px` / `pointer: coarse`)
 *   whose every selector is an entry field: 16px input text keeps iOS from zooming on focus.
 * - uPlot's canvas axis font in `Chart.tsx` / `BudgetChart.tsx`: a canvas cannot take `rem`,
 *   so it keeps an on-scale `px` size there and nowhere else.
 * - Line heights: none today. One would be listed by selector in `LINE_HEIGHT_EXEMPT`.
 *
 * A `font` shorthand always resets `line-height` — to `normal` when it names none, which is
 * off the grid at every size — so a shorthand must carry its `/line-height`.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const PKG = join(SRC, '..');

/** The five sizes, in rem (px ÷ 16). */
export const SIZES: readonly string[] = [
  '0.6875rem',
  '0.75rem',
  '0.8125rem',
  '0.9375rem',
  '1.625rem',
];
/** 16 / 20 / 32px, plus `inherit`. */
export const LINE_HEIGHTS: readonly string[] = ['1rem', '1.25rem', '2rem', 'inherit'];
/** The Display size: only in `.t-display`, and only `ReadoutStrip` may use that class. */
export const DISPLAY_SIZE = '1.625rem';
export const DISPLAY_SELECTOR = '.t-display';
export const DISPLAY_OWNER = 'components/ReadoutStrip.tsx';
/** Comfort-context input text (16px). */
export const COMFORT_INPUT_SIZE = '1rem';
/** The canvas exemption: files whose uPlot axis font is a canvas font string, and the
 * on-scale px sizes it may take. */
export const CANVAS_FILES: readonly string[] = [
  'components/Chart.tsx',
  'components/BudgetChart.tsx',
];
export const CANVAS_SIZES: readonly string[] = ['11px', '12px', '13px', '15px', '26px'];
/** Line-height exemptions, by selector, each with its reason. Empty: none is needed. */
export const LINE_HEIGHT_EXEMPT: Readonly<Record<string, string>> = {};

export type TypeProp = 'font' | 'font-size' | 'line-height';

export interface TypeDecl {
  /** `file:line` plus the selector or the source form, for the failure message. */
  where: string;
  file: string;
  prop: TypeProp;
  value: string;
  /** CSS only: the rule's selector list, and the at-rules enclosing it. */
  selector?: string;
  context?: string;
  /** TSX only: a font string outside any style attribute in a canvas file. */
  canvas?: boolean;
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/** Comments blanked to spaces, newlines kept, so line numbers survive. */
const blank = (m: string): string => m.replace(/[^\n]/g, ' ');

/* ── styles.css ─────────────────────────────────────────────────────────────── */

/** Every leaf rule's type declarations, with the selector and enclosing at-rules. */
export function cssDeclarations(source: string, file: string): TypeDecl[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, blank);
  const out: TypeDecl[] = [];
  const stack: { prelude: string; start: number }[] = [];
  let last = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '{') {
      stack.push({ prelude: css.slice(last, i).trim().replace(/\s+/g, ' '), start: i + 1 });
      last = i + 1;
    } else if (c === '}') {
      const top = stack.pop();
      if (!top) throw new Error(`${file}: unbalanced "}" at line ${lineOf(css, i)}`);
      const body = css.slice(top.start, i);
      if (!body.includes('{')) {
        const context = stack.map((s) => s.prelude).join(' > ');
        let offset = top.start;
        for (const d of body.split(';')) {
          const m = /^(\s*)(font|font-size|line-height)\s*:\s*([\s\S]*)$/.exec(d);
          if (m) {
            const line = lineOf(css, offset + (m[1] ?? '').length);
            out.push({
              where: `${file}:${line} ${top.prelude}${context ? ` (in ${context})` : ''}`,
              file,
              prop: m[2] as TypeProp,
              value: (m[3] ?? '').replace(/\s+/g, ' ').trim(),
              selector: top.prelude,
              context,
            });
          }
          offset += d.length + 1;
        }
      }
      last = i + 1;
    } else if (c === ';' && stack.length === 0) {
      last = i + 1;
    }
  }
  return out;
}

/* ── TSX ────────────────────────────────────────────────────────────────────── */

/** Strip comments: block comments (JSX `{/* … *\/}` included) and line comments that do not
 * follow a `:` (so `https://` in a string survives). */
function stripTsxComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:'"`\\])(\/\/[^\n]*)/gm, (_m, pre: string, c: string) => pre + blank(c));
}

/** Ranges of JSX style attributes: `style="…"`, `style={{ … }}`, `style={…}`. */
function styleRanges(source: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const m of source.matchAll(/\bstyle=/g)) {
    const start = (m.index ?? 0) + m[0].length;
    const open = source[start];
    if (open === '"') {
      ranges.push([start, source.indexOf('"', start + 1) + 1]);
    } else if (open === '{') {
      let depth = 0;
      for (let i = start; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) {
          ranges.push([start, i + 1]);
          break;
        }
      }
    }
  }
  return ranges;
}

/** The JS string literal starting at `i` (a quote), with `${…}` placeholders as `X`. */
function readLiteral(source: string, i: number): string {
  const quote = source[i];
  let out = '';
  for (let j = i + 1; j < source.length; j++) {
    const c = source[j];
    if (c === '\\') {
      out += source[j + 1] ?? '';
      j++;
    } else if (c === quote) {
      return out;
    } else if (quote === '`' && c === '$' && source[j + 1] === '{') {
      let depth = 0;
      for (let k = j + 1; k < source.length; k++) {
        if (source[k] === '{') depth++;
        else if (source[k] === '}' && --depth === 0) {
          j = k;
          break;
        }
      }
      out += 'X';
    } else {
      out += c;
    }
  }
  return out;
}

/** CSS text inside a string: up to the declaration's end or the string's. */
function readCssValue(source: string, i: number): string {
  let out = '';
  for (let j = i; j < source.length; j++) {
    const c = source[j];
    if (c === ';' || c === '"' || c === '`' || c === '\n' || c === '}') break;
    if (c === '$' && source[j + 1] === '{') {
      let depth = 0;
      for (let k = j + 1; k < source.length; k++) {
        if (source[k] === '{') depth++;
        else if (source[k] === '}' && --depth === 0) {
          j = k;
          break;
        }
      }
      out += 'X';
      continue;
    }
    out += c;
  }
  // A declaration closing a single-quoted string ends at that quote: `'…font-size:15px'`.
  const quotes = (out.match(/'/g) ?? []).length;
  if (quotes % 2 === 1) out = out.slice(0, out.lastIndexOf("'"));
  return out.trim();
}

const TSX_PROP = /(['"]?)(font-size|line-height|fontSize|lineHeight|font)\1\s*:\s*/g;

/** Every type declaration a TSX source can carry: CSS text in any string (attributes and the
 * style constants they share), style-object keys, and — in a canvas file — the uPlot font. */
export function tsxDeclarations(source: string, file: string): TypeDecl[] {
  const code = stripTsxComments(source);
  const ranges = styleRanges(code);
  const inStyle = (i: number): boolean => ranges.some(([a, b]) => i >= a && i < b);
  const out: TypeDecl[] = [];
  for (const m of code.matchAll(TSX_PROP)) {
    const at = m.index ?? 0;
    const before = code[at - 1] ?? '';
    // `font-family:`, `--font:`, `fontWeight`: a longer name, not a type declaration.
    if (/[\w-]/.test(before)) continue;
    const name = m[2] ?? '';
    const prop: TypeProp =
      name === 'fontSize'
        ? 'font-size'
        : name === 'lineHeight'
          ? 'line-height'
          : (name as TypeProp);
    const valueAt = at + m[0].length;
    const first = code[valueAt] ?? '';
    let value: string;
    if (first === '"' || first === "'" || first === '`') value = readLiteral(code, valueAt).trim();
    else if (/[\d.]/.test(first) && /^[\d.]+\s*[,}\n]/.test(code.slice(valueAt, valueAt + 12)))
      value = (/^[\d.]+/.exec(code.slice(valueAt)) ?? [''])[0];
    else value = readCssValue(code, valueAt);
    const canvas =
      CANVAS_FILES.includes(file) &&
      prop === 'font' &&
      first !== '' &&
      /['"`]/.test(first) &&
      !inStyle(at);
    out.push({ where: `${file}:${lineOf(code, at)} ${prop}: ${value}`, file, prop, value, canvas });
  }
  return out;
}

/* ── index.html ─────────────────────────────────────────────────────────────── */

/** The boot-failure script's `style.cssText = '…' + '…'` literals, parsed as CSS text. */
export function indexHtmlDeclarations(source: string, file: string): TypeDecl[] {
  const html = source.replace(/<!--[\s\S]*?-->/g, blank);
  const out: TypeDecl[] = [];
  for (const m of html.matchAll(/cssText\s*=\s*/g)) {
    let i = (m.index ?? 0) + m[0].length;
    let text = '';
    for (;;) {
      while (/\s/.test(html[i] ?? '')) i++;
      const q = html[i];
      if (q !== "'" && q !== '"') break;
      const end = html.indexOf(q, i + 1);
      text += html.slice(i + 1, end);
      i = end + 1;
      while (/\s/.test(html[i] ?? '')) i++;
      if (html[i] !== '+') break;
      i++;
    }
    const line = lineOf(html, m.index ?? 0);
    for (const d of text.split(';')) {
      const dm = /^\s*(font|font-size|line-height)\s*:\s*(.*)$/.exec(d);
      if (!dm) continue;
      const value = (dm[2] ?? '').trim();
      out.push({
        where: `${file}:${line} ${dm[1] ?? ''}:${value}`,
        file,
        prop: dm[1] as TypeProp,
        value,
      });
    }
  }
  return out;
}

/* ── the rules ──────────────────────────────────────────────────────────────── */

const SIZE_TOKEN =
  /(?:^|\s)((?:\d*\.)?\d+(?:px|rem|em|%|pt|ex|ch|vw|vh))(?:\s*\/\s*([^\s,'"]+))?(?=\s|$)/;

/** A `font` shorthand's size and line height (`null` when it names none). */
export function parseFont(value: string): { size: string | null; lineHeight: string | null } {
  const m = SIZE_TOKEN.exec(value);
  return { size: m?.[1] ?? null, lineHeight: m?.[2] ?? null };
}

const COMFORT_CONTEXT = /@media[^>]*(max-width:\s*768px|pointer:\s*coarse)/;
const ENTRY_FIELD = /(?:^|[\s>+~(])(?:input|select|textarea)\b|\.(?:input|select|mp-input)\b/;

/** The comfort-context input rule: a rule inside a comfort media query whose every selector
 * names an entry field. */
export function isComfortInputRule(d: TypeDecl): boolean {
  if (!d.selector || !d.context || !COMFORT_CONTEXT.test(d.context)) return false;
  return d.selector.split(',').every((s) => ENTRY_FIELD.test(s.trim()));
}

function sizeProblem(size: string, d: TypeDecl): string | null {
  if (d.canvas) {
    return CANVAS_SIZES.includes(size)
      ? null
      : `canvas font size ${size} is off the scale (on-scale px only: ${CANVAS_SIZES.join(' / ')})`;
  }
  if (size === COMFORT_INPUT_SIZE && isComfortInputRule(d)) return null;
  if (!SIZES.includes(size)) {
    return size.endsWith('px')
      ? `size ${size} is written in px (author it in rem: ${SIZES.join(' / ')})`
      : `size ${size} is off the scale (${SIZES.join(' / ')})`;
  }
  if (size === DISPLAY_SIZE && d.selector !== DISPLAY_SELECTOR) {
    return `the Display size ${DISPLAY_SIZE} belongs to ${DISPLAY_SELECTOR} alone`;
  }
  return null;
}

function lineHeightProblem(lh: string, d: TypeDecl): string | null {
  if (LINE_HEIGHTS.includes(lh)) return null;
  if (d.selector && LINE_HEIGHT_EXEMPT[d.selector] !== undefined) return null;
  if (/^[\d.]+$/.test(lh))
    return `unitless line height ${lh} (on the grid: ${LINE_HEIGHTS.join(' / ')})`;
  if (lh.endsWith('px'))
    return `line height ${lh} is written in px (author it in rem: ${LINE_HEIGHTS.join(' / ')})`;
  return `line height ${lh} is off the 4px grid (${LINE_HEIGHTS.join(' / ')})`;
}

/** Every problem with one declaration; empty when it is on the scale. */
export function problems(d: TypeDecl): string[] {
  const v = d.value;
  const out: (string | null)[] = [];
  if (d.prop === 'font-size') {
    out.push(v === 'inherit' ? null : sizeProblem(v, d));
  } else if (d.prop === 'line-height') {
    out.push(lineHeightProblem(v, d));
  } else if (v !== 'inherit') {
    const { size, lineHeight } = parseFont(v);
    if (size === null) out.push(`font shorthand "${v}" names no size the guard can read`);
    else out.push(sizeProblem(size, d));
    if (!d.canvas) {
      out.push(
        lineHeight === null
          ? 'font shorthand names no /line-height, so it resets it to normal (off the 4px grid)'
          : lineHeightProblem(lineHeight, d),
      );
    } else if (lineHeight !== null) {
      out.push('a canvas font string takes no line height');
    }
  }
  return out.filter((p): p is string => p !== null).map((p) => `${d.where} — ${p}`);
}

/* ── the sources ────────────────────────────────────────────────────────────── */

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'test' ? [] : tsxFiles(full);
    return full.endsWith('.tsx') && !full.endsWith('.test.tsx') ? [full] : [];
  });
}

const rel = (full: string): string => relative(SRC, full).split('\\').join('/');
const cssSource = readFileSync(join(SRC, 'styles.css'), 'utf8');
const tsxSources = tsxFiles(SRC).map((f) => [rel(f), readFileSync(f, 'utf8')] as const);
const indexHtml = readFileSync(join(PKG, 'index.html'), 'utf8');

describe('the type-scale guard reads what it guards (self-check)', () => {
  it('reads a size and line height from each form a font shorthand takes', () => {
    expect(parseFont("500 0.8125rem/1rem 'Geist', sans-serif")).toEqual({
      size: '0.8125rem',
      lineHeight: '1rem',
    });
    expect(parseFont("600 12.5px 'Geist'")).toEqual({ size: '12.5px', lineHeight: null });
    expect(parseFont('X 0.75rem / 1.25rem Geist')).toEqual({
      size: '0.75rem',
      lineHeight: '1.25rem',
    });
    // A weight is a bare number, never mistaken for a size.
    expect(parseFont('600 Geist').size).toBeNull();
  });

  it('fails an off-scale size, a px size, a unitless or px line height and a bare shorthand', () => {
    const css = `.a { font-size: 12.5px; } .b { font-size: 0.75rem; line-height: 1.5; }
      .c { font: 500 0.75rem 'Geist'; } .d { font: 500 0.75rem/1rem 'Geist'; } .e { font-size: 11px; }
      .f { line-height: 20px; }`;
    const found = cssDeclarations(css, 'x.css').flatMap(problems);
    expect(found).toHaveLength(5);
    expect(found.join('\n')).toMatch(/\.f — line height 20px is written in px/);
    expect(found.join('\n')).toMatch(/\.a — size 12\.5px is written in px/);
    expect(found.join('\n')).toMatch(/\.b — unitless line height 1\.5/);
    expect(found.join('\n')).toMatch(/\.c — font shorthand names no \/line-height/);
    expect(found.join('\n')).toMatch(/\.e — size 11px is written in px/);
  });

  it('scopes the comfort exemption to an entry field inside a comfort query', () => {
    const css = `@media (max-width: 768px) { input, .select { font-size: 1rem; } .btn { font-size: 1rem; } }
      .input { font-size: 1rem; }`;
    const found = cssDeclarations(css, 'x.css').flatMap(problems);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatch(
      /\.btn \(in @media \(max-width: 768px\)\) — size 1rem is off the scale/,
    );
    expect(found[1]).toMatch(/\.input — size 1rem is off the scale/);
  });

  it('holds the Display size to .t-display', () => {
    const css = `.t-display { font: 600 1.625rem/2rem 'Geist'; } .stat { font: 600 1.625rem/2rem 'Geist'; }`;
    const found = cssDeclarations(css, 'x.css').flatMap(problems);
    expect(found).toEqual([
      expect.stringMatching(/\.stat — the Display size 1\.625rem belongs to \.t-display/),
    ]);
  });

  it('reads attribute strings, style objects, constants and template placeholders in TSX', () => {
    const tsx = [
      `const NOTE = "font:400 11px 'Geist',sans-serif;color:red";`,
      `<div style="margin:0;font-size:10.5px;line-height:1.5">a</div>`,
      `<b style={{ font: \`\${on ? '500' : '400'} 12px 'Geist'\`, 'font-size': '11px' }} />`,
      `// <i style="font:400 99px Geist">commented out</i>`,
      `<i style="font-family:'Geist Mono',monospace">mono is not a size</i>`,
    ].join('\n');
    const decls = tsxDeclarations(tsx, 'pages/X.tsx');
    expect(decls.map((d) => `${d.prop}=${d.value}`)).toEqual([
      "font=400 11px 'Geist',sans-serif",
      'font-size=10.5px',
      'line-height=1.5',
      "font=X 12px 'Geist'",
      'font-size=11px',
    ]);
    expect(decls.flatMap(problems)).toHaveLength(7);
  });

  it('accepts an on-scale px canvas font only in a canvas file, outside any style attribute', () => {
    const tsx = `const axis = { font: "11px 'Geist Mono', monospace" };\n<div style={{ font: "400 11px 'Geist'" }} />`;
    const inChart = tsxDeclarations(tsx, 'components/Chart.tsx');
    expect(inChart.map((d) => d.canvas)).toEqual([true, false]);
    expect(inChart.flatMap(problems)).toHaveLength(2); // the style object: px size, no line height
    expect(tsxDeclarations(tsx, 'pages/Costs.tsx').flatMap(problems)).toHaveLength(4);
    const offScale = tsxDeclarations(
      `const axis = { font: "10px Geist" };`,
      'components/Chart.tsx',
    );
    expect(offScale.flatMap(problems)).toEqual([
      expect.stringMatching(/canvas font size 10px is off the scale/),
    ]);
  });

  it('reads a cssText literal split across a concatenation in index.html', () => {
    const html = `<script>box.style.cssText =\n  'font:400 14px/1.5 Geist,sans-serif;' + 'max-width:34rem';\nh.style.cssText = 'font-weight:600;font-size:15px';</script>`;
    const decls = indexHtmlDeclarations(html, 'index.html');
    expect(decls.map((d) => `${d.prop}=${d.value}`)).toEqual([
      'font=400 14px/1.5 Geist,sans-serif',
      'font-size=15px',
    ]);
  });
});

describe('dashboard text uses five locked sizes (adopt-design-tokens-v2 D5)', () => {
  it('styles.css sets every size, line height and font shorthand on the scale', () => {
    const decls = cssDeclarations(cssSource, 'styles.css');
    expect(decls.length, 'the guard reads the stylesheet').toBeGreaterThan(20);
    expect(decls.flatMap(problems)).toEqual([]);
  });

  it('every component inline style sets its size and line height on the scale', () => {
    const decls = tsxSources.flatMap(([file, src]) => tsxDeclarations(src, file));
    expect(decls.length, 'the guard reads the components').toBeGreaterThan(20);
    expect(decls.flatMap(problems)).toEqual([]);
  });

  it("index.html's boot-failure message is on the scale too", () => {
    const decls = indexHtmlDeclarations(indexHtml, 'index.html');
    expect(decls.length, 'the guard reads the boot script').toBeGreaterThanOrEqual(2);
    expect(decls.flatMap(problems)).toEqual([]);
  });

  it('only uPlot canvas text takes the canvas exemption', () => {
    const canvas = tsxSources
      .flatMap(([file, src]) => tsxDeclarations(src, file))
      .filter((d) => d.canvas);
    expect(canvas.length, 'the chart axis font is read').toBeGreaterThanOrEqual(1);
    for (const d of canvas) expect(CANVAS_FILES, d.where).toContain(d.file);
  });

  it('the Display size lives in .t-display, and only ReadoutStrip uses that class', () => {
    const display = cssDeclarations(cssSource, 'styles.css').filter(
      (d) => d.value === DISPLAY_SIZE || parseFont(d.value).size === DISPLAY_SIZE,
    );
    expect(
      display.map((d) => d.selector),
      `${DISPLAY_SIZE} is declared by ${DISPLAY_SELECTOR} alone`,
    ).toEqual([DISPLAY_SELECTOR]);
    // A class reference anywhere but ReadoutStrip would put a second Display figure in some
    // view — a dialog, a drawer or a page no per-page count remembered to list.
    const users = tsxSources
      .filter(
        ([file, src]) => file !== DISPLAY_OWNER && /\bt-display\b/.test(stripTsxComments(src)),
      )
      .map(([file]) => file);
    expect(users, `t-display is referenced only by ${DISPLAY_OWNER}`).toEqual([]);
    // ReadoutStrip (task 12.1) renders exactly one Display cell: one reference to the class.
    // It exists now, so its absence is a failure, not a skip (it was conditional while the
    // component was still to come; notes/flags.md F2).
    const owner = join(SRC, DISPLAY_OWNER);
    expect(existsSync(owner), `${DISPLAY_OWNER} exists`).toBe(true);
    const refs = stripTsxComments(readFileSync(owner, 'utf8')).match(/\bt-display\b/g) ?? [];
    expect(refs, `${DISPLAY_OWNER} names t-display once`).toHaveLength(1);
  });
});

describe('the lock states the type scale the guard enforces (STYLESEED.md L14)', () => {
  // STYLESEED.md and styles.css change together, never one alone: the Type line names the
  // five sizes and the line heights in px, and says they are authored in rem.
  const lock = readFileSync(join(PKG, '..', '..', 'STYLESEED.md'), 'utf8');
  const typeLine = lock.split('\n').find((l) => l.startsWith('- Type:')) ?? '';
  const px = (rem: string): string => `${parseFloat(rem) * 16}`;

  it('names the five sizes, their line heights and the rem rule', () => {
    expect(typeLine, 'STYLESEED.md lost its "- Type:" line').not.toBe('');
    const sizes = /(\d+(?: \/ \d+)+)px, authored in rem/.exec(typeLine)?.[1] ?? '';
    expect(sizes.split(' / '), 'the lock sizes are the guard sizes').toEqual(SIZES.map(px));
    const lines = /line heights (\d+(?: \/ \d+)+)px/.exec(typeLine)?.[1] ?? '';
    expect(lines.split(' / '), 'the lock line heights are the guard line heights').toEqual(
      LINE_HEIGHTS.filter((l) => l !== 'inherit').map(px),
    );
    expect(typeLine).toMatch(/Mono for identifiers only/);
    expect(typeLine).toMatch(/figures tabular/);
  });
});
