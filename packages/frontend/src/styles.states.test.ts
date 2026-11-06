import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The state matrix, read from the stylesheet (adopt-design-tokens-v2 tasks 4.3 and 4.5;
 * design.md D14 / D19; dashboard-core "Every button shows pressed and busy states" and
 * "Selectable controls, fields and the endpoint chip show their hover and pressed states").
 *
 * happy-dom cannot force `:hover` or `:active`, so the rules are read as declarations and the
 * cascade between them is decided here the way the browser decides it: by specificity, then
 * by source order. That is what "a current item keeps its Selected state through hover and
 * press" depends on, and an order-only win would break the day a rule moves.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(SRC, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

interface Rule {
  selector: string;
  body: string;
  /** Position in the sheet — the cascade's tiebreak. */
  order: number;
  /** The enclosing at-rules, e.g. `@media (max-width: 768px)`; empty at the top level. */
  context: string;
}

/** Every leaf rule, with the at-rules it sits in (a brace-depth scan, so a rule inside a
 * media query is not mistaken for a top-level one). */
function leafRules(source: string): Rule[] {
  const out: Rule[] = [];
  const stack: string[] = [];
  let i = 0;
  let order = 0;
  let start = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '{') {
      const prelude = source.slice(start, i).trim();
      const close = source.indexOf('}', i);
      const nextOpen = source.indexOf('{', i + 1);
      if (prelude.startsWith('@') || (nextOpen !== -1 && nextOpen < close)) {
        stack.push(prelude);
        i += 1;
        start = i;
        continue;
      }
      for (const sel of prelude.split(',')) {
        out.push({
          selector: sel.trim().replace(/\s+/g, ' '),
          body: source.slice(i + 1, close),
          order: (order += 1),
          context: stack.filter((p) => p.startsWith('@')).join(' '),
        });
      }
      i = close + 1;
      start = i;
      continue;
    }
    if (ch === '}') {
      stack.pop();
      i += 1;
      start = i;
      continue;
    }
    i += 1;
  }
  return out;
}

const RULES = leafRules(css);
const TOP = RULES.filter((r) => r.context === '');

