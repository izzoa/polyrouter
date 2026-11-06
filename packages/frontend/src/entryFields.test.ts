/**
 * Every entry field takes the shared field classes (adopt-design-tokens-v2 task 8.1;
 * design.md D20; dashboard-core "Entry controls show help, invalid, read-only and disabled
 * states").
 *
 * The field look — the Canvas fill, the Control Edge, the hover and focus edges, read-only,
 * disabled and the comfort context's 16px text — hangs on three classes in `styles.css`:
 * `input`, `select` and `mp-input`. A field outside them renders whatever its inline style
 * or the browser says, which is how the Users invite email shipped as a bare UA input and
 * the Targets matrix picker as a chip-filled hairline select. This guard reads every
 * component source through the TypeScript AST and fails any `<input>` (other than a
 * checkbox or radio), `<select>` or `<textarea>` whose `class` carries none of the three,
 * naming the file and line.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = import.meta.dirname;
const FIELD_CLASSES = ['input', 'select', 'mp-input'] as const;
const FIELD_TAGS = new Set(['input', 'select', 'textarea']);
/** Native widgets: the browser draws their edge (design.md D2), and no field class fits. */
const NATIVE_TYPES = new Set(['checkbox', 'radio']);

export interface FieldSite {
  file: string;
  line: number;
  tag: string;
  /** Every class token the `class` attribute can produce, across all its branches. */
  classes: string[];
}

/** Every string a JSX attribute value can produce: a literal, or each literal inside an
 * expression (a ternary's branches, a template's quasis). */
function stringsIn(init: ts.JsxAttributeValue | undefined): string[] {
  if (init === undefined) return [];
  if (ts.isStringLiteral(init)) return [init.text];
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteralLike(n)) out.push(n.text);
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n))
      out.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(init);
  return out;
}

