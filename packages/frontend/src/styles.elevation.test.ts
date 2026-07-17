import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Flat-borders elevation lock (STYLESEED.md / dashboard-core spec): light shadows are
 * whispers (alpha ≤ 0.08) passing through theme tokens; dark renders NO drop shadows;
 * nothing hardcodes a shadow outside the tokens — in CSS or inline TSX styles. */

const SRC = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(SRC, 'styles.css'), 'utf8');

function block(selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `selector ${selector} present`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  return css.slice(open + 1, css.indexOf('}', open));
}

function shadowTokens(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--(shadow[\w-]*):\s*([^;]+);/g)) {
    out[m[1] as string] = (m[2] as string).trim();
  }
  return out;
}

describe('elevation lock (flat-borders)', () => {
  const rootTokens = shadowTokens(block(':root'));
  const darkTokens = shadowTokens(block("[data-theme='dark']"));

  it('light shadow tokens exist and stay under the 8% whisper cap', () => {
    expect(Object.keys(rootTokens).length).toBeGreaterThanOrEqual(5);
    for (const [name, value] of Object.entries(rootTokens)) {
      const alphas = [...value.matchAll(/rgba?\([^)]*?,\s*([\d.]+)\)/g)].map((m) =>
        Number(m[1]),
      );
      expect(alphas.length, `--${name} declares an rgba alpha`).toBeGreaterThan(0);
      for (const a of alphas) {
        expect(a, `--${name} alpha ${a} ≤ 0.08`).toBeLessThanOrEqual(0.08);
      }
    }
  });

  it('the dark theme overrides EVERY root shadow token with none', () => {
    // Set equality: a new root token without a dark override must fail here.
    expect(Object.keys(darkTokens).sort()).toEqual(Object.keys(rootTokens).sort());
    for (const [name, value] of Object.entries(darkTokens)) {
      expect(value, `dark --${name}`).toBe('none');
    }
  });

  it('class rules never hardcode box-shadow outside the tokens', () => {
    for (const m of css.matchAll(/box-shadow:\s*([^;]+);/g)) {
      expect(m[1]?.trim(), `box-shadow "${m[1] ?? ''}"`).toMatch(/^var\(--shadow[\w-]*\)$/);
    }
  });

  it('TSX inline styles never introduce shadows (box-shadow / drop-shadow)', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) return name === 'test' ? [] : walk(full);
        return full.endsWith('.tsx') && !full.endsWith('.test.tsx') ? [full] : [];
      });
    for (const file of walk(SRC)) {
      const source = readFileSync(file, 'utf8');
      expect(source, `${file} has no inline box-shadow`).not.toMatch(/box-shadow/i);
      expect(source, `${file} has no drop-shadow filter`).not.toMatch(/drop-shadow/i);
    }
  });
});
