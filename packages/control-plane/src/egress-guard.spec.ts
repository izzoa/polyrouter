// add-honest-user-agent task 5.5: the egress source guard.
//
// Every byte polyrouter sends to an upstream goes through the SSRF-guarded client, and
// that client stamps `User-Agent: polyrouter/<version>` (outbound-user-agent). A new
// egress path that reaches the network some other way would silently send the HTTP
// library's own User-Agent (`undici`, `node`) instead, so this test fails the build when
// source outside a short allowlist imports an HTTP client, builds a guarded dispatcher,
// or calls the global `fetch`.
//
// The scan reads the TypeScript syntax tree, not text, so comments, strings and type-only
// imports never trip it. `scanSource` is pure so its own rules are unit-tested below with
// the exact mutations the change's Verify clause names.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import * as ts from 'typescript';

const PACKAGES = resolve(__dirname, '../..');
const SCANNED = ['shared', 'data-plane', 'control-plane'];

/** The only files that may import `undici` as a value, and the names each may import. */
const UNDICI_VALUE_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  'packages/data-plane/src/providers/http.ts': ['fetch'],
  'packages/control-plane/src/subscription-oauth/oauth-client.ts': ['fetch'],
  'packages/control-plane/src/pricing/litellm-fetch.ts': ['fetch'],
  'packages/shared/src/server/security/ssrf.ts': ['Agent', 'buildConnector', 'fetch'],
};

/** The only files that may call `createGuardedDispatcher(`. */
const DISPATCHER_CALLERS: ReadonlySet<string> = new Set(Object.keys(UNDICI_VALUE_IMPORTS));

/** Node's own HTTP clients: forbidden as values everywhere. */
const NODE_HTTP_MODULES: ReadonlySet<string> = new Set([
  'node:http',
  'node:https',
  'node:http2',
  'http',
  'https',
  'http2',
]);