/** Every entry field one component source renders, read from its AST. */
export function fieldSites(file: string, source: string): FieldSite[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: FieldSite[] = [];
  const visit = (node: ts.Node): void => {
    const opening = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : null;
    if (opening !== null) {
      const tag = opening.tagName.getText(sf);
      if (FIELD_TAGS.has(tag)) {
        let type: string | null = null;
        let classes: string[] = [];
        for (const a of opening.attributes.properties) {
          if (!ts.isJsxAttribute(a)) continue;
          const name = a.name.getText(sf);
          if (name === 'type' && a.initializer && ts.isStringLiteral(a.initializer)) {
            type = a.initializer.text;
          }
          if (name === 'class' || name === 'className') {
            classes = stringsIn(a.initializer).flatMap((s) => s.split(/\s+/).filter(Boolean));
          }
        }
        if (!(tag === 'input' && type !== null && NATIVE_TYPES.has(type))) {
          out.push({
            file,
            line: sf.getLineAndCharacterOfPosition(opening.getStart(sf)).line + 1,
            tag,
            classes,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The fields outside the shared classes, each named `file:line <tag>`. */
export function unclassedFields(sites: readonly FieldSite[]): string[] {
  return sites
    .filter((s) => !s.classes.some((c) => (FIELD_CLASSES as readonly string[]).includes(c)))
    .map((s) => `${s.file}:${String(s.line)} <${s.tag}> class="${s.classes.join(' ')}"`);
}

/** Every component source: `.tsx` under src/, not tests and not the test helpers. */
function componentFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'test' ? [] : componentFiles(path);
    return name.endsWith('.tsx') && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}

describe('every entry field takes the shared field classes (task 8.1, design.md D20)', () => {
  const sites = componentFiles(SRC).flatMap((path) =>
    fieldSites(relative(SRC, path), readFileSync(path, 'utf8')),
  );

  it('reads the fields (not vacuous)', () => {
    // The tree renders dozens of fields across the modals, pages and the combobox; a scan
    // that found a handful would mean the walker stopped reading them.
    expect(sites.length).toBeGreaterThan(40);
    const files = new Set(sites.map((s) => s.file));
    for (const f of [
      'components/Modals.tsx',
      'components/ModelPicker.tsx',
      'pages/Users.tsx',
      'pages/Routing.tsx',
      'pages/Login.tsx',
    ]) {
      expect(files.has(f), `${f} has fields`).toBe(true);
    }
  });

  it('no <input> (other than a checkbox or radio), <select> or <textarea> is outside input / select / mp-input', () => {
    expect(unclassedFields(sites)).toEqual([]);
  });

  it('self-check: names an unclassed field, reads every branch of a class, skips native widgets', () => {
    const probe = [
      'export const A = () => (',
      '  <div>',
      '    <input type="email" placeholder="x" />',
      '    <select class="tm-picker" />',
      '    <textarea class={x ? "input" : "input mono"} />',
      '    <input type="checkbox" />',
      '    <input type="radio" class="other" />',
      '    <input class={`input ${y}`} />',
      '    <select class="select select--sm tm-picker">',
      '      <option value="">a</option>',
      '    </select>',
      '  </div>',
      ');',
    ].join('\n');
    const found = fieldSites('probe.tsx', probe);
    expect(found.map((s) => s.tag)).toEqual(['input', 'select', 'textarea', 'input', 'select']);
    expect(unclassedFields(found)).toEqual([
      'probe.tsx:3 <input> class=""',
      'probe.tsx:4 <select> class="tm-picker"',
    ]);
  });
});

describe('the field states hang on the shared classes (task 8.1, DESIGN.md Inputs / Fields)', () => {
  const css = readFileSync(join(SRC, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  /** The declarations of the one rule whose selector list starts with `first`. */
  const rule = (first: string): string => {
    const at = css.indexOf(`\n${first}`);
    if (at < 0) throw new Error(`no rule starting ${first}`);
    return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  };
  const decl = (body: string, prop: string): string | undefined =>
    new RegExp(`(?:^|;|\\s)${prop}:\\s*([^;]+);`).exec(body)?.[1]?.trim();

  it('every field sits on the Canvas inside a 1px Control Edge with the 6px radius', () => {
    const body = rule('.input,\n.select,\n.mp-input {');
    expect(decl(body, 'background')).toBe('var(--bg)');
    expect(decl(body, 'border')).toBe('1px solid var(--border-control)');
    expect(decl(body, 'border-radius')).toBe('6px');
  });
  it('read-only is the Panel fill, a Hairline edge and Ink text', () => {
    const body = rule('.input[readonly],');
    expect(decl(body, 'background')).toBe('var(--panel)');
    expect(decl(body, 'border-color')).toBe('var(--border)');
    expect(decl(body, 'color')).toBe('var(--text)');
  });
  it('disabled is the Chip Tone fill and Ink 3 text', () => {
    const body = rule('.input:disabled,');
    expect(decl(body, 'background')).toBe('var(--chip)');
    expect(decl(body, 'color')).toBe('var(--text3)');
  });
  it('invalid is a Signal Red edge, kept while focused', () => {
    expect(decl(rule(".input[aria-invalid='true'],"), 'border-color')).toBe('var(--red)');
    expect(decl(rule("input[aria-invalid='true']:focus,"), 'border-color')).toBe(
      'var(--red) !important',
    );
  });
});

/** Every entry control whose edge is its affordance draws the Control Edge, and nothing inline
 * redraws it (adopt-design-tokens-v2 task 8.3, design.md D2; dashboard-core "An empty field
 * shows a 3:1 edge"). The fields (inputs, selects, the textarea, the combobox input) take it
 * from the shared field rule, a filter chip from `.filter-chip` at rest, the off switch from its
 * track; `browser/controlEdge.spec.ts` reads the rendered edges, and the native checkbox and
 * radio, which no stylesheet draws, by their pixels. An inline `border` or `background` on one
 * of these controls would outrank its rule, so the computed check could pass on one control
 * while another drew a hairline: this reads every component's inline styles too. */
describe('the Control Edge reaches every edge-is-affordance control (task 8.3, design.md D2)', () => {
  const css = readFileSync(join(SRC, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (first: string): string => {
    const at = css.indexOf(`\n${first}`);
    if (at < 0) throw new Error(`no rule starting ${first}`);
    return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  };
  const decl = (body: string, prop: string): string | undefined =>
    new RegExp(`(?:^|;|\\s)${prop}:\\s*([^;]+);`).exec(body)?.[1]?.trim();

  it('the field rule draws it for inputs, selects, the combobox input and the textarea', () => {
    expect(decl(rule('.input,\n.select,\n.mp-input {'), 'border')).toBe(
      '1px solid var(--border-control)',
    );
    // The one textarea takes the field rule through `.input`, as every field must (above).
    const textareas = componentFiles(SRC)
      .flatMap((p) => fieldSites(relative(SRC, p), readFileSync(p, 'utf8')))
      .filter((s) => s.tag === 'textarea');
    expect(textareas.length, 'the textarea is read').toBeGreaterThan(0);
    for (const t of textareas) expect(t.classes, `${t.file}:${String(t.line)}`).toContain('input');
  });

  it('a filter chip at rest draws it, and the off switch track is filled with it', () => {
    expect(decl(rule('.filter-chip {'), 'border')).toBe('1px solid var(--border-control)');
    expect(decl(rule('.toggle--off {'), 'background')).toBe('var(--border-control)');
  });

  it('no inline style on a field, a filter chip or a switch sets a border or a background', () => {
    const sites = componentFiles(SRC).flatMap((p) =>
      edgeStyleOverrides(relative(SRC, p), readFileSync(p, 'utf8')),
    );
    expect(sites).toEqual([]);
  });

  it('self-check: names an inline edge or fill on each control kind, and passes geometry', () => {
    const probe = [
      'export const A = () => (',
      '  <div>',
      '    <input class="input" style="border:1px solid var(--border)" />',
      '    <select class="select select--sm" style="max-width:180px" />',
      '    <button class="filter-chip" style={{ background: "var(--chip)" }} />',
      '    <button role="switch" class="toggle" style={{ "border-color": "red" }} />',
      '    <textarea class="input" style="min-height:70px;resize:vertical" />',
      '    <input type="checkbox" style="border:0" />',
      '    <div style="background:var(--panel)" />',
      '  </div>',
      ');',
    ].join('\n');
    expect(edgeStyleOverrides('probe.tsx', probe)).toEqual([
      'probe.tsx:3 <input> style sets border',
      'probe.tsx:5 <button> style sets background',
      'probe.tsx:6 <button> style sets border-color',
    ]);
  });
});

/** Inline `border*` / `background*` on an edge-is-affordance control: a field (not a native
 * checkbox or radio), a filter chip, the combobox input or a switch. */
function edgeStyleOverrides(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const kebab = (n: string): string => n.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  const visit = (node: ts.Node): void => {
    const opening = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : null;
    if (opening !== null) {
      const tag = opening.tagName.getText(sf);
      let type: string | null = null;
      let role: string | null = null;
      let classes: string[] = [];
      let style: ts.JsxAttributeValue | undefined;
      for (const a of opening.attributes.properties) {
        if (!ts.isJsxAttribute(a)) continue;
        const name = a.name.getText(sf);
        if (name === 'type' && a.initializer && ts.isStringLiteral(a.initializer))
          type = a.initializer.text;
        if (name === 'role' && a.initializer && ts.isStringLiteral(a.initializer))
          role = a.initializer.text;
        if (name === 'class' || name === 'className')
          classes = stringsIn(a.initializer).flatMap((s) => s.split(/\s+/).filter(Boolean));
        if (name === 'style') style = a.initializer;
      }
      const field = FIELD_TAGS.has(tag) && !(type !== null && NATIVE_TYPES.has(type));
      const control =
        field ||
        role === 'switch' ||
        classes.some((c) => c === 'filter-chip' || c === 'mp-input' || c === 'toggle');
      if (control && style !== undefined) {
        const props = new Set<string>();
        if (ts.isStringLiteral(style)) {
          for (const m of style.text.matchAll(/(?:^|;)\s*([-\w]+)\s*:/g)) props.add(m[1] as string);
        } else {
          const walk = (n: ts.Node): void => {
            if (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) {
              const k = n.name;
              props.add(
                kebab(ts.isIdentifier(k) || ts.isStringLiteral(k) ? k.text : k.getText(sf)),
              );
            }
            ts.forEachChild(n, walk);
          };
          walk(style);
        }
        const line = sf.getLineAndCharacterOfPosition(opening.getStart(sf)).line + 1;
        for (const p of props)
          if (/^(?:border|background)/.test(p))
            out.push(`${file}:${String(line)} <${tag}> style sets ${p}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
