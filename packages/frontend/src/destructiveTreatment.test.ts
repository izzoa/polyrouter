/**
 * The destructive treatment's source guards (adopt-red-destructive-actions tasks 5.1 and 5.2,
 * design.md D1 / D3 / D7; dashboard-core "Destructive actions are consistent and confirmed").
 *
 * Each regression below used to be a review finding. Here it is a failing test, named by file
 * and line:
 *
 * - **A native prompt** (task 5.1). Every destructive action confirms in the one shared
 *   dashboard dialog. The DOM lib declares `confirm` as a global, so a bare `confirm('…')`
 *   compiles under strict TypeScript and no lint rule forbids it, and a text match on
 *   `globalThis.confirm(` would miss it. So every source is parsed with the TypeScript compiler
 *   API, as `toastRoles.test.ts` does, and every call whose callee reaches the browser's
 *   `confirm` fails: the bare global, or `confirm` read as a property or element of
 *   `globalThis`, `window` or `self`. So does every other read of it, because an alias calls it
 *   unseen (`const ask = globalThis.confirm; ask('…')`, `const { confirm: ask } = window`). The
 *   one exception is keep-forever retention in `BodyCaptureCard.tsx`, which asks for consent
 *   rather than warning of loss (D3). It is allowlisted by its file AND its consent copy, as a
 *   direct call, and the allowlist is bounded.
 * - **An amber button** (task 5.1). Amber is a status hue; the amber ghost class is gone, and
 *   nothing may bring it back. A test may still name it, but only in an assertion that
 *   forbids it.
 * - **Overpromising copy** (task 5.1, D7). No title or body of a destructive confirmation says
 *   "immediately" or "now": multi-instance caches and in-flight requests make an instant
 *   cut-off untrue. Every request object (`title`, `body`, `commitLabel`) is read, wherever it
 *   is built: at a page's `app.confirmDestructive(…)`, or in the store, which builds a model
 *   Remove's request itself. The name of the `Purge now` action is removed first, because the
 *   keep-or-purge body names that button; commit labels are not scanned.
 * - **The red fill off its commit** (task 5.2, D1). `var(--red-fill)` is read only by the
 *   `.btn-destructive` rules, and declared only in the two theme blocks; `.btn-destructive`
 *   is used only by the shared dialog's commit. No `var(--red-fill, …)` carries a fallback,
 *   and no `.ts` / `.tsx` file holds the rest, hover or pressed literal, so the requirement's
 *   fallback clause holds because no fallback exists.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = import.meta.dirname;
const FRONTEND = join(SRC, '..');

/** Every file under `dir`, recursively, sorted. */
function walk(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) visit(p);
      else out.push(p);
    }
  };
  visit(dir);
  return out.sort();
}

const isTest = (p: string): boolean => /\.(test|spec)\.tsx?$/.test(p);
const isScript = (p: string): boolean => /\.tsx?$/.test(p) && !p.endsWith('.d.ts');

/** Application sources: every `.ts` / `.tsx` under `src`, tests excepted. */
const appSources = (): string[] => walk(SRC).filter((p) => isScript(p) && !isTest(p));
const rel = (p: string): string => relative(SRC, p);

/** Parsed once per file and source: three guards read every application source. */
const parsed = new Map<string, ts.SourceFile>();
function parse(file: string, source: string): ts.SourceFile {
  const key = `${file}\0${source}`;
  const hit = parsed.get(key);
  if (hit !== undefined) return hit;
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  parsed.set(key, sf);
  return sf;
}
const lineOf = (sf: ts.SourceFile, node: ts.Node): number =>
  sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/** An expression with its parentheses, non-null assertions and casts looked through. */
function bare(e: ts.Expression): ts.Expression {
  let x = e;
  while (
    ts.isParenthesizedExpression(x) ||
    ts.isNonNullExpression(x) ||
    ts.isAsExpression(x) ||
    ts.isSatisfiesExpression(x)
  ) {
    x = x.expression;
  }
  return x;
}

/* ── 5.1: no native confirm prompt ─────────────────────────────────────────────── */

/** The objects the browser's `confirm` can be read from. */
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self']);

/** `globalThis`, `window`, `self`, or one read from another (`globalThis.window`). */
function isGlobalObject(e: ts.Expression): boolean {
  const x = bare(e);
  if (ts.isIdentifier(x)) return GLOBAL_OBJECTS.has(x.text);
  if (ts.isPropertyAccessExpression(x))
    return GLOBAL_OBJECTS.has(x.name.text) && isGlobalObject(x.expression);
  return false;
}

/** True when a callee reaches the browser's `confirm`: the bare global, or `confirm` read as
 * a property or element of `globalThis`, `window` or `self` (optional chaining included). */