/** `file` is a repository-relative posix path such as `packages/shared/src/x.ts`. */
export function scanSource(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const problems: string[] = [];
  const at = (node: ts.Node): string =>
    `${file}:${String(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1)}`;

  const checkModule = (specifier: string, node: ts.Node, typeOnly: boolean): void => {
    if (typeOnly) return;
    if (NODE_HTTP_MODULES.has(specifier)) {
      problems.push(`${at(node)}: value import of '${specifier}' (use the guarded client)`);
    }
  };

  const checkUndiciImport = (node: ts.Node, names: readonly string[] | 'all'): void => {
    const allowed = UNDICI_VALUE_IMPORTS[file];
    if (allowed === undefined) {
      problems.push(`${at(node)}: value import from 'undici' outside the egress allowlist`);
      return;
    }
    if (names === 'all') {
      problems.push(`${at(node)}: namespace, default or re-export of 'undici' is not allowed`);
      return;
    }
    for (const name of names) {
      if (!allowed.includes(name)) {
        problems.push(`${at(node)}: '${name}' from 'undici' is not allowed in this file`);
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const namedValues =
        bindings !== undefined && ts.isNamedImports(bindings)
          ? bindings.elements.filter((e) => !e.isTypeOnly)
          : [];
      const hasValueBinding =
        clause === undefined || // `import 'x'` runs the module
        (!clause.isTypeOnly &&
          (clause.name !== undefined ||
            (bindings !== undefined && ts.isNamespaceImport(bindings)) ||
            namedValues.length > 0));
      checkModule(spec, node, !hasValueBinding);
      if (spec === 'undici' && hasValueBinding) {
        const wholeModule =
          clause === undefined ||
          clause.name !== undefined ||
          (bindings !== undefined && ts.isNamespaceImport(bindings));
        checkUndiciImport(
          node,
          wholeModule ? 'all' : namedValues.map((e) => (e.propertyName ?? e.name).text),
        );
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !node.isTypeOnly
    ) {
      const spec = node.moduleSpecifier.text;
      const exported = node.exportClause;
      const valueNames =
        exported !== undefined && ts.isNamedExports(exported)
          ? exported.elements
              .filter((e) => !e.isTypeOnly)
              .map((e) => (e.propertyName ?? e.name).text)
          : 'all';
      if (valueNames === 'all' || valueNames.length > 0) {
        checkModule(spec, node, false);
        if (spec === 'undici') checkUndiciImport(node, 'all');
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression) &&
      !node.isTypeOnly
    ) {
      const spec = node.moduleReference.expression.text;
      checkModule(spec, node, false);
      if (spec === 'undici') {
        problems.push(`${at(node)}: require of 'undici' is not allowed`);
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const first = node.arguments[0];
      const literal = first !== undefined && ts.isStringLiteralLike(first) ? first.text : undefined;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      if ((isRequire || isDynamicImport) && literal !== undefined) {
        checkModule(literal, node, false);
        if (literal === 'undici') {
          problems.push(`${at(node)}: ${isRequire ? 'require' : 'dynamic import'} of 'undici'`);
        }
      }
      if (ts.isIdentifier(callee) && callee.text === 'createGuardedDispatcher') {
        if (!DISPATCHER_CALLERS.has(file)) {
          problems.push(
            `${at(node)}: createGuardedDispatcher( called outside the egress allowlist`,
          );
        }
      }
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'createGuardedDispatcher' &&
        !DISPATCHER_CALLERS.has(file)
      ) {
        problems.push(`${at(node)}: createGuardedDispatcher( called outside the egress allowlist`);
      }
      const globalFetch =
        (ts.isIdentifier(callee) && callee.text === 'fetch') ||
        (ts.isPropertyAccessExpression(callee) &&
          callee.name.text === 'fetch' &&
          ts.isIdentifier(callee.expression) &&
          ['globalThis', 'global', 'window', 'self'].includes(callee.expression.text));
      if (globalFetch) problems.push(`${at(node)}: global fetch( call`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return problems;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (
      /\.(ts|tsx|mts|cts)$/.test(entry.name) &&
      !/\.(spec|test|testkit)\.(ts|tsx|mts|cts)$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

describe('egress source guard (add-honest-user-agent)', () => {
  it('finds no unguarded egress path in shared, data-plane and control-plane source', () => {
    const root = resolve(PACKAGES, '..');
    const files = SCANNED.flatMap((pkg) => sourceFiles(join(PACKAGES, pkg, 'src')));
    // A scan that found nothing would pass vacuously, so insist on the known egress files.
    expect(files.length).toBeGreaterThan(100);
    const rel = files.map((f) => relative(root, f).split(sep).join('/'));
    for (const allowed of Object.keys(UNDICI_VALUE_IMPORTS)) expect(rel).toContain(allowed);

    const problems = files.flatMap((f, i) => scanSource(rel[i]!, readFileSync(f, 'utf8')));
    expect(problems).toEqual([]);
  });

  describe('scanSource rules', () => {
    const OTHER = 'packages/control-plane/src/proxy/other.ts';
    const HTTP = 'packages/data-plane/src/providers/http.ts';

    it('accepts the allowlisted imports exactly as they are today', () => {
      expect(
        scanSource(HTTP, "import { fetch as undiciFetch, type Dispatcher } from 'undici';"),
      ).toEqual([]);
      expect(
        scanSource(
          'packages/shared/src/server/security/ssrf.ts',
          "import { Agent, buildConnector, fetch as undiciFetch, type Dispatcher } from 'undici';\nconst d = createGuardedDispatcher(o);",
        ),
      ).toEqual([]);
    });

    it('accepts type-only imports anywhere', () => {
      expect(scanSource(OTHER, "import type { Dispatcher } from 'undici';")).toEqual([]);
      expect(scanSource(OTHER, "import { type Dispatcher } from 'undici';")).toEqual([]);
      expect(scanSource(OTHER, "import type { IncomingMessage } from 'node:http';")).toEqual([]);
      expect(scanSource(OTHER, "export type { Dispatcher } from 'undici';")).toEqual([]);
      expect(scanSource(OTHER, "type T = import('node:http').IncomingMessage;")).toEqual([]);
    });

    it('rejects an undici fetch import in another file', () => {
      expect(scanSource(OTHER, "import { fetch } from 'undici';")).not.toEqual([]);
    });

    it('rejects an undici request import in another file', () => {
      expect(scanSource(OTHER, "import { request } from 'undici';")).not.toEqual([]);
    });

    it('rejects a Pool import added to an allowlisted file', () => {
      expect(scanSource(HTTP, "import { fetch as undiciFetch, Pool } from 'undici';")).not.toEqual(
        [],
      );
    });

    it("rejects import { request } from 'node:https' in another file", () => {
      expect(scanSource(OTHER, "import { request } from 'node:https';")).not.toEqual([]);
    });

    it('rejects every Node HTTP module in every import form, even in an allowlisted file', () => {
      for (const spec of ['node:http', 'node:https', 'node:http2', 'http', 'https', 'http2']) {
        expect(scanSource(HTTP, `import * as m from '${spec}';`)).not.toEqual([]);
        expect(scanSource(HTTP, `import m from '${spec}';`)).not.toEqual([]);
        expect(scanSource(HTTP, `const m = require('${spec}');`)).not.toEqual([]);
        expect(scanSource(HTTP, `const m = await import('${spec}');`)).not.toEqual([]);
        expect(scanSource(HTTP, `import m = require('${spec}');`)).not.toEqual([]);
      }
    });

    it('rejects require and dynamic import of undici everywhere, allowlisted files included', () => {
      for (const file of [OTHER, HTTP]) {
        expect(scanSource(file, "const u = require('undici');")).not.toEqual([]);
        expect(scanSource(file, "const u = await import('undici');")).not.toEqual([]);
        expect(scanSource(file, "import * as u from 'undici';")).not.toEqual([]);
        expect(scanSource(file, "export * from 'undici';")).not.toEqual([]);
      }
    });

    it('rejects createGuardedDispatcher( outside the four egress files', () => {
      expect(scanSource(OTHER, 'const d = createGuardedDispatcher(o);')).not.toEqual([]);
      expect(scanSource(OTHER, 'const d = ssrf.createGuardedDispatcher(o);')).not.toEqual([]);
      expect(scanSource(HTTP, 'const d = createGuardedDispatcher(o);')).toEqual([]);
    });

    it('rejects a global fetch( call but not a method named fetch or an aliased import', () => {
      expect(scanSource(OTHER, "await fetch('https://x');")).not.toEqual([]);
      expect(scanSource(OTHER, "await globalThis.fetch('https://x');")).not.toEqual([]);
      expect(scanSource(OTHER, 'await deps.fetch(url);')).toEqual([]);
      expect(scanSource(OTHER, "// fetch('x') in a comment\nconst s = \"fetch('x')\";")).toEqual(
        [],
      );
    });
  });
});