function decl(body: string, property: string): string | null {
  const m = new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+);`).exec(body);
  return m ? (m[1] as string).replace(/\s*!important/, '').trim() : null;
}

/** The one top-level rule with exactly this selector. */
function rule(selector: string): Rule {
  const found = TOP.filter((r) => r.selector === selector);
  expect(found, `exactly one top-level rule for ${selector}`).toHaveLength(1);
  return found[0] as Rule;
}

/** [ids, classes + attributes + pseudo-classes, elements] — enough for the compound
 * selectors these controls use (no `:is()`/`:not()` arguments are counted here). */
function specificity(selector: string): [number, number, number] {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
  const elements = (selector.replace(/\[[^\]]+\]/g, '').match(/(?:^|[\s>+~])[a-z][\w-]*/gi) ?? [])
    .length;
  return [ids, classes, elements];
}
const outranks = (a: [number, number, number], b: [number, number, number]): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** An element in `state`: its base class, and the attribute and pseudo-classes it carries.
 * Returns the background the cascade gives it, from the top-level rules naming that class. */
function winningBackground(
  base: string,
  attrs: readonly string[],
  pseudos: readonly string[],
): string {
  const candidates = TOP.filter((r) => {
    if (!new RegExp(`^\\${base}(?![\\w-])`).test(r.selector)) return false;
    const rest = r.selector.slice(base.length);
    if (/[\s>+~]/.test(rest)) return false; // a descendant, not the control itself
    const needAttrs = rest.match(/\[[^\]]+\]/g) ?? [];
    const needPseudos = rest.replace(/\[[^\]]+\]/g, '').match(/:[\w-]+/g) ?? [];
    return (
      needAttrs.every((a) => attrs.includes(a)) && needPseudos.every((p) => pseudos.includes(p))
    );
  }).filter((r) => decl(r.body, 'background') !== null);
  expect(
    candidates.length,
    `${base} has a background rule for ${[...attrs, ...pseudos].join('')}`,
  ).toBeGreaterThan(0);
  const best = candidates.reduce((a, b) => {
    const c = outranks(specificity(b.selector), specificity(a.selector));
    return c > 0 || (c === 0 && b.order > a.order) ? b : a;
  });
  return decl(best.body, 'background') as string;
}

describe('every button variant has a pressed tone that applies at once (task 4.3)', () => {
  const PRESSED: Record<string, string> = {
    '.btn-primary': 'var(--accent-fill-pressed)',
    '.btn-cancel': 'var(--chip)',
    '.btn-ghost': 'var(--accent-bg)',
    '.btn-ghost--amber': 'var(--amber-bg)',
  };
  for (const [variant, fill] of Object.entries(PRESSED)) {
    it(`${variant}:active takes ${fill} with no transition`, () => {
      const r = rule(`${variant}:active`);
      expect(decl(r.body, 'background')).toBe(fill);
      expect(decl(r.body, 'transition'), `${variant}:active must not ease`).toBe('none');
    });
  }

  it('ghost hover is deep indigo, secondary hover the hover tone with Ink text', () => {
    const ghost = rule('.btn-ghost:hover');
    expect(decl(ghost.body, 'border-color')).toBe('var(--accent-deep)');
    expect(decl(ghost.body, 'color')).toBe('var(--accent-deep)');
    const secondary = rule('.btn-cancel:hover');
    expect(decl(secondary.body, 'background')).toBe('var(--hover)');
    expect(decl(secondary.body, 'color')).toBe('var(--text)');
  });

  it('disabled is native at 60%, and busy keeps full opacity', () => {
    expect(decl(rule('button:disabled').body, 'opacity')).toBe('0.6');
    expect(decl(rule("button:disabled[aria-busy='true']").body, 'opacity')).toBe('1');
  });

  it('no button state lifts, glows or scales: no transform, filter or box-shadow', () => {
    const offenders = RULES.filter((r) => /\.btn-(primary|cancel|ghost)/.test(r.selector)).flatMap(
      (r) =>
        ['transform', 'filter', 'box-shadow']
          .filter((p) => decl(r.body, p) !== null)
          .map((p) => `${r.selector} { ${p}: ${decl(r.body, p) ?? ''} }`),
    );
    expect(offenders).toEqual([]);
  });
});

describe('selectable controls: hover tone, then the chip tone at once (task 4.5)', () => {
  const SELECTABLE: readonly { base: string; selected: string; selectedFill: string }[] = [
    { base: '.nav-item', selected: "[aria-current='page']", selectedFill: 'var(--accent-bg)' },
    { base: '.rs-seg', selected: "[aria-pressed='true']", selectedFill: 'var(--accent-bg)' },
    { base: '.filter-chip', selected: "[aria-pressed='true']", selectedFill: 'var(--accent-bg)' },
    { base: '.kind-card', selected: "[aria-pressed='true']", selectedFill: 'var(--accent-bg)' },
  ];

  for (const { base, selected, selectedFill } of SELECTABLE) {
    it(`${base}: :hover is --hover and :active is --chip with no transition`, () => {
      expect(decl(rule(`${base}:hover`).body, 'background')).toBe('var(--hover)');
      const active = rule(`${base}:active`);
      expect(decl(active.body, 'background')).toBe('var(--chip)');
      expect(decl(active.body, 'transition')).toBe('none');
    });

    it(`${base}: the selected rule outranks :hover and :active, so the selection holds`, () => {
      expect(winningBackground(base, [], [':hover'])).toBe('var(--hover)');
      expect(winningBackground(base, [], [':active'])).toBe('var(--chip)');
      expect(winningBackground(base, [selected], [])).toBe(selectedFill);
      expect(winningBackground(base, [selected], [':hover'])).toBe(selectedFill);
      expect(winningBackground(base, [selected], [':active'])).toBe(selectedFill);
      expect(winningBackground(base, [selected], [':hover', ':active'])).toBe(selectedFill);
    });
  }

  it('a selected segment wins by specificity, not only by source order', () => {
    const hover = specificity('.rs-seg:hover');
    const selectedHover = specificity(".rs-seg[aria-pressed='true']:hover");
    expect(outranks(selectedHover, hover)).toBeGreaterThan(0);
  });
});

describe("a field's edge answers the pointer (task 4.5)", () => {
  it('inputs, selects, textareas and the combobox input take --text3 on hover', () => {
    for (const sel of ['.input:hover', '.select:hover', '.mp-input:hover', 'textarea:hover']) {
      expect(decl(rule(sel).body, 'border-color'), sel).toBe('var(--text3)');
    }
  });
  it('and the accent on focus, which outranks the hover edge', () => {
    for (const sel of ['input:focus', 'select:focus', 'textarea:focus']) {
      const r = rule(sel);
      expect(decl(r.body, 'border-color'), sel).toBe('var(--accent)');
      expect(r.body, `${sel} wins over a hovered field's class rule`).toMatch(/!important/);
    }
  });
});

describe('the endpoint chip: a deep-indigo edge on hover, the wash while pressed (task 4.5)', () => {
  it('hover is an --accent-deep border with Ink text', () => {
    const r = rule('.endpoint-chip:hover');
    expect(decl(r.body, 'border-color')).toBe('var(--accent-deep)');
    expect(decl(r.body, 'color')).toBe('var(--text)');
  });
  it('pressed is the indigo wash with no transition', () => {
    const r = rule('.endpoint-chip:active');
    expect(decl(r.body, 'background')).toBe('var(--accent-bg)');
    expect(decl(r.body, 'transition')).toBe('none');
  });
});

describe('the parser reads the cascade it claims to (self-checks)', () => {
  it('ranks an attribute + pseudo above a lone pseudo, and breaks a tie by order', () => {
    expect(outranks(specificity(".a[x='1']:hover"), specificity('.a:hover'))).toBeGreaterThan(0);
    expect(outranks(specificity('.a:hover'), specificity('.a:active'))).toBe(0);
  });
  it('keeps a rule inside a media query out of the top-level set', () => {
    const rules = leafRules(
      '.a { color: red; } @media (max-width: 1px) { .a:hover { color: blue; } }',
    );
    expect(rules.map((r) => [r.selector, r.context])).toEqual([
      ['.a', ''],
      ['.a:hover', '@media (max-width: 1px)'],
    ]);
  });
});