function isNativeConfirm(callee: ts.Expression): boolean {
  const c = bare(callee);
  if (ts.isIdentifier(c)) return c.text === 'confirm';
  if (ts.isPropertyAccessExpression(c))
    return c.name.text === 'confirm' && isGlobalObject(c.expression);
  if (ts.isElementAccessExpression(c)) {
    const key = bare(c.argumentExpression);
    return ts.isStringLiteralLike(key) && key.text === 'confirm' && isGlobalObject(c.expression);
  }
  return false;
}

export interface ConfirmCall {
  file: string;
  line: number;
  /** The call as written, whitespace collapsed. */
  call: string;
  /** The prompt's message when it is a literal, else null. */
  message: string | null;
}

/** Every call to the browser's `confirm` in one source. */
export function nativeConfirmCalls(file: string, source: string): ConfirmCall[] {
  const sf = parse(file, source);
  const out: ConfirmCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isNativeConfirm(node.expression)) {
      const arg = node.arguments[0];
      out.push({
        file,
        line: lineOf(sf, node),
        call: node.getText(sf).replace(/\s+/g, ' '),
        message: arg !== undefined && ts.isStringLiteralLike(arg) ? arg.text : null,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export interface ConfirmRead {
  file: string;
  line: number;
  /** The read as written, whitespace collapsed. */
  read: string;
}

/** True when `id` is the identifier `confirm` read as a value: not a declared name, a property
 * or binding key, or a type. A local named `confirm` is reported too, as a call to one is: name
 * it something else. */
function readsBareConfirm(id: ts.Identifier): boolean {
  if (id.text !== 'confirm') return false;
  const p = id.parent;
  if (ts.isShorthandPropertyAssignment(p)) return true; // `{ confirm }` reads the global
  const named = p as { name?: ts.Node; propertyName?: ts.Node; label?: ts.Node };
  if (named.name === id || named.propertyName === id || named.label === id) return false;
  if (ts.isQualifiedName(p) || ts.isTypeReferenceNode(p) || ts.isTypeQueryNode(p)) return false;
  return true;
}

/** The key a binding or object-pattern element takes from its source: `confirm` in
 * `{ confirm }`, `{ confirm: ask }` and `{ 'confirm': ask }`. */
function keyOf(name: ts.Node | undefined): string | null {
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const k = bare(name.expression);
    return ts.isStringLiteralLike(k) ? k.text : null;
  }
  return null;
}

/** Every read of the browser's `confirm` that is not the callee of a call: an alias, a
 * destructuring from `globalThis` / `window` / `self`, a value passed on. Each would let a
 * native prompt be shown through a name the call guard does not know. */
export function nativeConfirmReads(file: string, source: string): ConfirmRead[] {
  const sf = parse(file, source);
  const out: ConfirmRead[] = [];
  const called = new Set<ts.Node>();
  const report = (node: ts.Node): void => {
    out.push({ file, line: lineOf(sf, node), read: node.getText(sf).replace(/\s+/g, ' ') });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isNativeConfirm(node.expression)) {
      called.add(bare(node.expression));
    }
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      !called.has(node) &&
      isNativeConfirm(node)
    ) {
      report(node);
      return; // its own `confirm` name is part of this read
    }
    if (ts.isIdentifier(node) && !called.has(node) && readsBareConfirm(node)) report(node);
    // `const { confirm: ask } = window;`
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer !== undefined &&
      isGlobalObject(node.initializer)
    ) {
      for (const el of node.name.elements) {
        if (keyOf(el.propertyName ?? el.name) === 'confirm') report(el);
      }
    }
    // `({ confirm: ask } = window);`
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isObjectLiteralExpression(bare(node.left)) &&
      isGlobalObject(node.right)
    ) {
      for (const prop of (bare(node.left) as ts.ObjectLiteralExpression).properties) {
        if (ts.isPropertyAssignment(prop) && keyOf(prop.name) === 'confirm') report(prop);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The one native prompt left: keep-forever retention, which asks for consent rather than
 * warning of loss (design.md D3). Allowlisted by its file AND the start of its consent copy,
 * so a second prompt in the same file is not excused. */
const KEEP_FOREVER = {
  file: join('components', 'BodyCaptureCard.tsx'),
  copy: 'Keep captured bodies FOREVER?',
} as const;
const isKeepForever = (c: ConfirmCall): boolean =>
  c.file === KEEP_FOREVER.file && (c.message?.startsWith(KEEP_FOREVER.copy) ?? false);

const describeConfirm = (c: ConfirmCall): string =>
  `${c.file}:${String(c.line)} ${c.call} — destructive actions confirm in the shared dialog ` +
  '(app.confirmDestructive), never the native prompt';

/** The files every destructive confirmation is built in (design.md D7): the pages and cards
 * that call `app.confirmDestructive`, and the store, which builds a model Remove's request. */
const REQUEST_FILES = [
  join('components', 'BodyCaptureCard.tsx'),
  join('components', 'Inspector.tsx'),
  join('pages', 'Agents.tsx'),
  join('pages', 'Batches.tsx'),
  join('pages', 'Limits.tsx'),
  join('pages', 'Providers.tsx'),
  join('pages', 'Settings.tsx'),
  join('pages', 'Users.tsx'),
  join('state', 'appState.ts'),
];

describe('no destructive action confirms through the native prompt (5.1)', () => {
  const calls = (): ConfirmCall[] =>
    appSources().flatMap((p) => nativeConfirmCalls(rel(p), readFileSync(p, 'utf8')));

  it('no call reaches the browser’s confirm outside the keep-forever consent prompt', () => {
    expect(
      calls()
        .filter((c) => !isKeepForever(c))
        .map(describeConfirm),
    ).toEqual([]);
  });

  it('no source reads the browser’s confirm except to call it: an alias would call it unseen', () => {
    expect(
      appSources()
        .flatMap((p) => nativeConfirmReads(rel(p), readFileSync(p, 'utf8')))
        .map(
          (r) =>
            `${r.file}:${String(r.line)} ${r.read} — an alias of the native prompt; destructive ` +
            'actions confirm in the shared dialog (app.confirmDestructive)',
        ),
    ).toEqual([]);
  });

  it('the allowlist is bounded: the keep-forever prompt is still there, exactly once', () => {
    // A stale entry would excuse a prompt that no longer exists, and a later one in its place.
    // If keep-forever moves onto a dashboard dialog, delete KEEP_FOREVER with it.
    expect(
      calls()
        .filter(isKeepForever)
        .map((c) => c.file),
    ).toEqual([KEEP_FOREVER.file]);
  });

  it('reads every file a destructive confirmation is built in', () => {
    const files = appSources().map(rel);
    expect(files).toEqual(expect.arrayContaining(REQUEST_FILES));
  });
});

/* ── 5.1: no amber button ──────────────────────────────────────────────────────── */

/** Spelled in two halves, so this guard's own source never carries the class. */
const AMBER = ['btn-ghost', 'amber'].join('--');
/** A line that asserts the class is ABSENT. Only a test or spec may name it, and only so. */
const FORBIDS = /\.not\.|toBeNull\(\)|toEqual\(\[\]\)|toBe\(0\)|toHaveLength\(0\)|toBe\(false\)/;

export interface AmberHit {
  file: string;
  line: number;
  text: string;
}

/** Every line of one file that carries the amber class without forbidding it. */
export function amberHits(file: string, source: string): AmberHit[] {
  const out: AmberHit[] = [];
  source.split('\n').forEach((text, i) => {
    if (!text.includes(AMBER)) return;
    if (isTest(file) && FORBIDS.test(text)) return;
    out.push({ file, line: i + 1, text: text.trim() });
  });
  return out;
}

describe('no button carries amber, a status hue (5.1)', () => {
  it(`no file under src or browser, nor the entry pages, carries ${AMBER}`, () => {
    const files = [
      ...walk(SRC),
      ...walk(join(FRONTEND, 'browser')),
      join(FRONTEND, 'index.html'),
      join(FRONTEND, 'browser-harness.html'),
    ];
    const hits = files.flatMap((p) => amberHits(relative(FRONTEND, p), readFileSync(p, 'utf8')));
    expect(hits.map((h) => `${h.file}:${String(h.line)} ${h.text}`)).toEqual([]);
  });
});

/* ── 5.1: confirmation copy never overpromises ─────────────────────────────────── */

/** The action whose name the keep-or-purge body quotes; removed before the check. */
const PURGE_NOW = 'Purge now';
const OVERPROMISE = /\b(immediately|now)\b/i;

/** The word in `text` that promises an instant cut-off, or null. */
export function overpromise(text: string): string | null {
  return OVERPROMISE.exec(text.split(PURGE_NOW).join(' '))?.[1] ?? null;
}

export interface RequestCopy {
  file: string;
  line: number;
  field: 'title' | 'body';
  /** Every literal piece the field can render, joined: both branches of a ternary, both
   * operands of a `+`, a template's quasis, and the values a local name is given. */
  text: string;
}

const propName = (p: ts.ObjectLiteralElementLike): string | null =>
  p.name !== undefined && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
    ? p.name.text
    : null;

/** A shared-dialog request: an object literal with a title, a body and a commit label. */
function isRequest(o: ts.ObjectLiteralExpression): boolean {
  const names = new Set(o.properties.map(propName));
  return names.has('title') && names.has('body') && names.has('commitLabel');
}

const isCallee = (c: ts.CallExpression, name: string): boolean => {
  const e = bare(c.expression);
  return (
    (ts.isIdentifier(e) && e.text === name) ||
    (ts.isPropertyAccessExpression(e) && e.name.text === name)
  );
};

/** The nearest enclosing function, or null at module level. */
function enclosingFunction(node: ts.Node): ts.Node | null {
  for (let p = node.parent as ts.Node | undefined; p !== undefined; p = p.parent) {
    if (ts.isFunctionLike(p)) return p;
  }
  return null;
}

/** The values a local name is given: its initializers and its assignments, searched in the
 * enclosing function first, then among the module's top-level declarations. */
function valuesOf(name: string, from: ts.Node, sf: ts.SourceFile): ts.Expression[] {
  const inScope = (scope: ts.Node, deep: boolean): ts.Expression[] => {
    const out: ts.Expression[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
        if (n.initializer !== undefined) out.push(n.initializer);
      } else if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(n.left) &&
        n.left.text === name
      ) {
        out.push(n.right);
      }
      if (deep) ts.forEachChild(n, visit);
    };
    if (deep) visit(scope);
    else
      for (const st of sf.statements)
        if (ts.isVariableStatement(st)) st.declarationList.declarations.forEach(visit);
    return out;
  };
  const fn = enclosingFunction(from);
  const local = fn === null ? [] : inScope(fn, true);
  return local.length > 0 ? local : inScope(sf, false);
}

