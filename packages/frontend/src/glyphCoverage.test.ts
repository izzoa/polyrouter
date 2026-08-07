/** Authored UI text uses only characters the bundled fonts actually contain
 *  (replace-fallback-symbol-glyphs).
 *
 * A character the bundled fonts do not provide is supplied by whatever font the viewer's
 * operating system happens to have, so the dashboard looks different per platform on the one
 * axis the design lock cares most about. Verified two ways before this guard was written: the
 * rendered advance width under `Geist` is identical to the fallback for these characters (and
 * differs for a covered one — the control that proves the method works), and the bundled
 * woff2 cmaps do not contain them.
 *
 * TWO THINGS THIS GETS RIGHT THAT THE OBVIOUS VERSION GETS WRONG:
 *
 * 1. It reads RENDERED text, not file bytes. A byte scan counts comments and JSDoc as UI —
 *    which inflated the original inventory from 12 codepoints to 14 and from 27 sites to 38,
 *    inventing two glyphs (`⇄`, `≠`) that appear only in comments and are never drawn.
 *
 * 2. It reads the fonts' real CHARACTER MAPS, not the `unicode-range` declarations. A range
 *    restricts which face may be SELECTED; a character inside the declared range can still be
 *    missing from the file and falls back exactly as an excluded one does. `fonts.css`
 *    declares `U+0100-02BA`, and the files do not contain U+0114.
 *
 * Scope is deliberately narrow: text this repository authors. Provider names, model ids,
 * emails and upstream error strings arrive at runtime and may contain anything — no static
 * check can see them, and constraining them would mean shipping fonts for every script.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundledFontCoverage } from './test/fontCoverage';

/** Walks up to find the package's `src`. Not `new URL('.', import.meta.url)`: Vite rewrites
 * module URLs to its `/@fs/` scheme, which is not a real path on disk. */
function findSrc(): string {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'src', 'index.tsx'))) return join(dir, 'src') + '/';
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate packages/frontend/src from ' + process.cwd());
}

const SRC = findSrc();

/** Files whose text reaches a user. Excludes tests and the browser harness, both of which the
 * production build already excludes (`vite.config.ts` pins `input: 'index.html'`). */
function shippedSources(dir: string, out: string[] = []): string[] {
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
function renderedText(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length));
  const noLine = noBlock
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
  return blankAttribute(blankAttribute(noLine, 'aria-label'), 'title');
}

/** Characters allowed to fall back despite the rule, each with an argued reason.
 *
 * Empty, deliberately. An exemption is a decision and belongs here where it can be read and
 * challenged — not in a switched-off test. Keyed by `file:character` rather than by character
 * alone: an earlier version keyed by character and silently exempted all ten arrows when only
 * one needed handling. */
const ALLOWED: ReadonlyMap<string, string> = new Map();

describe('authored UI text renders from the bundled fonts', () => {
  it('uses no character the bundled fonts lack', () => {
    const covered = bundledFontCoverage();
    // The method must be able to fail. If a character the fonts DO contain were reported as
    // missing, every assertion below would be meaningless.
    expect(covered.has('A'.codePointAt(0)!), 'coverage reader is broken — “A” read as absent').toBe(
      true,
    );
    expect(covered.has(0x2192), 'coverage reader is broken — “→” read as present').toBe(false);

    const offences: string[] = [];
    for (const file of shippedSources(SRC)) {
      const text = renderedText(readFileSync(file, 'utf8'));
      text.split('\n').forEach((line, i) => {
        for (const ch of line) {
          const cp = ch.codePointAt(0)!;
          if (cp < 0x80 || covered.has(cp)) continue;
          if (ALLOWED.has(`${file.replace(SRC, '')}:${ch}`)) continue;
          offences.push(
            `${file.replace(SRC, '')}:${i + 1}  ${ch}  U+${cp.toString(16).toUpperCase().padStart(4, '0')}`,
          );
        }
      });
    }
    expect(
      offences,
      `these characters are not in any bundled font, so the viewer's operating system ` +
        `supplies them and the dashboard looks different per platform:\n${offences.join('\n')}`,
    ).toEqual([]);
  });

  it('does not count comments as rendered text', () => {
    // The bug this guard was rewritten to avoid: a byte scan reported `⇄` and `≠` as glyphs
    // the dashboard draws. It draws neither — they appear only in JSDoc.
    const sample = `/** doc with ⇄ and ≠ */\nconst a = 1; // trailing ≠\nconst b = '.';`;
    expect(renderedText(sample)).not.toContain('⇄');
    expect(renderedText(sample)).not.toContain('≠');
  });

  it('keeps real text when a comment is stripped from the same line', () => {
    expect(renderedText(`const x = '→'; // an arrow`)).toContain('→');
  });

  it('does not mistake a URL for a comment', () => {
    expect(renderedText(`const u = 'https://example.test/a';`)).toContain('https://example.test/a');
  });

  it('ignores accessible names, which are spoken rather than painted', () => {
    // Brace-matched, because the real site is a template literal with interpolations — a
    // `[^}]*` class stops at the first `}` of `${a}` and leaves the arrow in scope.
    const src = '<button aria-label={`Delete rule ${a} \u2192 ${b}`}>x</button>';
    expect(renderedText(src)).not.toContain('\u2192');
  });

  it('still catches a painted character on a line that also has an aria-label', () => {
    const src = '<button aria-label={`go ${x}`}>\u2192</button>';
    expect(renderedText(src)).toContain('\u2192');
  });
});
