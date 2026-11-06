/** What the bundled fonts ACTUALLY contain (replace-fallback-symbol-glyphs).
 *
 * Reads the `cmap` out of each bundled woff2 rather than trusting the `unicode-range`
 * declarations in `fonts.css`. The two are not the same thing, and the difference is the whole
 * point: a range restricts which face the browser may SELECT, while the cmap decides whether
 * the glyph exists at all. A character inside a declared range but absent from the file falls
 * back exactly as an excluded one does — `fonts.css` declares `U+0100-02BA` and the files do
 * not contain U+0114.
 *
 * Decoded here rather than with a font library, because a woff2 is a brotli-compressed sfnt
 * and Node has brotli built in. That keeps a test-only concern from adding a dependency to a
 * project that deliberately bundles its own fonts and refuses an icon library. The risk of a
 * hand-rolled parser is that it silently returns nonsense — which is why `glyphCoverage.test`
 * asserts a positive control ("A" must read as PRESENT) before it trusts any absence.
 *
 * The file list is read from `fonts.css` itself — every `src: url(...)` of every `@font-face`
 * (adopt-figure-states D7) — so no bundled face can be declared there and left out of the
 * check, and a face removed there stops counting as coverage.
 */
import { brotliDecompressSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Walks up from the working directory to find `public/fonts`.
 *
 * Not `new URL(..., import.meta.url)`: Vite rewrites module URLs to its `/@fs/` scheme, so
 * that resolves to a path that does not exist on disk and the reader fails with a confusing
 * ENOENT rather than a missing glyph. */
function findFontDir(): string {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'public', 'fonts');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate packages/frontend/public/fonts from ' + process.cwd());
}

const FONT_DIR = findFontDir();

/** One `@font-face` of `fonts.css`: its family and the bundled files its `src` names. */
export interface BundledFace {
  family: string;
  files: string[];
}

/** Every `@font-face` declared in `fonts.css`, in order, with comments stripped first so a
 * commented-out face (or a command in the header) never counts. Only `/fonts/` URLs are
 * read: the packaged SPA bundles its fonts and fetches none from a third party. */
