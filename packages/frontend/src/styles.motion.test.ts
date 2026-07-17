import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Reduced-motion guard (dashboard-core spec): the stylesheet-wide media block must
 * collapse animations/transitions (incl. pseudo-elements and delays), and every
 * animation used ANYWHERE (stylesheet or inline TSX styles) must resolve to a
 * stylesheet-local keyframe so it is provably inside the guarded file. */

const SRC = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(SRC, 'styles.css'), 'utf8');

/** Balanced-brace extraction of the media block body. */
function mediaBlock(): string {
  const start = css.indexOf('@media (prefers-reduced-motion: reduce)');
  expect(start, 'guard media query present').toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced media block');
}

describe('reduced-motion guard', () => {
  it('collapses animation and transition, pseudo-elements and delays included', () => {
    const block = mediaBlock();
    expect(block).toMatch(/\*,\s*\*::before,\s*\*::after/);
    expect(block).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(block).toMatch(/animation-delay:\s*0ms\s*!important/);
    expect(block).toMatch(/animation-iteration-count:\s*1\s*!important/);
    expect(block).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
    expect(block).toMatch(/transition-delay:\s*0ms\s*!important/);
  });

  it('every animation used in CSS or inline TSX resolves to a local keyframe', () => {
    const defined = new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
    const collect = (source: string): string[] =>
      [...source.matchAll(/animation:\s*([^;"'}]+)/g)].flatMap((m) =>
        (m[1] as string)
          .split(',')
          .map((part) => /^\s*([\w-]+)/.exec(part)?.[1])
          .filter((n): n is string => n !== undefined && n !== 'none'),
      );

    const tsxFiles = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) return name === 'test' ? [] : tsxFiles(full);
        return full.endsWith('.tsx') && !full.endsWith('.test.tsx') ? [full] : [];
      });

    const used = [
      ...collect(css),
      ...tsxFiles(SRC).flatMap((f) => collect(readFileSync(f, 'utf8'))),
    ];
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) {
      expect(defined.has(name), `@keyframes ${name} defined in styles.css`).toBe(true);
    }
    // No orphaned keyframes either — dead motion is drift.
    for (const def of defined) {
      expect(used.includes(def as string), `@keyframes ${def ?? ''} actually used`).toBe(true);
    }
  });
});