/** Every literal piece an expression can render. */
function literalPieces(expr: ts.Expression, sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      out.push(n.text);
      return;
    }
    if (ts.isTemplateExpression(n)) {
      out.push(n.head.text);
      for (const span of n.templateSpans) {
        visit(span.expression);
        out.push(span.literal.text);
      }
      return;
    }
    if (ts.isIdentifier(n)) {
      // A property's name (`a.name`) is not a value of its own.
      const p = n.parent;
      if (ts.isPropertyAccessExpression(p) && p.name === n) return;
      if (seen.has(n.text)) return;
      seen.add(n.text);
      for (const v of valuesOf(n.text, n, sf)) visit(v);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(expr);
  return out;
}

/** Every confirmation title and body in one source, and the `confirmDestructive` calls whose
 * request the guard cannot read (it must be an object literal at the call). */
export function confirmationCopy(
  file: string,
  source: string,
): { copy: RequestCopy[]; unreadable: string[] } {
  const sf = parse(file, source);
  const copy: RequestCopy[] = [];
  const unreadable: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isCallee(node, 'confirmDestructive')) {
      const arg = node.arguments[0];
      if (arg === undefined || !ts.isObjectLiteralExpression(bare(arg)))
        unreadable.push(
          `${file}:${String(lineOf(sf, node))} confirmDestructive(…) without a literal request`,
        );
    }
    if (ts.isObjectLiteralExpression(node) && isRequest(node)) {
      for (const p of node.properties) {
        const field = propName(p);
        if (field !== 'title' && field !== 'body') continue;
        const value = ts.isPropertyAssignment(p)
          ? p.initializer
          : ts.isShorthandPropertyAssignment(p)
            ? p.name
            : null;
        const text = value === null ? '' : literalPieces(value, sf).join(' ').trim();
        if (text === '')
          unreadable.push(
            `${file}:${String(lineOf(sf, p))} ${field} has no copy the guard can read`,
          );
        else copy.push({ file, line: lineOf(sf, p), field, text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { copy, unreadable };
}

describe('confirmation copy states a forward-looking guarantee, never an instant one (5.1, D7)', () => {
  const read = (): { copy: RequestCopy[]; unreadable: string[] } => {
    const all = appSources().map((p) => confirmationCopy(rel(p), readFileSync(p, 'utf8')));
    return {
      copy: all.flatMap((r) => r.copy),
      unreadable: all.flatMap((r) => r.unreadable),
    };
  };

  it('no title or body says "immediately" or "now"', () => {
    const offenders = read()
      .copy.map((c) => ({ c, word: overpromise(c.text) }))
      .filter((x) => x.word !== null)
      .map(
        ({ c, word }) =>
          `${c.file}:${String(c.line)} ${c.field} says "${String(word)}": ${c.text} — state ` +
          'the forward-looking guarantee instead',
      );
    expect(offenders).toEqual([]);
  });

  it('every request is readable: a literal request, with copy in its title and body', () => {
    expect(read().unreadable).toEqual([]);
  });

  it('reads every destructive confirmation, wherever it is built', () => {
    const { copy } = read();
    // Each file builds at least one request, and each request yields a title and a body.
    expect([...new Set(copy.map((c) => c.file))]).toEqual(expect.arrayContaining(REQUEST_FILES));
    expect(copy.filter((c) => c.field === 'title').length).toBe(
      copy.filter((c) => c.field === 'body').length,
    );
    // The eleven requests D7 lists: agent, provider, budget, channel, user, disable user,
    // model Remove, Purge all, keep-or-purge, payload and Cancel batch.
    expect(copy.filter((c) => c.field === 'title').length).toBeGreaterThanOrEqual(11);
    // The store's model Remove is read through its local `impact` sentence.
    const remove = copy.find((c) => c.file === join('state', 'appState.ts') && c.field === 'body');
    expect(remove?.text).toContain('will lose its target');
  });

  it('passes the shipped keep-or-purge body, which names the Purge now action', () => {
    const body = read().copy.find(
      (c) => c.file === join('components', 'BodyCaptureCard.tsx') && c.text.includes(PURGE_NOW),
    );
    expect(body, 'the keep-or-purge body no longer names Purge now').toBeDefined();
    expect(overpromise(body!.text)).toBeNull();
  });
});

/* ── 5.2: the red fill stays on the commit, with no fallback ──────────────────── */

interface Rule {
  selector: string;
  body: string;
  /** The enclosing at-rules; empty at the top level. */
  context: string;
}

/** Every leaf rule of a stylesheet (comments stripped), one per selector in a list. */
function leafRules(css: string): Rule[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  const stack: string[] = [];
  let i = 0;
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
          context: stack.join(' '),
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

/** The two theme blocks, the only places `--red-fill` is declared. */
const THEME_BLOCKS = new Set([':root', "[data-theme='dark']"]);
/** A `.btn-destructive` rule: the class, optionally with pseudo-classes (`:hover`, `:active`). */
const COMMIT_RULE = /^\.btn-destructive(?::{1,2}[a-z-]+(?:\([^()]*\))?)*$/;
const READS_RED_FILL = /var\(\s*--red-fill\b/;
const DECLARES_RED_FILL = /(?:^|[;{\s])--red-fill\s*:/;
const RED_FILL_FALLBACK = /var\(\s*--red-fill\s*,[^)]*\)/g;

/** Every rule that reads or declares the red fill where it must not. */
export function redFillPlacement(css: string): string[] {
  const out: string[] = [];
  for (const r of leafRules(css)) {
    const where = `${r.context === '' ? '' : `${r.context} › `}${r.selector}`;
    const theme = r.context === '' && THEME_BLOCKS.has(r.selector);
    if (READS_RED_FILL.test(r.body) && !COMMIT_RULE.test(r.selector) && !theme)
      out.push(`${where} reads var(--red-fill), which only the .btn-destructive rules may`);
    if (DECLARES_RED_FILL.test(r.body) && !theme)
      out.push(`${where} declares --red-fill outside the theme blocks`);
  }
  return out;
}

/** Every `var(--red-fill, …)` that carries a fallback argument. */
export const redFillFallbacks = (css: string): string[] =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(RED_FILL_FALLBACK)].map((m) => m[0]);

const STYLESHEET = (): string => readFileSync(join(SRC, 'styles.css'), 'utf8');

const COMMIT_CLASS = /(?<![\w-])btn-destructive(?![\w-])/;

export interface CommitClassUse {
  file: string;
  line: number;
  /** The element the class is on, when it is a JSX attribute value. */
  element: string | null;
  /** That element's `onClick`, as written. */
  onClick: string | null;
}

/** Every string in one source that carries the commit's class (comments are not strings). */
export function commitClassUses(file: string, source: string): CommitClassUse[] {
  const sf = parse(file, source);
  const out: CommitClassUse[] = [];
  const text = (n: ts.Node): string | null =>
    ts.isStringLiteral(n) ||
    ts.isNoSubstitutionTemplateLiteral(n) ||
    ts.isTemplateHead(n) ||
    ts.isTemplateMiddle(n) ||
    ts.isTemplateTail(n)
      ? n.text
      : null;
  const visit = (node: ts.Node): void => {
    const t = text(node);
    if (t !== null && COMMIT_CLASS.test(t)) {
      let attr: ts.JsxAttribute | null = null;
      for (let p = node.parent as ts.Node | undefined; p !== undefined; p = p.parent) {
        if (ts.isJsxAttribute(p)) {
          attr = p;
          break;
        }
        if (ts.isStatement(p)) break;
      }
      const owner = attr?.parent.parent;
      const element =
        owner !== undefined && (ts.isJsxOpeningElement(owner) || ts.isJsxSelfClosingElement(owner))
          ? owner
          : null;
      const onClick = element?.attributes.properties.find(
        (a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(sf) === 'onClick',
      );
      out.push({
        file,
        line: lineOf(sf, node),
        element: element === null ? null : element.tagName.getText(sf),
        onClick: onClick?.initializer?.getText(sf).replace(/\s+/g, ' ') ?? null,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The commit of the shared destructive confirmation: the only place the class is used. */
const isDialogCommit = (u: CommitClassUse): boolean =>
  u.file === join('components', 'ConfirmDialog.tsx') &&
  u.element === 'button' &&
  (u.onClick?.includes("'commit'") ?? false);

/** The commit's rest, hover and pressed fills, light and dark (design.md D1), as hex digits:
 * spelled without the `#`, so this guard's own source never matches what it forbids. */
const RED_FILL_HEX = ['b42318', 'c4342b', '9b261c', 'a8332a', '82271e', '8d3029'];
const RED_FILL_LITERAL = new RegExp(`#(?:${RED_FILL_HEX.join('|')})(?![0-9a-f])`, 'i');

describe('the red fill appears only on the destructive commit (5.2, D1)', () => {
  it('styles.css reads var(--red-fill) only in the .btn-destructive rules, and declares it only in the theme blocks', () => {
    expect(redFillPlacement(STYLESHEET())).toEqual([]);
  });

  it('…and it is really there: both theme blocks declare it, and the commit rules read it', () => {
    // Non-vacuity: an empty result above is a reading of the shipped sheet, not a miss.
    const rules = leafRules(STYLESHEET());
    for (const theme of THEME_BLOCKS)
      expect(
        rules.some((r) => r.selector === theme && DECLARES_RED_FILL.test(r.body)),
        `${theme} declares --red-fill`,
      ).toBe(true);
    const readers = rules.filter((r) => READS_RED_FILL.test(r.body)).map((r) => r.selector);
    expect(readers).toEqual([
      '.btn-destructive',
      '.btn-destructive:hover',
      '.btn-destructive:active',
    ]);
  });

  it('no var(--red-fill, …) carries a fallback argument', () => {
    expect(redFillFallbacks(STYLESHEET())).toEqual([]);
  });

  it('no script reads --red-fill: it is read only by CSS', () => {
    const readers = appSources()
      .filter((p) => readFileSync(p, 'utf8').includes('--red-fill'))
      .map(rel);
    expect(readers).toEqual([]);
  });

  it('.btn-destructive is used only by the shared dialog’s commit', () => {
    const uses = appSources().flatMap((p) => commitClassUses(rel(p), readFileSync(p, 'utf8')));
    expect(
      uses
        .filter((u) => !isDialogCommit(u))
        .map(
          (u) =>
            `${u.file}:${String(u.line)} carries btn-destructive` +
            `${u.element === null ? '' : ` on <${u.element}>`} — the red fill is the commit of ` +
            'the shared destructive confirmation only',
        ),
    ).toEqual([]);
    // Bounded: the dialog's commit is the one use, and it is still there.
    expect(uses.filter(isDialogCommit).length, 'the shared dialog’s commit').toBe(1);
  });

  it('no .ts / .tsx file holds a rest, hover or pressed literal of the red fill', () => {
    const files = [...walk(SRC), ...walk(join(FRONTEND, 'browser'))].filter(isScript);
    const hits = files.flatMap((p) =>
      readFileSync(p, 'utf8')
        .split('\n')
        .flatMap((line, i) =>
          RED_FILL_LITERAL.test(line)
            ? [`${relative(FRONTEND, p)}:${String(i + 1)} ${line.trim()}`]
            : [],
        ),
    );
    expect(hits).toEqual([]);
  });
});

/* ── The guards read what they claim to (self-checks) ─────────────────────────── */

describe('the guards read what they claim to (self-check)', () => {
  const calls = (src: string): string[] =>
    nativeConfirmCalls('probe.tsx', src).map((c) => `${String(c.line)}:${c.call}`);

  it('finds the native prompt however it is reached', () => {
    expect(
      calls(
        [
          "confirm('x');",
          "globalThis.confirm('x');",
          "window.confirm('x');",
          "self.confirm('x');",
          "window['confirm']('x');",
          "globalThis?.confirm?.('x');",
          "(window.confirm)('x');",
          "globalThis.window.confirm('x');",
          'if (!confirm(`Delete ${n}?`)) return;',
        ].join('\n'),
      ),
    ).toEqual([
      "1:confirm('x')",
      "2:globalThis.confirm('x')",
      "3:window.confirm('x')",
      "4:self.confirm('x')",
      "5:window['confirm']('x')",
      "6:globalThis?.confirm?.('x')",
      "7:(window.confirm)('x')",
      "8:globalThis.window.confirm('x')",
      '9:confirm(`Delete ${n}?`)',
    ]);
  });

  it('leaves the dashboard dialog and other objects’ confirm alone', () => {
    expect(
      calls(
        [
          'app.confirmDestructive({ title, body, commitLabel, busyLabel, run, fallbackFocus });',
          "dialog.confirm('x');",
          "const confirmed = isConfirmed('x');",
          "vi.stubGlobal('confirm', spy);",
          'expect(confirm).not.toHaveBeenCalled();',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  const reads = (src: string): string[] =>
    nativeConfirmReads('probe.tsx', src).map((r) => `${String(r.line)}:${r.read}`);

  it('finds the native prompt read under another name', () => {
    expect(
      reads(
        [
          'const ask = globalThis.confirm;',
          "ask('Delete agent?');",
          'const { confirm: prompt } = window;',
          'const { confirm } = self;',
          "const ok = window['confirm'];",
          'const bound = confirm;',
          'run(globalThis.window.confirm);',
          'const box = { confirm };',
          '({ confirm: later } = globalThis);',
          "const { ['confirm']: viaKey } = window;",
        ].join('\n'),
      ),
    ).toEqual([
      '1:globalThis.confirm',
      '3:confirm: prompt',
      '4:confirm',
      "5:window['confirm']",
      '6:confirm',
      '7:globalThis.window.confirm',
      '8:confirm',
      '9:confirm: later',
      "10:['confirm']: viaKey",
    ]);
  });

  it('does not count a call, a key, a declared name or another object’s confirm as a read', () => {
    expect(
      reads(
        [
          "globalThis.confirm('x');",
          "confirm('x');",
          "(window.confirm)('x');",
          'const TOAST_MS = { confirm: 4000, failure: 8000 };',
          "type Kind = 'confirm' | 'failure';",
          'interface Opts { confirm: boolean; }',
          "dialog.confirm('x');",
          'const { confirm: ok } = options;',
          'app.confirmDestructive({ title, body, commitLabel, busyLabel, run, fallbackFocus });',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('excuses keep-forever by its file and its copy, nothing else', () => {
    const at = (file: string, message: string): boolean =>
      isKeepForever({ file, line: 1, call: '', message });
    expect(at(KEEP_FOREVER.file, `${KEEP_FOREVER.copy} Nothing is ever purged.`)).toBe(true);
    expect(at(KEEP_FOREVER.file, 'Purge all bodies?')).toBe(false);
    expect(at(join('pages', 'Agents.tsx'), KEEP_FOREVER.copy)).toBe(false);
  });

  it('allows the amber class in a test only where it is forbidden', () => {
    const forbid = `expect(host.querySelector('.${AMBER}')).toBeNull();`;
    const use = `<button class="btn-ghost ${AMBER}">Delete</button>`;
    expect(amberHits('x.test.tsx', forbid)).toEqual([]);
    expect(amberHits('pages/X.tsx', forbid).length).toBe(1);
    expect(amberHits('x.test.tsx', use).length).toBe(1);
    expect(amberHits('styles.css', `.${AMBER}:hover { color: red; }`).length).toBe(1);
  });

  it('reads every piece of copy a request can render, and flags the overpromise', () => {
    const copy = (src: string): string[] =>
      confirmationCopy('probe.tsx', src).copy.map(
        (c) => `${c.field}:${String(overpromise(c.text))}`,
      );
    const req = (title: string, body: string): string =>
      `app.confirmDestructive({ title: ${title}, body: ${body}, commitLabel: 'Delete', busyLabel: 'Deleting…', run, fallbackFocus });`;
    // A plain literal, a template, a concatenation and both branches of a ternary.
    expect(copy(req("'Delete agent?'", "'Its key stops working immediately.'"))).toEqual([
      'title:null',
      'body:immediately',
    ]);
    expect(copy(req('`Delete ${a.name}?`', "'New requests ' + 'stop now.'"))).toEqual([
      'title:null',
      'body:now',
    ]);
    expect(
      copy(
        req(
          "self ? 'Disable your own account?' : `Disable ${e}?`",
          "self ? 'You will be signed out.' : 'Their sessions end now.'",
        ),
      ),
    ).toEqual(['title:null', 'body:now']);
    // A local name is read through its assignments, and a module constant through its value.
    expect(
      copy(
        `function f() { let impact: string; try { impact = 'Gone immediately.'; } catch { impact = 'x'; } ${req("'Remove?'", '`Listed. ${impact}`')} }`,
      ),
    ).toEqual(['title:null', 'body:immediately']);
    expect(copy(`const BODY = 'Right now.';\nfunction f() { ${req("'T?'", 'BODY')} }`)).toEqual([
      'title:null',
      'body:now',
    ]);
    // A request built outside the call (the store's model Remove) is still read.
    expect(
      copy(
        "request = { title: 'Remove x?', body: 'It goes now.', commitLabel: 'Remove model', busyLabel: 'Removing…', run, fallbackFocus };",
      ),
    ).toEqual(['title:null', 'body:now']);
  });

  it('strips the Purge now action’s name, matches whole words only, and skips commit labels', () => {
    expect(overpromise('Purge now deletes every stored body.')).toBeNull();
    expect(overpromise('Purge now deletes it; the rest go now.')).toBe('now');
    expect(overpromise('Nowhere known, unknowingly.')).toBeNull();
    expect(overpromise('IMMEDIATELY')).toBe('IMMEDIATELY');
    expect(
      confirmationCopy(
        'probe.tsx',
        "app.confirmDestructive({ title: 'T?', body: 'B.', commitLabel: 'Purge now', busyLabel: 'Purging…', run, fallbackFocus });",
      ).copy.map((c) => overpromise(c.text)),
    ).toEqual([null, null]);
  });

  it('reports a request it cannot read rather than passing it', () => {
    expect(confirmationCopy('probe.tsx', 'app.confirmDestructive(request);').unreadable).toEqual([
      'probe.tsx:1 confirmDestructive(…) without a literal request',
    ]);
    expect(
      confirmationCopy(
        'probe.tsx',
        "import { BODY } from './copy';\napp.confirmDestructive({ title: 'T?', body: BODY, commitLabel: 'C', busyLabel: 'B', run, fallbackFocus });",
      ).unreadable,
    ).toEqual(['probe.tsx:2 body has no copy the guard can read']);
  });

  it('places the red fill by rule, and finds a fallback', () => {
    const sheet = [
      ':root { --red-fill: #000; }',
      "[data-theme='dark'] { --red-fill: #111; }",
      '.btn-destructive { background: var(--red-fill); }',
      '.btn-destructive:hover:not(:disabled) { background: color-mix(in oklab, var(--red-fill) 85%, #17181a); }',
      '/* var(--red-fill) in a comment is prose */',
    ].join('\n');
    expect(redFillPlacement(sheet)).toEqual([]);
    expect(redFillPlacement(`${sheet}\n.btn-primary { background: var(--red-fill); }`)).toEqual([
      '.btn-primary reads var(--red-fill), which only the .btn-destructive rules may',
    ]);
    expect(redFillPlacement(`${sheet}\n.chip, .btn-destructive { --red-fill: red; }`)).toEqual([
      '.chip declares --red-fill outside the theme blocks',
      '.btn-destructive declares --red-fill outside the theme blocks',
    ]);
    expect(
      redFillPlacement(`${sheet}\n@media (max-width: 768px) { :root { --red-fill: red; } }`),
    ).toEqual(['@media (max-width: 768px) › :root declares --red-fill outside the theme blocks']);
    expect(redFillFallbacks(sheet)).toEqual([]);
    expect(
      redFillFallbacks('.btn-destructive { background: var( --red-fill , #123456); }'),
    ).toEqual(['var( --red-fill , #123456)']);
  });

  it('finds the commit class on any element, and knows the dialog’s commit', () => {
    const uses = commitClassUses(
      'probe.tsx',
      [
        '<button class="btn-primary btn-destructive" onClick={save}>Save</button>;',
        "<div class={busy ? 'x' : 'btn-destructive'} />;",
        'const c = `chip btn-destructive`;',
        '<button class="btn-ghost btn-ghost--destructive" onClick={ask}>Delete</button>;',
        '// a comment naming btn-destructive is prose',
      ].join('\n'),
    );
    expect(uses.map((u) => `${String(u.line)}:${String(u.element)}:${String(u.onClick)}`)).toEqual([
      '1:button:{save}',
      '2:div:null',
      '3:null:null',
    ]);
    expect(
      isDialogCommit({
        file: join('components', 'ConfirmDialog.tsx'),
        line: 1,
        element: 'button',
        onClick: "{() => launch('commit', request.run)}",
      }),
    ).toBe(true);
    expect(
      isDialogCommit({
        file: join('components', 'ConfirmDialog.tsx'),
        line: 1,
        element: 'button',
        onClick: "{() => launch('secondary', secondary().run)}",
      }),
    ).toBe(false);
  });
});