export function bundledFaces(): BundledFace[] {
  const css = readFileSync(join(FONT_DIR, 'fonts.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const faces: BundledFace[] = [];
  for (const block of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = block[1] ?? '';
    const family = /font-family:\s*['"]?([^'";]+?)['"]?\s*;/.exec(body)?.[1];
    if (family === undefined) throw new Error(`an @font-face in fonts.css has no font-family`);
    const files = [...body.matchAll(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/g)].map((m) => {
      const url = m[1] ?? '';
      if (!url.startsWith('/fonts/')) throw new Error(`fonts.css loads ${url}, not a bundled font`);
      return url.slice('/fonts/'.length);
    });
    if (files.length === 0) throw new Error(`the ${family} @font-face in fonts.css has no src url`);
    faces.push({ family, files });
  }
  if (faces.length === 0) throw new Error('fonts.css declares no @font-face');
  return faces;
}

/** Variable-length integer used by the woff2 table directory (7 bits per byte, high bit
 * continues). Returns the value and how many bytes it consumed. */
function readBase128(buf: Buffer, at: number): [value: number, next: number] {
  let value = 0;
  let i = at;
  for (let b = 0; b < 5; b++) {
    const byte = buf[i++]!;
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return [value, i];
  }
  throw new Error('malformed UIntBase128 in woff2 table directory');
}

/** Locates the `cmap` table inside a woff2 and returns its decompressed bytes.
 *
 * The container stores a directory of table lengths followed by ONE brotli stream holding
 * every table back to back in directory order, so the table's offset is the running sum of
 * the lengths before it. Only `glyf`/`loca` are ever transformed (which is what a present
 * `transformLength` signals); `cmap` never is, so its stored length is its real one. */
function cmapTableOf(woff2: Buffer): Buffer | null {
  if (woff2.toString('ascii', 0, 4) !== 'wOF2') throw new Error('not a woff2 file');
  const numTables = woff2.readUInt16BE(12);

  let p = 48; // past the fixed header
  let offset = 0;
  let found: { offset: number; length: number } | null = null;

  for (let i = 0; i < numTables; i++) {
    const flags = woff2[p++]!;
    const tagIndex = flags & 0x3f;
    let tag: string;
    if (tagIndex === 0x3f) {
      tag = woff2.toString('ascii', p, p + 4);
      p += 4;
    } else {
      // Index 0 is 'cmap' in the spec's known-tag table. Only cmap needs naming here; every
      // other table is just a length to step over.
      tag = tagIndex === 0 ? 'cmap' : `#${String(tagIndex)}`;
    }
    const [origLength, afterOrig] = readBase128(woff2, p);
    p = afterOrig;

    // A transformLength is present only for a transformed table, i.e. glyf/loca with
    // transform version 0. Tag indices 10 and 11 are glyf and loca.
    const transformVersion = (flags >> 6) & 0x03;
    let length = origLength;
    if ((tagIndex === 10 || tagIndex === 11) && transformVersion === 0) {
      const [transformLength, afterTransform] = readBase128(woff2, p);
      p = afterTransform;
      length = transformLength;
    }

    if (tag === 'cmap') found = { offset, length };
    offset += length;
  }
  if (!found) return null;

  const stream = brotliDecompressSync(woff2.subarray(p));
  return stream.subarray(found.offset, found.offset + found.length);
}

/** Every codepoint the `cmap` maps to a real glyph, across subtable formats 4 and 12. */
function codepointsFromCmap(cmap: Buffer): Set<number> {
  const out = new Set<number>();
  const numSub = cmap.readUInt16BE(2);

  for (let i = 0; i < numSub; i++) {
    const tableOff = cmap.readUInt32BE(4 + i * 8 + 4);
    if (tableOff + 4 > cmap.length) continue;
    const format = cmap.readUInt16BE(tableOff);

    if (format === 4) {
      const segX2 = cmap.readUInt16BE(tableOff + 6);
      const ends = tableOff + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const ranges = deltas + segX2;
      for (let s = 0; s < segX2 / 2; s++) {
        const end = cmap.readUInt16BE(ends + s * 2);
        const start = cmap.readUInt16BE(starts + s * 2);
        if (start > end) continue;
        const delta = cmap.readInt16BE(deltas + s * 2);
        const rangeOff = cmap.readUInt16BE(ranges + s * 2);
        for (let cp = start; cp <= end && cp !== 0xffff; cp++) {
          let gid: number;
          if (rangeOff === 0) {
            gid = (cp + delta) & 0xffff;
          } else {
            const gi = ranges + s * 2 + rangeOff + (cp - start) * 2;
            if (gi + 1 >= cmap.length) continue;
            gid = cmap.readUInt16BE(gi);
            if (gid !== 0) gid = (gid + delta) & 0xffff;
          }
          if (gid !== 0) out.add(cp);
        }
      }
    } else if (format === 12) {
      const nGroups = cmap.readUInt32BE(tableOff + 12);
      for (let g = 0; g < nGroups; g++) {
        const rec = tableOff + 16 + g * 12;
        const start = cmap.readUInt32BE(rec);
        const end = cmap.readUInt32BE(rec + 4);
        for (let cp = start; cp <= end; cp++) out.add(cp);
      }
    }
  }
  return out;
}

/** Every codepoint one bundled file maps. */
function fileCoverage(file: string): Set<number> {
  const cmap = cmapTableOf(readFileSync(join(FONT_DIR, file)));
  if (!cmap) throw new Error(`no cmap table found in ${file}`);
  return codepointsFromCmap(cmap);
}

let cache: Set<number> | null = null;

/** Every codepoint present in at least one bundled font file. */
export function bundledFontCoverage(): Set<number> {
  if (cache) return cache;
  const all = new Set<number>();
  for (const face of bundledFaces())
    for (const f of face.files) for (const cp of fileCoverage(f)) all.add(cp);
  cache = all;
  return all;
}

/** Every codepoint one family's bundled faces map together. A glyph present in Geist Mono
 * alone still falls back wherever the text is set in Geist, so a glyph that must render in
 * either face is checked per family. */
export function bundledFamilyCoverage(family: string): Set<number> {
  const out = new Set<number>();
  for (const face of bundledFaces().filter((f) => f.family === family))
    for (const f of face.files) for (const cp of fileCoverage(f)) out.add(cp);
  return out;
}
