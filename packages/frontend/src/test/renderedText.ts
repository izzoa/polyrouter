/** The rendered-text extraction shared by the source guards that read what the dashboard
 * paints: `glyphCoverage.test.ts` (replace-fallback-symbol-glyphs) and `figureStrings.test.ts`
 * (adopt-figure-states task 6.1, design D9). Moved here from `glyphCoverage.test.ts` so the two
 * guards read exactly the same text; neither re-implements it. */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Walks up to find the package's `src`. Not `new URL('.', import.meta.url)`: Vite rewrites
 * module URLs to its `/@fs/` scheme, which is not a real path on disk. */
export function findSrc(): string {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'src', 'index.tsx'))) return join(dir, 'src') + '/';
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate packages/frontend/src from ' + process.cwd());
}

/** Files whose text reaches a user. Excludes tests and the browser harness, both of which the
 * production build already excludes (`vite.config.ts` pins `input: 'index.html'`). */
export function shippedSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'test') shippedSources(p, out);
    } else if (
      (name.endsWith('.tsx') || name.endsWith('.ts')) &&
      !name.includes('.test.') &&
      !name.startsWith('browserHarness')
    ) {
      out.push(p);
    }
  }
  return out;
}

/** Blanks out an attribute's value wherever it appears, preserving line numbers.
 *
 * Brace-matching rather than `\{[^}]*\}`, because a JSX attribute is routinely a template
 * literal with interpolations — `aria-label={`Delete rule ${a} → ${b}`}` — and a naive
 * character class stops at the first `}` of `${a}`, leaving the rest of the value in scope. */
function blankAttribute(src: string, name: string): string {
  let out = src;
  for (const open of [`${name}={`, `${name}="`]) {
    let i = out.indexOf(open);
    while (i !== -1) {
      const start = i + open.length;
      let end = start;
      if (open.endsWith('{')) {
        let depth = 1;
        while (end < out.length && depth > 0) {
          if (out[end] === '{') depth++;
          else if (out[end] === '}') depth--;
          if (depth > 0) end++;
        }
      } else {
        while (end < out.length && out[end] !== '"') end++;
      }
      const value = out.slice(start, end);
      out = out.slice(0, start) + value.replace(/[^\n]/g, ' ') + out.slice(end);
      i = out.indexOf(open, end);
    }
  }
  return out;
}

/** Text the dashboard actually PAINTS.
 *
 * Two exclusions, each for a reason:
 * - Comments and JSDoc are never rendered. Counting them is what inflated the original
 *   inventory to 14 codepoints and invented `⇄`/`≠`, which the app never draws.
 * - Accessible names (`aria-label`, `title`) are spoken, not painted, so no font can affect
 *   them. A `→` announced as "rightwards arrow" is a screen-reader wording question and
 *   belongs to the accessibility requirement, not to font coverage.
 *
 * Both preserve line numbers so offences point at the right place. */
export function renderedText(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    '\n'.repeat((m.match(/\n/g) ?? []).length),
  );
  const noLine = noBlock
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
  return blankAttribute(blankAttribute(noLine, 'aria-label'), 'title');
}
