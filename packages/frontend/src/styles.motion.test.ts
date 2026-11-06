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

/** The Live lamp (dashboard-event-stream "The Live lamp blinks only when stream data arrives";
 * adopt-design-tokens-v2 task 13.3, design.md D12): one event-driven blink, never a loop. */
describe('the Live lamp blinks from a stylesheet-local keyframe, and rests steady under reduced motion', () => {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const keyframes = (name: string): string => {
    const at = code.indexOf(`@keyframes ${name}`);
    expect(at, `@keyframes ${name} is defined in styles.css`).toBeGreaterThanOrEqual(0);
    const open = code.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}' && --depth === 0) return code.slice(open + 1, i);
    }
    throw new Error(`unbalanced @keyframes ${name}`);
  };

  it('.lamp-blink plays lamp-blink once, over 600ms — no iteration count, so never a loop', () => {
    const rule = /\.lamp-blink\s*\{([^}]*)\}/.exec(code)?.[1] ?? '';
    expect(rule.trim()).toBe('animation: lamp-blink 600ms ease-out;');
  });

  it('the keyframe is visible, dimmed to 0.35, and visible again', () => {
    const frames = keyframes('lamp-blink').replace(/\s+/g, ' ').trim();
    expect(frames).toBe('0%, 100% { opacity: 1; } 50% { opacity: 0.35; }');
  });

  it('under reduced motion the one blink collapses to a frame that ends fully visible: a steady dot', () => {
    // The guard forces every animation to one 0.01ms iteration; the lamp's keyframe ENDS at
    // opacity 1, so what remains is the dot at rest — the archived "the live indicator rests
    // fully visible". A keyframe ending dimmed, or an infinite loop the guard would cut short
    // mid-cycle, would leave it otherwise.
    expect(keyframes('lamp-blink')).toMatch(/100%[^{]*\{\s*opacity:\s*1;/);
    expect(code).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-iteration-count:\s*1\s*!important/,
    );
  });

  it('the live dot no longer pulses forever', () => {
    expect(code).not.toMatch(/\.live-dot\b/);
    const topbar = readFileSync(join(SRC, 'components/Topbar.tsx'), 'utf8');
    expect(topbar).not.toMatch(/\bpulse\b|infinite/);
    expect(topbar).toContain("'lamp-blink'");
  });
});

/** The lock's motion line moves with the stylesheet (STYLESEED.md L13; adopt-design-tokens-v2
 * task 13.4, design.md D17; DESIGN.md Motion): state moves only — loops where they are required,
 * the Live lamp's event-driven blink, enter moves for surfaces, and no page-load choreography.
 * Every keyframe the line names must be defined in styles.css, and every keyframe styles.css
 * defines must be named on the line, so neither can move without the other. */
describe('the lock names exactly the keyframes styles.css defines (STYLESEED.md L13)', () => {
  const lock = readFileSync(join(SRC, '..', '..', '..', 'STYLESEED.md'), 'utf8');
  const line = lock.split('\n').find((l) => l.startsWith('- Motion seed:')) ?? '';
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const defined = [...code.matchAll(/@keyframes\s+([-\w]+)/g)].map((m) => m[1] as string);
  const named = [...line.matchAll(/`([-\w]+)`/g)].map((m) => m[1] as string);

  it('the motion line is present', () => {
    expect(line, 'STYLESEED.md lost its "- Motion seed:" line').not.toBe('');
  });

  it('names the required loop, the event-driven Live blink and no page-load choreography', () => {
    expect(line).toContain('`pulse`');
    expect(line).toContain('`lamp-blink`');
    expect(line).toMatch(/event-driven/);
    expect(line).toMatch(/no page-load choreography/);
    // The keyword moves the lock used to allow: a cascade is page-load choreography, and no
    // shimmer keyframe exists (DESIGN.md's skeletons pulse).
    expect(line).not.toMatch(/stagger-cascade|shimmer|pulse-beat/);
  });

  it('every keyframe the line names is defined in styles.css', () => {
    expect(named.filter((n) => !defined.includes(n))).toEqual([]);
  });

  it('every keyframe styles.css defines is named on the line', () => {
    expect(defined.length).toBeGreaterThan(0);
    expect(defined.filter((d) => !named.includes(d))).toEqual([]);
  });
});
