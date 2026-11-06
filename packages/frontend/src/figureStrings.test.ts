/**
 * The retired figure spellings cannot return (adopt-figure-states task 6.1, design D9;
 * dashboard-core "An estimate is marked by its axis, never by a tilde", scenario "The retired
 * marker cannot return").
 *
 * DESIGN.md v2 gives every figure state one spelling, and `data/figures.ts` owns it. Each
 * retired spelling below shipped somewhere before this change, and each now fails a test,
 * naming the file, the line and the offending text, instead of depending on review:
 *
 * - **`~`** in any painted text: the retired estimate marker (`~`, `~est`, `~estimated`). A
 *   price estimate reads `· est.` and a usage estimate `· est. usage`. Read from the parsed
 *   string, template and JSX text, so a bitwise `~` in code is not text. Any tilde is caught,
 *   not only one beside a figure or `est`: a `~` that means "about" is itself an estimate mark.
 * - **`< $`**, the spaced below-precision form. The vocabulary's is `<$0.0001` / `<$0.01`.
 * - **`— unpriced`**. An unpriced figure is the bare word.
 * - **`up to $`**. A reserved ceiling reads `≤ $x`.
 * - **A bare `'—'` returned from a cost or share formatter.** A lone dash means pending only
 *   (`PENDING`); a zero denominator reads `not applicable` and a null cost `unpriced`. "A cost
 *   or share formatter" is read from the names around the literal: the expression it is a
 *   branch of (`spend === null ? '—' : spend`), the property or variable it initialises
 *   (`share: …`, `const rate = …`), or the function it is returned from (`shareOf`). The figure
 *   words are listed in `FIGURE_WORDS`. A dash placeholder for an identifier (a tier, model,
 *   provider, email or base URL) names none of them and is not a figure.
 * - **`free` as a whole price label**, checked only at the price-label call sites
 *   (`PRICE_LABEL_SITES`) and the same-file declarations each one reads. A free price reads
 *   `$0 free` through `priceLabelParts`; `kind: 'free'` and `x.kind === 'free'` are
 *   discriminants, not labels.
 * - **A worded `· estimate` on a price label**, checked at the same sites. An estimated price
 *   label carries `· est.` (`priceLabelParts`); provenance prose beside it, such as
 *   `provider-listed · estimate`, is not a price-label site.
 *
 * The text is exactly what `glyphCoverage.test.ts` reads (`test/renderedText.ts`): shipped
 * sources, comments removed, accessible names blanked. Prose components are skipped through
 * `PROSE`, a documented and bounded allowlist: prose is outside the figure rules (dashboard-core
 * "Every figure slot names its state in words").
 */
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { findSrc, renderedText, shippedSources } from './test/renderedText';

const SRC = findSrc();

type Rule =
  | 'tilde'
  | 'spaced-below-precision'
  | 'dash-before-unpriced'
  | 'up-to-ceiling'
  | 'bare-dash'
  | 'whole-free'
  | 'worded-estimate';

const RULE_TEXT: Readonly<Record<Rule, string>> = {
  tilde:
    '`~` is the retired estimate marker: a price estimate reads `· est.`, a usage estimate `· est. usage`',
  'spaced-below-precision': 'below display precision reads `<$0.0001` / `<$0.01`, with no space',
  'dash-before-unpriced': 'an unpriced figure is the bare word `unpriced`, never `— unpriced`',
  'up-to-ceiling': 'a reserved ceiling reads `≤ $x`, never `up to $x`',
  'bare-dash':
    'a cost or share formatter never returns a bare `—`: a lone dash means pending (`PENDING`), a zero denominator reads `not applicable`, a null cost `unpriced`',
  'whole-free':
    '`free` is never a whole price label: a free price reads `$0 free` (`priceLabelParts`)',
  'worded-estimate':
    'an estimated price label carries `· est.` in Ink 3 (`priceLabelParts`), never a worded `· estimate`',
};

interface Offence {
  readonly file: string;
  readonly line: number;
  readonly rule: Rule;
  readonly text: string;
}