describe('the lock states the switch and height-family sizes styles.css uses (STYLESEED.md)', () => {
  // adopt-design-tokens-v2 tasks 5.3 and 4.1 (D17's `switch` and `height-family` rows): the
  // lock and the stylesheet move together, so each lock figure is read and compared with the
  // rule that draws it.
  const lock = readFileSync(join(SRC, '..', '..', '..', 'STYLESEED.md'), 'utf8');
  const row = (token: string): string => {
    const m = new RegExp(`^\\| \`${token}\` \\|([^\\n]*)$`, 'm').exec(lock);
    expect(m, `the lock has a ${token} row`).not.toBeNull();
    return m![1]!;
  };
  /** The value the cascade keeps for a top-level selector: the last declaration of it. */
  const px = (selector: string, property: string): number => {
    const values = TOP.filter((r) => r.selector === selector)
      .map((r) => decl(r.body, property))
      .filter((v): v is string => v !== null);
    expect(values.length, `${selector} declares ${property}`).toBeGreaterThan(0);
    return parseFloat(values[values.length - 1]!);
  };

  it('the switch row names the sizes the toggle--md / toggle--sm rules draw', () => {
    const r = row('switch');
    const md = /\*\*(\d+)×(\d+)\*\* drawn track/.exec(r);
    const sm = /\(\*\*(\d+)×(\d+)\*\* small\)/.exec(r);
    expect(md, 'the switch row states the medium track').not.toBeNull();
    expect(sm, 'the switch row states the small track').not.toBeNull();
    expect([Number(md![1]), Number(md![2])]).toEqual([
      px('.toggle--md', 'width'),
      px('.toggle--md', 'height'),
    ]);
    expect([Number(sm![1]), Number(sm![2])]).toEqual([
      px('.toggle--sm', 'width'),
      px('.toggle--sm', 'height'),
    ]);
    const knobs = /(\d+) \/ (\d+)px knob inset (\d+)px/.exec(r);
    expect(knobs, 'the switch row states the knobs').not.toBeNull();
    expect(Number(knobs![1])).toBe(px('.toggle--md .toggle-knob', 'width'));
    expect(Number(knobs![2])).toBe(px('.toggle--sm .toggle-knob', 'width'));
    expect(Number(knobs![3])).toBe(px('.toggle-knob', 'top'));
    const radius = /(\d+)px radius/.exec(r);
    expect(Number(radius![1])).toBe(px('.toggle', 'border-radius'));
    const hit = /hit area \*\*(\d+)px\*\* tall at desktop/.exec(r);
    expect(Number(hit![1])).toBe(px('.toggle::before', 'height'));
  });

  it('the comfort paragraph states the same switch sizes, and no longer 30×17', () => {
    expect(lock).not.toMatch(/30×17/);
    expect(lock).toMatch(/36×20 drawn track \(32×18 small\)/);
  });

  it('the height-family row names the min-heights the family block declares', () => {
    const r = row('height-family');
    const figure = (label: string): number => {
      const m = new RegExp(`\\*\\*(\\d+)px\\*\\* ${label}`).exec(r);
      expect(m, `the height-family row states the ${label} height`).not.toBeNull();
      return Number(m![1]);
    };
    expect(figure('default')).toBe(px('.btn-primary', 'min-height'));
    expect(figure('small')).toBe(px('.btn-ghost', 'min-height'));
    // The small select is a named member of the 24px row (review fix): the lock names it, and
    // its rem-relative height is the small figure at the default 16px root.
    expect(r).toContain('`select--sm`');
    const rem = (selector: string, property: string): number => {
      const values = TOP.filter((x) => x.selector === selector)
        .map((x) => decl(x.body, property))
        .filter((v): v is string => v !== null);
      const v = values[values.length - 1] ?? '';
      const m = /^calc\(1rem \+ (\d+)px\)$/.exec(v);
      expect(
        m,
        `${selector} ${property} is a 1rem line plus its padding and edge: "${v}"`,
      ).not.toBeNull();
      return 16 + Number(m![1]);
    };
    expect(rem('.select--sm', 'height')).toBe(figure('small'));
    expect(rem('.select--sm', 'min-height')).toBe(figure('small'));
    expect(rem('.select', 'height')).toBe(figure('default'));
    expect(figure('segmented option')).toBe(px('.rs-seg', 'min-height'));
    // The static chip has no min-height: 2 + 16 + 2 is its 20px.
    const chip = TOP.filter((x) => x.selector === '.chip')
      .map((x) => x.body)
      .join(';');
    expect(figure('static chip')).toBe(
      2 * parseFloat(decl(chip, 'padding') ?? '0') +
        parseFloat(decl(chip, 'line-height') ?? '0') * 16,
    );
  });
});
