import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The spacing and radius guards (dashboard-core "Spacing comes from the 4px scale" and
 * "Corners use four locked radii"; adopt-design-tokens-v2 task 3.1, design.md D6 / D7).
 *
 * Every space between or around elements — `margin*`, `padding*`, `gap`, `row-gap` and
 * `column-gap` — is a step of the 4px scale (0 / 4 / 8 / 12 / 16 / 20 / 24 / 32px), and every
 * corner is one of four radii (4 / 6 / 10 / 16px) or a circle. This reads `styles.css` (leaf
 * rules, media and container queries included, and the custom properties a guarded value
 * uses) and every component's inline styles (attribute strings, style objects and the
 * style-string constants they share), and fails each declaration off the scale, naming it and
 * where it is.
 *
 * Exemptions are named, never implied:
 * - **Control-internal padding** (D4): a control's padding follows from its height-family row
 *   — (height − 2px border − 16px line) ÷ 2 in the block axis, plus the listed inline values —
 *   so it may take a derived value off the 4px scale. Only on the controls listed in
 *   `CONTROL_PADDING` (by selector), and in TSX only on a control element (`CONTROL_TAGS`).
 * - **1–2px control insets** (D6): the gap between a control's edge and the element it holds
 *   (the segmented track's padding). Listed by selector in `CONTROL_INSET`.
 * - **Not a space**: the visually-hidden idiom's `margin: -1px`, and a negative block margin
 *   that hands a target floor's surplus back to its line. Listed in `NOT_A_SPACE`.
 * - **Circles** (D7): `50%` only on dot- and node-shaped marks — `CIRCLE_SELECTORS` in the
 *   stylesheet, and in TSX only in a `CIRCLE_FILES` file on an element whose own style draws
 *   it square (equal width and height).
 * - **The sheet radius**: 16px only inside the narrow media query, where sheets live.
 *
 * Positional offsets (`top` / `bottom` / `inset`) and `outline-offset` are not spaces and are
 * not read: an offset is a lock value, reviewed with the lock (the toast's 24px, the sheet
 * strip).
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const PKG = join(SRC, '..');

/** The 4px spacing scale, in px. */
export const SPACE_SCALE: readonly number[] = [0, 4, 8, 12, 16, 20, 24, 32];
/** The four radii, plus `0` and the circle. */
export const RADII: readonly string[] = ['0', '4px', '6px', '10px', '16px', '50%'];
/** The sheet radius: only inside the narrow media query (`sheet-radius` in the lock). */
export const SHEET_RADIUS = '16px';
const NARROW_CONTEXT = /@media[^>]*max-width:\s*768px/;

/** D4's derived control paddings, in px: 7 (32px row), 3 (24px row), 13 (44px comfort row)
 * and 2 (the 20px static chip) in the block axis; 4 × 11 for the 26px segmented option; and
 * the listed inline values — 13 (buttons), 11 (inputs), 9 (nav items), 10 (ghost buttons)
 * and 8 (filter and static chips). */
export const DERIVED_PADDING: readonly number[] = [2, 3, 7, 9, 10, 11, 13];

/** Controls whose padding is derived from their height-family row (D4), by selector. */
export const CONTROL_PADDING: Readonly<Record<string, string>> = {
  '.btn-primary': '32px button, 7 × 13',
  '.btn-destructive': '32px button, 7 × 13',
  '.btn-cancel': '32px button, 7 × 13',
  '.btn-ghost': '24px ghost button, 3 × 10',
  '.btn-ghost--destructive:active':
    "24px destructive ghost, pressed: its 2px border gives up 1px of the ghost's 3 × 10 per side, 2 × 9",
  '.input': '32px input, 7 × 11',
  '.select': '32px select, 7 × 11',
  '.mp-input': 'the add-model combobox input, an input',
  '.nav-item': '32px nav item, 7 × 9',
  '.rs-sidebar:not(.rs-nav-open) .nav-item': 'the collapsed rail nav item, 7 × 0',
  '.rs-seg': '26px segmented option, 4 × 11',
  '.endpoint-chip': '24px endpoint chip',
  '.chip': '20px static chip, 2 × 8',
  '.pos-badge': '20px static chip (the chain position badge), 2 × 0',
  '.ar-tag': '20px static chip (a Targets / stage tag), 2 × 8',
  '.drawer-close': 'the icon-only drawer close control: 2px around its 20px line, a 24px box',
  '.select--sm': '24px select in a row of 24px controls, 3 × 8',
  '.filter-chip': '24px filter chip, 3 × 8',
  '.live-pill': '24px Live pill, 3 × 10',
  '.menu-item': '32px account-menu item, 7 × 12',
  '.sp-entry': '32px subscription-plan entry (redesign-subscription-picker), 7 × 8',
  '.account-trigger':
    '32px account trigger: 4px around its 20px avatar, centred in the family height, × 10',
};
/** JSX elements whose inline padding is a control's own (the D4 exemption in TSX). */
export const CONTROL_TAGS: readonly string[] = ['button', 'input', 'select', 'textarea'];

/** 1–2px insets inside a control (D6), by selector. */
export const CONTROL_INSET: Readonly<Record<string, string>> = {
  '.seg-track': "the segmented track's 2px padding around its 26px options",
};
export const INSET_PX: readonly number[] = [1, 2];

/** Declarations that set a margin but are not a space, by selector, each with its reason. */
export const NOT_A_SPACE: Readonly<Record<string, string>> = {
  '.sr-only': 'visually hidden: margin -1px is the clip idiom',
  '.rs-sidebar:not(.rs-nav-open) .rs-nav-label': 'visually hidden: the clip idiom',
  '.ar-fieldlabel': 'visually hidden: the clip idiom',
  '.ar-act-label': 'visually hidden: the clip idiom',
  '.tm-label': 'visually hidden: the clip idiom',
  '.ar-note-link':
    "a negative block margin handing the target floor's surplus back to its line (a target, not a space)",
  '.rs-docked':
    "the content pane gives up the docked inspector's width (a lock value, `inspector-dock-width` 480px; add-docked-inspector D3): a reservation for an out-of-flow panel, not a space",
};

/** Rules whose gap still differs below narrow, recorded rather than silently allowed: each is
 * the comfort-context wrap of a Routing chain row (it applies under a coarse pointer at any
 * width too), which predates adopt-design-tokens-v2 and is flagged for a decision
 * (notes/flags.md F13). */
export const NARROW_GAP_EXCEPTIONS: Readonly<Record<string, string>> = {
  '.chain-row': 'F13: the wrapped chain row spaces its 44px lines 8px apart (4px at desktop)',
  '.chain-head': "F13: the wrapped chain head's lines sit 4px apart (its gap is 8px at desktop)",
};

/** Dot-, knob- and node-shaped marks that may be circles (D7), by selector. */
export const CIRCLE_SELECTORS: Readonly<Record<string, string>> = {
  '.toggle-knob': 'the switch knob',
  '.step-marker': "the Setup guide's step node (adopt-design-tokens-v2 D8 moved it out of TSX)",
  '.rt-dot': "the Route Trace's 8px node mark (add-route-trace-inspector design D6; DS-1 D7)",
};
/** TSX files that draw a dot or node inline, each with what it draws. The element must
 * also declare equal width and height in its own style. */
export const CIRCLE_FILES: Readonly<Record<string, string>> = {
  'components/RequestTable.tsx': 'status dots',
  'components/Topbar.tsx': 'the live dot',
  'components/Sidebar.tsx': 'the instance status dot',
  'pages/Batches.tsx': 'status dots',
  'pages/Overview.tsx': 'provider status dots',
  'pages/Providers.tsx': 'provider status dots',
  'pages/Setup.tsx': 'the synced dot',
};

export type Kind = 'space' | 'radius';

export interface ScaleDecl {
  /** `file:line` plus the selector or the element, for the failure message. */
  where: string;
  file: string;
  kind: Kind;
  prop: string;
  value: string;
  /** CSS only: the rule's selector list, and the at-rules enclosing it. */
  selector?: string;
  context?: string;
  /** TSX only: the JSX element the style belongs to, and its whole style text. */
  tag?: string;
  style?: string;
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;
const blank = (m: string): string => m.replace(/[^\n]/g, ' ');

const SPACE_PROP =
  /^(?:margin|padding)(?:-(?:top|bottom|left|right|block|inline)(?:-(?:start|end))?)?$|^(?:row-|column-)?gap$/;
const RADIUS_PROP = /^border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius$/;

const kindOf = (prop: string): Kind | null =>
  SPACE_PROP.test(prop) ? 'space' : RADIUS_PROP.test(prop) ? 'radius' : null;

/* ── styles.css ─────────────────────────────────────────────────────────────── */

interface CssCustom {
  name: string;
  value: string;
  where: string;
  selector: string;
  context: string;
}

/** Every leaf rule's spacing and radius declarations, plus every custom property. */
export function cssScan(
  source: string,
  file: string,
): { decls: ScaleDecl[]; customs: CssCustom[]; all: CssCustom[] } {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, blank);
  const decls: ScaleDecl[] = [];
  const customs: CssCustom[] = [];
  /** Every declaration, whatever its property (the lock check reads offsets too). */
  const all: CssCustom[] = [];
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
          const m = /^(\s*)(-{0,2}[\w-]+)\s*:\s*([\s\S]*)$/.exec(d);
          if (m) {
            const prop = m[2] ?? '';
            const value = (m[3] ?? '').replace(/\s+/g, ' ').trim();
            const line = lineOf(css, offset + (m[1] ?? '').length);
            const where = `${file}:${line} ${top.prelude}${context ? ` (in ${context})` : ''}`;
            const kind = kindOf(prop);
            all.push({ name: prop, value, where, selector: top.prelude, context });
            if (prop.startsWith('--')) {
              customs.push({ name: prop, value, where, selector: top.prelude, context });
            } else if (kind) {
              decls.push({ where, file, kind, prop, value, selector: top.prelude, context });
            }
          }
          offset += d.length + 1;
        }
      }
      last = i + 1;
    } else if (c === ';' && stack.length === 0) {
      last = i + 1;
    }
  }
  return { decls, customs, all };
}