/** Prose components the guard skips, each with its reason. Keyed by file and bounded: every
 * entry must be a shipped source, must not be a price-label call site, and must still be
 * load-bearing (a rule fires there without the exemption), so a stale entry fails. */
const PROSE: ReadonlyMap<string, string> = new Map([
  [
    'components/BatchModeHelp.tsx',
    'Help sentences, not figure slots: its `free` completes "synchronous is free", its ' +
      '`up to ${BATCH_COMPLETION_WINDOW_TEXT}` reads "up to 24 hours" (a duration), and its ' +
      '`usd` helper prints unit prices inside those sentences (task 6.2 lists it as an exception).',
  ],
]);

/** The functions that build a price label (design D9). Each must exist: a rename would
 * otherwise switch its check off without a word. */
const PRICE_LABEL_SITES: readonly { readonly file: string; readonly name: string }[] = [
  { file: 'pages/Routing.tsx', name: 'modelPriceLabel' },
  { file: 'pages/Providers.tsx', name: 'priceText' },
  { file: 'pages/Providers.tsx', name: 'batchRateText' },
  { file: 'components/BarRows.tsx', name: 'BarRows' },
  { file: 'data/analytics.ts', name: 'rowCostLabel' },
];

/** Words that make a name a cost or share figure's. Compared per camelCase / snake_case word,
 * singular or plural, so `fmtSpend`, `shareOf`, `modalShare` and `micros` match, and
 * `tierAssigned`, `modelLabel` or `generate` do not. */
const FIGURE_WORDS: ReadonlySet<string> = new Set([
  'amount',
  'ceiling',
  'cost',
  'micro',
  'money',
  'pct',
  'percent',
  'percentage',
  'price',
  'rate',
  'saving',
  'share',
  'spend',
  'usd',
]);

/** Regex rules on the rendered lines. These forms are spelled across a template's literal
 * text and its interpolation (`` `up to ${money(x)}` ``), so they are read as source text. */
const LINE_RULES: readonly { readonly rule: Rule; readonly pattern: RegExp }[] = [
  { rule: 'spaced-below-precision', pattern: /<\s+\$/ },
  { rule: 'dash-before-unpriced', pattern: /—\s*unpriced/ },
  { rule: 'up-to-ceiling', pattern: /\bup to\s+\$/i },
];

const EQUALITY: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

const PASS_THROUGH_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
]);

function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w !== '')
    .map((w) => w.toLowerCase());
}

const namesFigure = (name: string): boolean =>
  words(name).some(
    (w) => FIGURE_WORDS.has(w) || (w.endsWith('s') && FIGURE_WORDS.has(w.slice(0, -1))),
  );

function propertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null;
}

function identifiersIn(node: ts.Node): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) out.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** A function's own name, or the name of the variable or property that holds it. */
function functionName(f: ts.SignatureDeclaration): string | null {
  if (
    (ts.isFunctionDeclaration(f) || ts.isFunctionExpression(f) || ts.isMethodDeclaration(f)) &&
    f.name !== undefined &&
    ts.isIdentifier(f.name)
  )
    return f.name.text;
  const p = f.parent;
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (ts.isPropertyAssignment(p)) return propertyName(p.name);
  return null;
}

function enclosingFunctionName(node: ts.Node): string | null {
  for (let n: ts.Node | undefined = node; n !== undefined; n = n.parent) {
    if (ts.isFunctionLike(n)) return functionName(n);
  }
  return null;
}

/** The names a literal stands for: the expression it is a branch of, then what holds that
 * expression (a property, a variable, an assignment, or the function it is returned from). */
