import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Toolchain-refusal check (tasks 1.6): asserts the engine pins that make
 * `npm ci` refuse an unsupported toolchain are present and correct.
 *
 * One-off manual verification (documented here because it needs a second
 * Node install): running `npm ci` under Node 22 fails with EBADENGINE, e.g.
 *   nvm exec 22 npm ci  →  "Unsupported engine ... required: { node: '>=24 <25' }"
 */

function readRootFile(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../${relativePath}`, import.meta.url)), 'utf8');
}

describe('toolchain pins (monorepo-workspace)', () => {
  const rootPackageJson = JSON.parse(readRootFile('package.json')) as {
    engines?: { node?: string; npm?: string };
    packageManager?: string;
  };

  it('pins Node 24.x and npm 10-11 via engines', () => {
    expect(rootPackageJson.engines?.node).toBe('>=24 <25');
    expect(rootPackageJson.engines?.npm).toBe('>=10 <12');
  });

  it('pins the exact package manager for reproducibility', () => {
    expect(rootPackageJson.packageManager).toMatch(/^npm@1[01]\.\d+\.\d+/);
  });

  it('enforces the engines range at install time (engine-strict)', () => {
    expect(readRootFile('.npmrc')).toMatch(/^engine-strict\s*=\s*true$/m);
  });

  it('records the Node major for version managers (.nvmrc)', () => {
    expect(readRootFile('.nvmrc').trim()).toBe('24');
  });
});