/** The guarded declarations of a stylesheet, with every custom property a guarded value
 * names checked as that kind too, attributed to where the property is declared. */
export function cssDeclarations(source: string, file: string): ScaleDecl[] {
  const { decls, customs } = cssScan(source, file);
  const out = [...decls];
  const seen = new Set<string>();
  for (const d of decls) {
    for (const v of d.value.matchAll(/var\(\s*(--[\w-]+)/g)) {
      const name = v[1] ?? '';
      if (seen.has(`${d.kind}:${name}`)) continue;
      seen.add(`${d.kind}:${name}`);
      for (const c of customs.filter((x) => x.name === name)) {
        out.push({
          where: `${c.where} ${c.name}`,
          file,
          kind: d.kind,
          prop: c.name,
          value: c.value,
          selector: c.selector,
          context: c.context,
        });
      }
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

/** JSX style attributes: the range of each `style="…"` / `style={…}` value, and the opening
 * tag that carries it. */
interface StyleRange {
  start: number;
  end: number;
  tag: string;
  tagText: string;
}

function styleRanges(source: string): StyleRange[] {
  const ranges: StyleRange[] = [];
  for (const m of source.matchAll(/\bstyle=/g)) {
    const at = m.index ?? 0;
    const start = at + m[0].length;
    let end = -1;
    if (source[start] === '"') end = source.indexOf('"', start + 1) + 1;
    else if (source[start] === '{') {
      let depth = 0;
      for (let i = start; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end < 0) continue;
    // The opening tag: back from the attribute to a `<name` outside any `{…}` expression.
    let depth = 0;
    let tagStart = -1;
    for (let k = at - 1; k >= 0; k--) {
      const c = source[k];
      if (c === '}') depth++;
      else if (c === '{') depth--;
      else if (c === '<' && depth <= 0 && /[a-zA-Z]/.test(source[k + 1] ?? '')) {
        tagStart = k;
        break;
      }
    }
    const tag = tagStart >= 0 ? (/^<([\w.-]+)/.exec(source.slice(tagStart))?.[1] ?? '') : '';
    const tagText = tagStart >= 0 ? source.slice(tagStart, at) : '';
    ranges.push({ start, end, tag, tagText });
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
  const quotes = (out.match(/'/g) ?? []).length;
  if (quotes % 2 === 1) out = out.slice(0, out.lastIndexOf("'"));
  return out.trim();
}

const TSX_PROP =
  /(['"]?)((?:margin|padding)(?:-(?:top|bottom|left|right|block|inline)(?:-(?:start|end))?)?|(?:row-|column-)?gap|(?:margin|padding)(?:Top|Bottom|Left|Right|Block|Inline)(?:Start|End)?|rowGap|columnGap|border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius|border(?:Top|Bottom|Start|End)?(?:Left|Right|Start|End)?Radius)\1\s*:\s*/g;

const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Every spacing and radius declaration a TSX source can carry: CSS text in any string
 * (attributes and the style constants they share) and style-object keys. */
export function tsxDeclarations(source: string, file: string): ScaleDecl[] {
  const code = stripTsxComments(source);
  const ranges = styleRanges(code);
  const out: ScaleDecl[] = [];
  for (const m of code.matchAll(TSX_PROP)) {
    const at = m.index ?? 0;
    // `scroll-margin-top:`, `--gap:`: a longer name, not a guarded declaration.
    if (/[\w-]/.test(code[at - 1] ?? '')) continue;
    const prop = kebab(m[2] ?? '');
    const kind = kindOf(prop);
    if (!kind) continue;
    const valueAt = at + m[0].length;
    const first = code[valueAt] ?? '';
    let value: string;
    if (first === '"' || first === "'" || first === '`') value = readLiteral(code, valueAt).trim();
    else value = readCssValue(code, valueAt);
    const range = ranges.find((r) => at >= r.start && at < r.end);
    const tag = range?.tag;
    out.push({
      where: `${file}:${lineOf(code, at)}${tag ? ` <${tag}>` : ''} ${prop}: ${value}`,
      file,
      kind,
      prop,
      value,
      ...(range ? { tag: range.tag, style: code.slice(range.start, range.end) } : {}),
      ...(range ? { context: range.tagText } : {}),
    });
  }
  return out;
}

/* ── the rules ──────────────────────────────────────────────────────────────── */

/** Split a value at top-level whitespace and commas, keeping function calls whole. */
export function tokens(value: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  for (const c of value.replace(/!important/g, '').trim()) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (depth === 0 && /[\s,/]/.test(c)) {
      if (cur) out.push(cur);
      if (c === '/') out.push('/');
      cur = '';
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

const KEYWORDS = new Set(['0', 'auto', 'inherit', 'initial', 'unset', 'revert']);

/** Is every selector of a rule in the given list? */
const allListed = (selector: string | undefined, list: Readonly<Record<string, string>>) =>
  selector !== undefined &&
  selector.split(',').every((s) => Object.prototype.hasOwnProperty.call(list, s.trim()));

function spaceProblem(d: ScaleDecl): string | null {
  if (d.selector && allListed(d.selector, NOT_A_SPACE)) return null;
  const isPadding = d.prop.startsWith('padding');
  const control =
    isPadding &&
    (allListed(d.selector, CONTROL_PADDING) ||
      (d.tag !== undefined && CONTROL_TAGS.includes(d.tag)));
  const inset = allListed(d.selector, CONTROL_INSET);
  const bad: string[] = [];
  const check = (px: number, raw: string): void => {
    const n = Math.abs(px);
    if (SPACE_SCALE.includes(n)) return;
    if (control && DERIVED_PADDING.includes(n)) return;
    if (inset && INSET_PX.includes(n)) return;
    bad.push(raw);
  };
  for (const t of tokens(d.value)) {
    if (KEYWORDS.has(t) || t === 'X') continue;
    if (/^var\(/.test(t)) {
      // The custom property is checked where it is declared; a fallback is checked here.
      const fb = /^var\(\s*--[\w-]+\s*,\s*([\s\S]*)\)$/.exec(t)?.[1];
      if (fb !== undefined) {
        for (const n of fb.matchAll(/(-?(?:\d*\.)?\d+)px/g)) check(Number(n[1]), n[0]);
      }
      continue;
    }
    if (/^env\(/.test(t)) continue; // a device inset (the safe area), not a design value
    if (/^(?:calc|min|max|clamp)\(/.test(t)) {
      for (const n of t.matchAll(/(-?(?:\d*\.)?\d+)px/g)) check(Number(n[1]), n[0]);
      if (/\d(?:rem|em|%|vh|vw|ch)\b/.test(t)) bad.push(t);
      continue;
    }
    const px = /^(-?(?:\d*\.)?\d+)px$/.exec(t);
    if (px) {
      check(Number(px[1]), t);
      continue;
    }
    bad.push(t);
  }
  if (bad.length === 0) return null;
  return `${bad.join(', ')} is off the 4px spacing scale (${SPACE_SCALE.join(' / ')}px)`;
}

function radiusProblem(d: ScaleDecl): string | null {
  const bad: string[] = [];
  for (const t of tokens(d.value)) {
    if (t === 'X') continue;
    if (/^var\(/.test(t)) continue; // checked where the custom property is declared
    const v = t === '0px' ? '0' : t;
    if (!RADII.includes(v)) {
      bad.push(t);
      continue;
    }
    if (v === '50%') {
      const circleRule = allListed(d.selector, CIRCLE_SELECTORS);
      const circleSite =
        CIRCLE_FILES[d.file] !== undefined && d.style !== undefined && isSquare(d.style);
      if (!circleRule && !circleSite) {
        return `50% (a circle) is only for dot- and node-shaped marks (D7); a ${d.tag ? `<${d.tag}>` : 'rule'} here is not listed`;
      }
    }
    if (v === SHEET_RADIUS && !NARROW_CONTEXT.test(d.context ?? '')) {
      return `16px is the sheet radius, only below the narrow threshold`;
    }
  }
  if (bad.length === 0) return null;
  return `${bad.join(', ')} is not a locked radius (${RADII.join(' / ')})`;
}

/** A style that draws its element square: equal width and height, so 50% is a circle. */
function isSquare(style: string): boolean {
  const w = /(?:^|[\s;{,'"])width['"]?\s*:\s*['"]?(\d+)px/.exec(style)?.[1];
  const h = /(?:^|[\s;{,'"])height['"]?\s*:\s*['"]?(\d+)px/.exec(style)?.[1];
  return w !== undefined && w === h;
}

/** Every problem with one declaration; empty when it is on the scale. */
export function problems(d: ScaleDecl): string[] {
  const p = d.kind === 'space' ? spaceProblem(d) : radiusProblem(d);
  return p === null ? [] : [`${d.where} — ${p}`];
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
const cssDecls = cssDeclarations(cssSource, 'styles.css');
const tsxDecls = tsxSources.flatMap(([file, src]) => tsxDeclarations(src, file));

describe('the spacing and radius guards read what they guard (self-check)', () => {
  it('reads each spacing and radius form in the stylesheet, media and container rules included', () => {
    const css = `.a { padding: 16px 18px; gap: 7px; } @media (max-width: 768px) { .b { margin-top: 22px; } }
      @container x (max-width: 9px) { .c { border-radius: 9px; column-gap: 12px; } }
      .d { top: 22px; outline-offset: 3px; scroll-margin-top: 13px; }`;
    const found = cssDeclarations(css, 'x.css').flatMap(problems);
    expect(found).toEqual([
      expect.stringMatching(/^x\.css:1 \.a — 18px is off the 4px spacing scale/),
      expect.stringMatching(/^x\.css:1 \.a — 7px is off/),
      expect.stringMatching(/\.b \(in @media \(max-width: 768px\)\) — 22px is off/),
      expect.stringMatching(
        /\.c \(in @container x \(max-width: 9px\)\) — 9px is not a locked radius/,
      ),
    ]);
  });

  it('checks a custom property where it is declared when a guarded value uses it', () => {
    const css = `.g { --gutter: 18px; --r: 12px; padding: 0 var(--gutter); border-radius: var(--r); }
      .h { padding-bottom: calc(18px + var(--safe-area-bottom)); margin: var(--x, 6px); }`;
    const found = cssDeclarations(css, 'x.css').flatMap(problems);
    expect(found).toEqual([
      expect.stringMatching(/\.h — 18px is off/),
      expect.stringMatching(/\.h — 6px is off/),
      expect.stringMatching(/\.g --gutter — 18px is off/),
      expect.stringMatching(/\.g --r — 12px is not a locked radius/),
    ]);
  });

  it('exempts a derived control padding and a control inset only on their listed selectors', () => {
    const css = `.btn-primary { padding: 7px 13px; } .panel-x { padding: 7px 13px; }
      .btn-primary { margin-top: 7px; } .seg-track { padding: 2px; } .other { padding: 2px; }
      .btn-primary, .panel-x { padding: 3px 10px; }`;
    const found = cssDeclarations(css, 'x.css').flatMap(problems);
    expect(found).toEqual([
      expect.stringMatching(/\.panel-x — 7px, 13px is off/),
      expect.stringMatching(/\.btn-primary — 7px is off/), // a margin is not internal padding
      expect.stringMatching(/\.other — 2px is off/),
      expect.stringMatching(/\.btn-primary, \.panel-x — 3px, 10px is off/),
    ]);
  });

  it('holds circles to dots and knobs, and 16px to the narrow sheet', () => {
    const css = `.toggle-knob { border-radius: 50%; } .help { border-radius: 50%; }
      .panel { border-radius: 16px; } @media (max-width: 768px) { .sheet { border-radius: 16px 16px 0 0; } }`;
    const found = cssDeclarations(css, 'x.css').flatMap(problems);
    expect(found).toEqual([
      expect.stringMatching(/\.help — 50% \(a circle\) is only for dot- and node-shaped marks/),
      expect.stringMatching(/\.panel — 16px is the sheet radius/),
    ]);
  });

  it('reads attribute strings, style objects, constants and the element in TSX', () => {
    const tsx = [
      `const NOTE = "padding:9px 14px;color:red";`,
      `<div style="margin-top:3px;gap:8px;border-radius:7px">a</div>`,
      `<button style={{ padding: '7px 13px', 'border-radius': '6px', marginTop: '18px' }} />`,
      `<span style={{ width: '6px', height: '6px', 'border-radius': '50%' }} />`,
      `// <i style="padding:99px">commented out</i>`,
      `<i style="scroll-margin-top:13px">not a space</i>`,
    ].join('\n');
    const decls = tsxDeclarations(tsx, 'pages/X.tsx');
    expect(decls.map((d) => `${d.tag ?? '-'} ${d.prop}=${d.value}`)).toEqual([
      '- padding=9px 14px',
      'div margin-top=3px',
      'div gap=8px',
      'div border-radius=7px',
      'button padding=7px 13px',
      'button border-radius=6px',
      'button margin-top=18px',
      'span border-radius=50%',
    ]);
    const found = decls.flatMap(problems);
    expect(found).toEqual([
      expect.stringMatching(/^pages\/X\.tsx:1 padding: 9px 14px — 9px, 14px is off/),
      expect.stringMatching(/^pages\/X\.tsx:2 <div> margin-top: 3px — 3px is off/),
      expect.stringMatching(/<div> border-radius: 7px — 7px is not a locked radius/),
      expect.stringMatching(/<button> margin-top: 18px — 18px is off/),
      expect.stringMatching(/<span> border-radius: 50% — 50% \(a circle\) is only for dot/),
    ]);
    // The same dot in a listed file, drawn square, is a circle the guard admits.
    const dot = tsxDeclarations(
      `<span style={{ width: '6px', height: '6px', 'border-radius': '50%' }} />`,
      'components/Topbar.tsx',
    );
    expect(dot.flatMap(problems)).toEqual([]);
  });
});

describe('spacing comes from the 4px scale (adopt-design-tokens-v2 D6)', () => {
  it('styles.css sets every margin, padding and gap on the scale', () => {
    const spaces = cssDecls.filter((d) => d.kind === 'space');
    expect(spaces.length, 'the guard reads the stylesheet').toBeGreaterThan(100);
    expect(spaces.flatMap(problems)).toEqual([]);
  });

  it('every component inline style sets its margins, paddings and gaps on the scale', () => {
    const spaces = tsxDecls.filter((d) => d.kind === 'space');
    expect(spaces.length, 'the guard reads the components').toBeGreaterThan(200);
    expect(spaces.flatMap(problems)).toEqual([]);
  });
});

describe('corners use four locked radii (adopt-design-tokens-v2 D7)', () => {
  it('styles.css sets every border radius to 4 / 6 / 10 / 16px or a listed circle', () => {
    const radii = cssDecls.filter((d) => d.kind === 'radius');
    expect(radii.length, 'the guard reads the stylesheet').toBeGreaterThan(20);
    expect(radii.flatMap(problems)).toEqual([]);
  });

  it('every component inline style sets its border radius on the scale', () => {
    const radii = tsxDecls.filter((d) => d.kind === 'radius');
    expect(radii.length, 'the guard reads the components').toBeGreaterThan(20);
    expect(radii.flatMap(problems)).toEqual([]);
  });

  it('every listed exemption still names a rule or a file that exists', () => {
    // A stale exemption is a hole a future rule could fall through unnoticed.
    const selectors = new Set(
      cssDecls.flatMap((d) => (d.selector ?? '').split(',').map((s) => s.trim())),
    );
    for (const list of [CONTROL_PADDING, CONTROL_INSET, NOT_A_SPACE, CIRCLE_SELECTORS]) {
      for (const sel of Object.keys(list)) expect(selectors, `${sel} is listed`).toContain(sel);
    }
    const files = new Set(tsxSources.map(([f]) => f));
    for (const f of Object.keys(CIRCLE_FILES)) expect(files, `${f} is listed`).toContain(f);
    expect(PKG).toBeTruthy();
  });
});

describe('the lock states the spacing and radius values styles.css uses (STYLESEED.md)', () => {
  // STYLESEED.md and styles.css change together, never one alone (adopt-design-tokens-v2
  // task 3.5): each lock value below is compared with the literal the stylesheet declares.
  const lock = readFileSync(join(PKG, '..', '..', 'STYLESEED.md'), 'utf8').split('\n');
  const lockLine = (prefix: string): string => lock.find((l) => l.startsWith(prefix)) ?? '';
  const lockRow = (token: string): string => lock.find((l) => l.startsWith(`| \`${token}\``)) ?? '';
  const { all } = cssScan(cssSource, 'styles.css');
  const NARROW = '@media (max-width: 768px)';
  /** The value a rule declares, at the top level or inside the narrow query. */
  const decl = (selector: string, prop: string, narrow = false): string => {
    const hit = all.find(
      (d) =>
        d.selector === selector &&
        d.name === prop &&
        (narrow ? d.context === NARROW : d.context === ''),
    );
    expect(
      hit,
      `styles.css declares ${prop} on ${selector}${narrow ? ' below narrow' : ''}`,
    ).toBeDefined();
    return hit?.value ?? '';
  };

  it('L10 names the four radii the guard admits, and the stylesheet uses each of them', () => {
    const l10 = lockLine('- Radius personality:');
    const named = /(\d+) \/ (\d+) \/ (\d+) \/ (\d+)px \(mark \/ control \/ surface \/ sheet\)/.exec(
      l10,
    );
    expect(named, `L10 states the radii by role: "${l10}"`).not.toBeNull();
    const radii = named!.slice(1).map((n) => `${n}px`);
    expect(radii).toEqual(RADII.filter((r) => r.endsWith('px')));
    const used = new Set(
      cssDecls.filter((d) => d.kind === 'radius').flatMap((d) => tokens(d.value)),
    );
    for (const r of radii.slice(0, 3)) expect(used, `styles.css uses the ${r} radius`).toContain(r);
    expect(decl('.drawer, .modal-card, .confirm-card', '--sheet-radius', true)).toBe(radii[3]);
    expect(lockRow('sheet-radius')).toContain(`**${radii[3] ?? ''}**`);
  });

  it('L12 states the card padding, the gutter and the 4px scale the stylesheet uses', () => {
    const l12 = lockLine('- Density:');
    expect(l12).toContain(`${decl('.card', 'padding')} card padding`);
    expect(l12).toContain(`${decl('.rs-page', 'padding')} gutter`);
    const scale = /4px scale \(([\d /]+)px\)/.exec(l12)?.[1]?.split(' / ').map(Number);
    expect(scale, 'L12 lists the 4px scale').toEqual([...SPACE_SCALE]);
  });

  it('the narrow rows (gutter-narrow, density-narrow) equal the narrow declarations', () => {
    expect(lockRow('gutter-narrow')).toContain(`**${decl('.rs-page', 'padding', true)}**`);
    const density = /`\.card` `([^`]+)` → \*\*`([^`]+)`\*\*/.exec(lockRow('density-narrow'));
    expect(density, 'density-narrow states the card padding move').not.toBeNull();
    expect(density?.[1]).toBe(decl('.card', 'padding'));
    expect(density?.[2]).toBe(decl('.card', 'padding', true));
  });

  it('sheet-padding equals the narrow sheet padding, and the drawer body its own', () => {
    const row = lockRow('sheet-padding');
    const sheet = decl('.modal-card, .confirm-card', 'padding', true);
    // `20px 16px calc(20px + var(--safe-area-bottom))`: block, inline, then the safe area.
    const [top, inline, bottom] = tokens(sheet);
    expect(row).toContain(`**${top ?? ''} ${inline ?? ''}**`);
    expect(bottom).toBe(`calc(${top ?? ''} + var(--safe-area-bottom))`);
    const drawer = decl('.drawer-body', 'padding');
    expect(row).toContain(`own \`${drawer}\` body`);
    expect(decl('.drawer-body', 'padding-bottom', true)).toBe(
      `calc(${drawer} + var(--safe-area-bottom))`,
    );
  });

  it('density-narrow\'s "gaps unchanged": no gap is re-declared below narrow to another value', () => {
    // dashboard-core "Narrow width changes only the gutter and the card padding … every gap
    // keeps its desktop value". A rule that re-declares a gap inside a narrow query must restate
    // its own desktop value. Compared per axis: `gap` sets both, `row-gap` / `column-gap` one.
    expect(lockRow('density-narrow')).toContain('gaps unchanged');
    const GAP = /^(?:gap|row-gap|column-gap)$/;
    const axes = (prop: string, value: string): Record<'row' | 'column', string | undefined> => {
      if (prop === 'row-gap') return { row: value, column: undefined };
      if (prop === 'column-gap') return { row: undefined, column: value };
      const [row, column] = tokens(value);
      return { row, column: column ?? row };
    };
    const desktop = (selector: string): Record<'row' | 'column', string> => {
      const out = { row: 'normal', column: 'normal' };
      for (const d of all.filter(
        (x) => x.selector === selector && x.context === '' && GAP.test(x.name),
      )) {
        const a = axes(d.name, d.value);
        if (a.row !== undefined) out.row = a.row;
        if (a.column !== undefined) out.column = a.column;
      }
      return out;
    };
    const changed: string[] = [];
    const excepted = new Set<string>();
    for (const d of all.filter((x) => NARROW_CONTEXT.test(x.context) && GAP.test(x.name))) {
      // A selector that exists only below narrow (the collapsed rail) has no desktop value.
      if (!all.some((x) => x.selector === d.selector && x.context === '')) continue;
      const want = desktop(d.selector);
      const got = axes(d.name, d.value);
      for (const axis of ['row', 'column'] as const) {
        const v = got[axis];
        if (v === undefined || v === want[axis]) continue;
        if (d.selector in NARROW_GAP_EXCEPTIONS) {
          excepted.add(d.selector);
          continue;
        }
        changed.push(`${d.where}: ${axis} gap ${v} below narrow, ${want[axis]} at desktop`);
      }
    }
    expect(changed, changed.join('\n')).toEqual([]);
    // A stale exception is a hole: each listed rule must still differ.
    expect([...excepted].sort()).toEqual(Object.keys(NARROW_GAP_EXCEPTIONS).sort());
  });

  it('toast-offset equals the toast offset at every width', () => {
    const offset = /\*\*(\d+px)\*\*/.exec(lockRow('toast-offset'))?.[1];
    expect(offset, 'the lock has a toast-offset row').toBeDefined();
    expect(decl('.toast', 'bottom')).toBe(offset);
    expect(decl('.toast', 'bottom', true)).toMatch(new RegExp(`^calc\\(${offset ?? '?'} \\+`));
  });
});