function contextNames(literal: ts.Node): string[] {
  let top: ts.Node = literal;
  for (;;) {
    const p = top.parent;
    const passes =
      ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isSatisfiesExpression(p) ||
      ts.isNonNullExpression(p) ||
      (ts.isConditionalExpression(p) && (p.whenTrue === top || p.whenFalse === top)) ||
      (ts.isBinaryExpression(p) && PASS_THROUGH_OPERATORS.has(p.operatorToken.kind));
    if (!passes) break;
    top = p;
  }
  const names = identifiersIn(top);
  const holder = top.parent;
  if (ts.isPropertyAssignment(holder) && holder.initializer === top) {
    const n = propertyName(holder.name);
    if (n !== null) names.push(n);
  } else if (ts.isVariableDeclaration(holder) && holder.initializer === top) {
    if (ts.isIdentifier(holder.name)) names.push(holder.name.text);
  } else if (
    ts.isBinaryExpression(holder) &&
    holder.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    holder.right === top
  ) {
    names.push(...identifiersIn(holder.left));
  } else if (ts.isReturnStatement(holder) || (ts.isArrowFunction(holder) && holder.body === top)) {
    const n = enclosingFunctionName(holder);
    if (n !== null) names.push(n);
  }
  return names;
}

/** `kind: 'free'`, `x.kind === 'free'`, `case 'free':` and a `'free'` type name a variant. */
function isDiscriminant(n: ts.Node): boolean {
  const p = n.parent;
  if (ts.isPropertyAssignment(p) && p.initializer === n) return propertyName(p.name) === 'kind';
  if (ts.isBinaryExpression(p)) return EQUALITY.has(p.operatorToken.kind);
  if (ts.isCaseClause(p)) return p.expression === n;
  return ts.isLiteralTypeNode(p);
}

type TextNode =
  ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateLiteralLikeNode | ts.JsxText;

/** Every string, template and JSX text under `root`. */
function textNodes(root: ts.Node): TextNode[] {
  const out: TextNode[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n) ||
      ts.isJsxText(n)
    )
      out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

/** A top-level function or variable declaration of `sf`, by name. */
function topLevel(sf: ts.SourceFile, name: string): ts.Node | null {
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name?.text === name) return s;
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name) return d;
      }
    }
  }
  return null;
}

const scriptKind = (rel: string): ts.ScriptKind =>
  rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;

/** Every retired spelling in one file. `rel` is the path under `src/`. */
function scanFile(rel: string, source: string): Offence[] {
  const text = renderedText(source);
  const offences: Offence[] = [];

  text.split('\n').forEach((line, i) => {
    for (const { rule, pattern } of LINE_RULES) {
      if (pattern.test(line)) offences.push({ file: rel, line: i + 1, rule, text: line.trim() });
    }
  });

  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKind(rel));
  const at = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const report = (rule: Rule, n: ts.Node): void => {
    offences.push({ file: rel, line: at(n), rule, text: n.getText(sf).trim() });
  };

  for (const n of textNodes(sf)) {
    if (n.text.includes('~')) report('tilde', n);
    if (
      (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
      n.text.trim() === '—' &&
      contextNames(n).some(namesFigure)
    )
      report('bare-dash', n);
  }

  for (const site of PRICE_LABEL_SITES.filter((s) => s.file === rel)) {
    const fn = topLevel(sf, site.name);
    if (fn === null) {
      offences.push({
        file: rel,
        line: 1,
        rule: 'whole-free',
        text: `price-label call site \`${site.name}\` not found`,
      });
      continue;
    }
    // The site, plus the same-file declarations it reads (`BarRows` renders `FREE_PARTS`).
    const scope = new Set<ts.Node>([fn]);
    for (const id of identifiersIn(fn)) {
      const decl = id === site.name ? null : topLevel(sf, id);
      if (decl !== null) scope.add(decl);
    }
    for (const root of scope) {
      for (const n of textNodes(root)) {
        if (n.text.trim().toLowerCase() === 'free' && !isDiscriminant(n)) report('whole-free', n);
        if (/·\s*estimate\b/i.test(n.text)) report('worded-estimate', n);
      }
    }
  }
  return offences;
}

const describeOffences = (offences: readonly Offence[]): string =>
  offences.map((o) => `${o.file}:${String(o.line)}  [${o.rule}]  ${o.text}`).join('\n') +
  '\n\n' +
  [...new Set(offences.map((o) => o.rule))].map((r) => `${r}: ${RULE_TEXT[r]}`).join('\n');

