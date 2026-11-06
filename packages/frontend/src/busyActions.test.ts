/**
 * No request-starting button skips the busy decision (adopt-design-tokens-v2 task 4.4,
 * design.md D14; dashboard-core "A new request-starting button cannot skip the busy state").
 *
 * Every call a component discards with `void` — the codebase's fire-and-forget idiom, which
 * the type-checked lint rules force on every request a click or an effect starts — must have
 * a row in `test/busyActionsTable.ts`, classed busy, switch, drawer, destructive, leaves the
 * page, unmounts on click, opens a dialog, or not a button. A new one fails here, naming its
 * file, line and call, until somebody decides. A row whose call is gone fails too, so the
 * table cannot rot into a list that classifies nothing.
 *
 * The parser reads the forms the tree uses: `void app.action(…)`, a `void app` chain split
 * across lines (`Batches.tsx`), a busy runner (`void x.run(() => app.action(…))`, with or
 * without a row key), a local call (`void load()`) and an async IIFE (`BodyCaptureCard.tsx`).
 * Comments are blanked first, keeping offsets, so a line number points at the real line.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUSY_ACTIONS } from './test/busyActionsTable';

const SRC = dirname(fileURLToPath(import.meta.url));

interface Site {
  key: string;
  file: string;
  line: number;
  call: string;
}

/** Blank comments to spaces, keeping newlines, so offsets and line numbers survive. A `//`
 * only opens a comment after whitespace or punctuation, never inside `https://`. */
export function stripComments(src: string): string {
  const blank = (s: string): string => s.replace(/[^\n]/g, ' ');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[\s;{}()])\/\/[^\n]*/g, (m, pre: string) => pre + blank(m.slice(pre.length)));
}

const VOID_CALL =
  /\bvoid\s+(?:[\w.]+\.run\(\s*(?:[^,()]+(?:\([^()]*\))?\s*,\s*)?\(\)\s*=>\s*)?(?:(app)\s*\.\s*(\w+)|\((async)\b|(\w+(?:\.\w+)?)\s*\()/g;

/** Every void-discarded call in one file's source, keyed as the table keys them. */
export function sitesIn(file: string, src: string): Site[] {
  const code = stripComments(src);
  const raw: { call: string; line: number }[] = [];
  for (const m of code.matchAll(VOID_CALL)) {
    const call =
      m[1] !== undefined
        ? `app.${m[2] ?? ''}`
        : m[3] !== undefined
          ? '(async () => …)()'
          : (m[4] ?? '');
    raw.push({ call, line: code.slice(0, m.index).split('\n').length });
  }
  const total = new Map<string, number>();
  for (const r of raw) total.set(r.call, (total.get(r.call) ?? 0) + 1);
  const nth = new Map<string, number>();
  return raw.map((r) => {
    const n = (nth.get(r.call) ?? 0) + 1;
    nth.set(r.call, n);
    const base = `${file} ${r.call}`;
    return { key: (total.get(r.call) ?? 0) > 1 ? `${base}#${String(n)}` : base, file, ...r };
  });
}

/** The component sources: every `.tsx` under `src` except tests, the test support folder
 * and the browser harness (a dev-only fixture, not shipped). */
function componentFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name !== 'test') walk(p);
      } else if (p.endsWith('.tsx') && !p.endsWith('.test.tsx') && name !== 'browserHarness.tsx') {
        out.push(p);
      }
    }
  };
  walk(SRC);
  return out.sort();
}

function allSites(): Site[] {
  return componentFiles().flatMap((p) => sitesIn(relative(SRC, p), readFileSync(p, 'utf8')));
}

describe('every request a component starts is classed (busy-action table)', () => {
  const sites = allSites();
  const rows = new Map(BUSY_ACTIONS.map((r) => [r.key, r]));

  it('finds the sites at all (not vacuous)', () => {
    expect(sites.length).toBeGreaterThan(80);
  });

  it('has a row for every void-discarded call, naming any that has none', () => {
    const missing = sites
      .filter((s) => !rows.has(s.key))
      .map((s) => `${s.file}:${String(s.line)} ${s.call} (key "${s.key}")`);
    expect(missing, `unclassed request-starting calls:\n${missing.join('\n')}`).toEqual([]);
  });

  it('has no row for a call that is gone', () => {
    const live = new Set(sites.map((s) => s.key));
    const stale = BUSY_ACTIONS.filter((r) => !live.has(r.key)).map((r) => r.key);
    expect(stale, `rows whose call no longer exists: ${stale.join(', ')}`).toEqual([]);
  });

  it('keys each row once', () => {
    const seen = new Set<string>();
    const dupes = BUSY_ACTIONS.filter((r) => (seen.has(r.key) ? true : (seen.add(r.key), false)));
    expect(dupes.map((r) => r.key)).toEqual([]);
  });

  it('gives every busy row a progressive label its own file renders', () => {
    for (const r of BUSY_ACTIONS.filter((x) => x.cls === 'busy')) {
      expect(r.busyLabel, `${r.key} names no busy label`).toBeDefined();
      const file = r.labelIn ?? r.key.split(' ')[0] ?? '';
      const src = readFileSync(join(SRC, file), 'utf8');
      expect(src, `${file} never renders "${r.busyLabel ?? ''}" (${r.key})`).toContain(
        r.busyLabel ?? '',
      );
    }
  });
});

describe('the site parser reads every form the tree uses (self-checks)', () => {
  const keys = (src: string): string[] => sitesIn('x.tsx', src).map((s) => s.key);

  it('reads a plain store call, and numbers repeats in source order', () => {
    expect(keys('a(() => void app.load()); b(() => void app.load(true));')).toEqual([
      'x.tsx app.load#1',
      'x.tsx app.load#2',
    ]);
  });

  it('reads a void app chain split across lines, as Batches.tsx writes one', () => {
    expect(keys('void app\n  .cancelBatch(id)\n  .then(done);')).toEqual(['x.tsx app.cancelBatch']);
  });

  it('reads through a busy runner, with or without a row key', () => {
    expect(
      keys('void t.run(() => app.testProviderById(id)); void m.run(a.id, () => app.rotateKey(a));'),
    ).toEqual(['x.tsx app.testProviderById', 'x.tsx app.rotateKey']);
  });

  it('reads a local call and an async IIFE', () => {
    expect(keys('void load(); void (async () => { await x(); })();')).toEqual([
      'x.tsx load',
      'x.tsx (async () => …)()',
    ]);
  });

  it('ignores a call inside a comment, and keeps the real line number', () => {
    const sites = sitesIn('x.tsx', '// void app.ghost()\n/* void app.ghost() */\nvoid app.real();');
    expect(sites.map((s) => [s.key, s.line])).toEqual([['x.tsx app.real', 3]]);
  });

  it('does not read a URL as a comment', () => {
    expect(keys("const u = 'https://x'; void app.after();")).toEqual(['x.tsx app.after']);
  });
});
