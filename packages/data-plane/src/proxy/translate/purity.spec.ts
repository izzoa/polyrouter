import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** All non-test `.ts` files in the translate module (recursive). */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('translation module is pure (no I/O)', () => {
  const files = sourceFiles(__dirname);

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('imports no network or database modules', () => {
    const forbidden = [
      /from ['"](?:node:)?https?['"]/,
      /from ['"](?:node:)?net['"]/,
      /from ['"](?:node:)?dns['"]/,
      /from ['"]undici['"]/,
      /from ['"]ioredis['"]/,
      /from ['"]redis['"]/,
      /from ['"]pg['"]/,
      /from ['"]drizzle-orm['"]/,
    ];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const re of forbidden) {
        expect({ file, matched: re.test(src) }).toEqual({ file, matched: false });
      }
    }
  });

  it('makes no network or clock calls', () => {
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      expect(src).not.toMatch(/\bfetch\s*\(/);
      expect(src).not.toMatch(/XMLHttpRequest/);
      expect(src).not.toMatch(/Date\.now\s*\(/);
      expect(src).not.toMatch(/new Date\s*\(/);
    }
  });
});