const relOf = (file: string): string => file.replace(SRC, '');

describe('the retired figure spellings cannot return (adopt-figure-states D9)', () => {
  it('no shipped source renders a retired figure spelling', () => {
    const offences: Offence[] = [];
    for (const file of shippedSources(SRC)) {
      const rel = relOf(file);
      if (PROSE.has(rel)) continue;
      offences.push(...scanFile(rel, readFileSync(file, 'utf8')));
    }
    expect(offences, `retired figure spellings:\n${describeOffences(offences)}`).toEqual([]);
  });

  it('every price-label call site is still where the free rule reads it', () => {
    const shipped = new Set(shippedSources(SRC).map(relOf));
    for (const site of PRICE_LABEL_SITES) {
      expect(shipped.has(site.file), `${site.file} is not a shipped source`).toBe(true);
      const src = renderedText(readFileSync(SRC + site.file, 'utf8'));
      const sf = ts.createSourceFile(
        site.file,
        src,
        ts.ScriptTarget.Latest,
        true,
        scriptKind(site.file),
      );
      expect(
        topLevel(sf, site.name),
        `${site.file} no longer declares ${site.name}`,
      ).not.toBeNull();
    }
  });

  it('the prose allowlist is bounded: each entry is a shipped prose file the guard would flag', () => {
    const shipped = new Set(shippedSources(SRC).map(relOf));
    const siteFiles = new Set(PRICE_LABEL_SITES.map((s) => s.file));
    for (const [file, reason] of PROSE) {
      expect(shipped.has(file), `${file} is not a shipped source`).toBe(true);
      expect(siteFiles.has(file), `${file} is a price-label call site, not prose`).toBe(false);
      expect(reason.length, `${file} needs a reason`).toBeGreaterThan(0);
      expect(
        scanFile(file, readFileSync(SRC + file, 'utf8')),
        `${file} trips no rule, so its exemption is stale`,
      ).not.toEqual([]);
    }
  });
});

