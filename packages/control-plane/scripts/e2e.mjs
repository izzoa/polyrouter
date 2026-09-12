#!/usr/bin/env node
/**
 * e2e runner. Targeted runs (`npm run test:e2e -- cascade-routing`) pass straight
 * through to one jest invocation, unchanged. A FULL run is split into separate
 * PROCESSES, because two of the specs cannot share one.
 *
 * Why: `auth.e2e-spec.ts` and `user-admin.e2e-spec.ts` are the only e2e specs that
 * construct the Better Auth stack, and Better Auth is ESM-only (`"type": "module"`,
 * .mjs exports, no CJS build), so loading it needs Node's native dynamic import —
 * which is why the e2e run sets `--experimental-vm-modules`. Under that flag Jest
 * caches an imported ESM module across test FILES but binds it to the VM context of
 * whichever file imported it first. That context is destroyed when the file ends, so
 * the SECOND of the two to build an app imports into a dead realm and gets
 * `You are trying to 'import' a file after the Jest environment has been torn down`,
 * raised from inside jest-runtime and attributed to the file that OWNS the realm
 * rather than the one that failed. Jest orders files by cached duration, so which
 * file owns it moves between runs — which is why this presented for a long time as an
 * intermittent "auth e2e flake" with a rotating cast of victims and a failure count
 * that changed every run (27 → 25 → 0 → 17 across four consecutive full runs).
 *
 * Nothing in-repo can fix it from inside the process: every cache reachable from test
 * code (`globalThis`, `process`) is per-file under Jest, and memoizing the import does
 * not help because it is the import ITSELF that throws. One process per file is the
 * fix, and it is exact — each owns a live realm. Verified: run together, the second
 * fails 8/8; run apart, 17 and 8 pass.
 *
 * If a third spec ever builds an auth app, add it to ISOLATED.
 */
import { spawnSync } from 'node:child_process';

const ISOLATED = ['test/auth/auth.e2e-spec.ts', 'test/auth/user-admin.e2e-spec.ts'];
const BASE = ['jest', '--config', 'jest-e2e.config.cjs', '--runInBand'];
const passthrough = process.argv.slice(2);

const jest = (args) => {
  const r = spawnSync('npx', ['cross-env', 'NODE_OPTIONS=--experimental-vm-modules', ...args], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return r.status ?? 1;
};

// A targeted run is one invocation: the caller chose the scope, so do not reinterpret
// it. Isolation only matters when the two specs would otherwise share a process.
if (passthrough.length > 0) process.exit(jest([...BASE, ...passthrough]));

const ignore = ISOLATED.map((p) => `${p.replace(/\./g, '\\.')}$`);
let code = jest([...BASE, '--testPathIgnorePatterns', ...ignore]);
for (const spec of ISOLATED) {
  // Run every isolated spec even after a failure: one red suite must not hide the
  // state of the others, which is the habit that let this hide for so long.
  const c = jest([...BASE, '--runTestsByPath', spec]);
  if (c !== 0) code = c;
}
process.exit(code);
