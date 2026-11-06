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
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bundledFaces, bundledFamilyCoverage, bundledFontCoverage } from './test/fontCoverage';
// The extraction lives in `test/renderedText.ts`, shared with `figureStrings.test.ts`, so both
// guards read the same painted text (adopt-figure-states task 6.1).
import { findSrc, renderedText, shippedSources } from './test/renderedText';

const SRC = findSrc();

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

  it('reads every bundled face from fonts.css, the math faces included (adopt-figure-states D7)', () => {
    // The list is derived, not hard-coded: a face declared in fonts.css is checked, and one
    // removed there stops counting as coverage.
    const files = bundledFaces().flatMap((f) => f.files);
    expect(files).toEqual([
      'geist-latin-ext.woff2',
      'geist-latin.woff2',
      'geist-mono-latin-ext.woff2',
      'geist-mono-latin.woff2',
      'geist-math.woff2',
      'geist-mono-math.woff2',
    ]);
  });

  it('both families carry `≤` (U+2264), so the reserved ceiling never falls back', () => {
    // A union over every file would pass with the glyph in one family only, while text set in
    // the other family still fell back to the operating system's font.
    for (const family of ['Geist', 'Geist Mono']) {
      const covered = bundledFamilyCoverage(family);
      expect(covered.has('A'.codePointAt(0)!), `${family}: the reader is broken`).toBe(true);
      expect(covered.has(0x2264), `${family} has no ≤ (U+2264)`).toBe(true);
    }
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