describe('the guard can fail (each rule, on a planted sample)', () => {
  const rules = (rel: string, src: string): Rule[] => scanFile(rel, src).map((o) => o.rule);

  it('flags a tilde in a string, a template or JSX text, and names the line', () => {
    expect(scanFile('data/x.ts', `const a = 1;\nconst m = '~';`)).toEqual([
      { file: 'data/x.ts', line: 2, rule: 'tilde', text: `'~'` },
    ]);
    expect(rules('a.tsx', `const v = \`\${n} flagged ~estimated\`;`)).toEqual(['tilde']);
    expect(rules('a.tsx', `const e = <span>{n} requests ~estimated</span>;`)).toEqual(['tilde']);
    expect(rules('a.tsx', `const e = <b>{x ? ' ~est' : ''}</b>;`)).toEqual(['tilde']);
  });

  it('does not flag a bitwise tilde, a comment or an accessible name', () => {
    expect(rules('a.ts', `const i = ~list.indexOf(x); // about ~2x`)).toEqual([]);
    expect(rules('a.ts', `/** a ~ in JSDoc */\nconst x = 1;`)).toEqual([]);
    expect(rules('a.tsx', `const e = <b aria-label="~3 left" title={\`~\${n}\`}>x</b>;`)).toEqual(
      [],
    );
  });

  it('flags the spaced below-precision form, a dash before unpriced and `up to $`', () => {
    expect(rules('a.ts', `const s = '< $0.0001';`)).toEqual(['spaced-below-precision']);
    expect(rules('a.ts', `const s = 'batch rate — unpriced';`)).toEqual(['dash-before-unpriced']);
    expect(rules('a.ts', 'const s = `up to ${fmtMoney(c)}`;')).toEqual(['up-to-ceiling']);
    expect(rules('a.ts', `const s = 'up to $3.00';`)).toEqual(['up-to-ceiling']);
  });

  it('accepts the vocabulary’s own spellings', () => {
    expect(
      rules(
        'a.ts',
        `const a = '<$0.0001'; const b = 'unpriced'; const c = \`≤ \${ceilingMoney(m)}\`;\n` +
          `const d = 'unpriced — cost not tracked'; const e = '· est.'; const f = '· est. usage';`,
      ),
    ).toEqual([]);
  });

  it('flags a bare dash returned from a cost or share formatter', () => {
    expect(
      rules('a.ts', `function shareOf(n: number, d: number) { return d === 0 ? '—' : 'x'; }`),
    ).toEqual(['bare-dash']);
    expect(rules('a.ts', `const rate = e.rate === null ? '—' : pct(e.rate);`)).toEqual([
      'bare-dash',
    ]);
    expect(rules('a.ts', `const f = { share: exit === null ? null : '—' };`)).toEqual([
      'bare-dash',
    ]);
    expect(rules('a.tsx', `const e = <td>{r.spend === null ? '—' : r.spend}</td>;`)).toEqual([
      'bare-dash',
    ]);
    expect(rules('a.tsx', `const e = <td>{loaded ? fmtSpend(s) : '—'}</td>;`)).toEqual([
      'bare-dash',
    ]);
    expect(
      rules('a.ts', `const fmtCost = (m: number | null) => (m === null ? '—' : 'x');`),
    ).toEqual(['bare-dash']);
  });

  it('leaves an identifier’s dash placeholder and the PENDING constant alone', () => {
    expect(
      rules(
        'a.tsx',
        `export const PENDING = '—';\n` +
          `const e = <td>{props.r.tierAssigned ?? '—'}{r.modelLabel ?? '—'}{p.baseUrl ?? '—'}</td>;`,
      ),
    ).toEqual([]);
  });

  it('flags `free` as a whole price label at a call site, and not its discriminants', () => {
    const site = (body: string): Rule[] =>
      rules('pages/Routing.tsx', `function modelPriceLabel(m: M) {\n${body}\n}`);
    expect(site(`if (m.isFree) return 'free';\nreturn label(m);`)).toEqual(['whole-free']);
    expect(site(`return m.isFree ? <span>free</span> : label(m);`)).toEqual(['whole-free']);
    expect(
      site(
        `if (m.kind === 'free') return priceLabelParts({ kind: 'free', estimated: false });\n` +
          `switch (m.kind) { case 'free': return x; }\nreturn label(m);`,
      ),
    ).toEqual([]);
    // The same-file declarations a site reads are in scope; other functions are not.
    expect(
      rules(
        'components/BarRows.tsx',
        `const FREE_PARTS = [{ text: 'free', tone: 'green' }];\n` +
          `function other() { return 'free'; }\n` +
          `export function BarRows() { return FREE_PARTS; }`,
      ),
    ).toEqual(['whole-free']);
  });

  it('flags a worded `· estimate` on a price label, and not the provenance prose beside it', () => {
    const providers = (body: string): Rule[] =>
      rules(
        'pages/Providers.tsx',
        `function priceText(m: M) { return label(m); }
${body}
` + `function priceProvenance(m: M) { return 'provider-listed · estimate'; }`,
      );
    expect(
      providers(`function batchRateText(p: P) { return \`batch \${p} per 1M · estimate\`; }`),
    ).toEqual(['worded-estimate']);
    expect(providers(`function batchRateText(p: P) { return label(p); }`)).toEqual([]);
  });

  it('fails, naming the file, when a price-label call site is renamed away', () => {
    expect(scanFile('pages/Providers.tsx', `function priceLabel() { return 1; }`)).toEqual([
      {
        file: 'pages/Providers.tsx',
        line: 1,
        rule: 'whole-free',
        text: 'price-label call site `priceText` not found',
      },
      {
        file: 'pages/Providers.tsx',
        line: 1,
        rule: 'whole-free',
        text: 'price-label call site `batchRateText` not found',
      },
    ]);
  });
});
