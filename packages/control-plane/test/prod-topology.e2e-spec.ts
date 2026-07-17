import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

/**
 * Production single-port topology (app-bootstrap): boots the real compiled
 * server (`node dist/main.js`) in production and probes it over HTTP.
 * Requires a prior `npm run build` (frontend dist + control-plane dist).
 *
 * CI-hardened after the first GitHub run hung two ways:
 *  - The app defaults NODE_ENV=development; only `cross-env NODE_ENV=production`
 *    (the `npm start` script) forces production, and SPA serving is gated on it.
 *    We invoke `cross-env` DIRECTLY — not `npm start` — so the process tree is
 *    just cross-env → node, with no npm/sh wrapper that swallows SIGTERM (which
 *    leaked the server, held jest open, and starved the next test).
 *  - The child is spawned `detached` and reaped by process GROUP, so the whole
 *    tree dies on stop/afterEach.
 *  - Every probe carries an abort deadline AND the whole scenario races a
 *    self-imposed deadline shorter than jest's, so a stall fails FAST with the
 *    server's captured stdout/stderr — never a mute 120s jest timeout again.
 */

const repoRoot = join(__dirname, '..', '..', '..');
const frontendIndex = join(repoRoot, 'packages', 'frontend', 'dist', 'index.html');
const controlPlaneMain = join(repoRoot, 'packages', 'control-plane', 'dist', 'main.js');
const crossEnvBin = join(repoRoot, 'node_modules', '.bin', 'cross-env');

/** Per-request bound: generous for a loaded 2-vCPU CI runner, tiny next to jest's 120s. */
const PROBE_TIMEOUT_MS = 15_000;
/** Whole-scenario bound: must beat jest's 120s so OUR error (with server output) wins. */
const SCENARIO_TIMEOUT_MS = 90_000;
/** Boot health-poll bound. */
const BOOT_TIMEOUT_MS = 45_000;

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

interface RunningServer {
  child: ChildProcess;
  baseUrl: string;
  output: () => string;
  stop: () => Promise<void>;
}

/** Every child ever spawned — reaped by process group in afterEach so a failed
 * test can never leak a live server (which would hold jest open until the job
 * timeout and starve the next test). */
const spawnedChildren: ChildProcess[] = [];

/** Kill the child's whole process group (cross-env → node), tolerating a
 * group that has already exited. */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, signal); // negative pid → the detached group
  } catch {
    // group already gone
  }
}

async function startProdServer(inheritedNodeEnv: string | undefined): Promise<RunningServer> {
  const port = await getFreePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    // The real app now includes the auth + provider + notification planes; production requires real secrets.
    BETTER_AUTH_SECRET: 'a'.repeat(64),
    API_KEY_HMAC_SECRET: 'b'.repeat(64),
    PROVIDER_CREDENTIAL_KEY: 'c'.repeat(64),
    NOTIFY_CREDENTIALS_SECRET: 'd'.repeat(64),
    METRICS_ENABLED: 'true', // pinned — a developer shell must not flip the /metrics assertion
  };
  delete env['NODE_ENV'];
  delete env['SEED_DATA'];
  // The scenario under test: cross-env forces NODE_ENV=production over whatever
  // the ambient shell inherited (unset, or an explicit `development`).
  if (inheritedNodeEnv !== undefined) {
    env['NODE_ENV'] = inheritedNodeEnv;
  }

  // `cross-env NODE_ENV=production node dist/main.js`, spawned directly (no npm
  // or sh wrapper) and as its own process-group leader so we can reap the tree.
  const child = spawn(
    crossEnvBin,
    ['NODE_ENV=production', process.execPath, controlPlaneMain],
    { cwd: repoRoot, env, detached: true },
  );
  spawnedChildren.push(child);
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));

  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (${String(child.exitCode)}):\n${output}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(`server did not become healthy within ${String(BOOT_TIMEOUT_MS)}ms:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      const killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), 8_000);
      child.once('close', () => {
        clearTimeout(killTimer);
        resolve();
      });
      killGroup(child, 'SIGTERM');
    });

  return { child, baseUrl, output: () => output, stop };
}

/** Deadline-bound GET so a stalled response is a fast, line-attributed failure. */
function probe(url: string, headers?: Record<string, string>): Promise<Response> {
  const init: RequestInit = { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) };
  if (headers !== undefined) {
    init.headers = headers;
  }
  return fetch(url, init);
}

/** Bound body reads too — fetch resolves on HEADERS, so a body that never
 * finishes would otherwise hang `text()` forever with the status checks green. */
function bounded<T>(what: string, p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${what} did not complete within ${String(PROBE_TIMEOUT_MS)}ms`)),
        PROBE_TIMEOUT_MS,
      ).unref(),
    ),
  ]);
}

/** Boot, run the probes under a self-imposed deadline, always stop; on ANY
 * failure (including the deadline) rethrow with the server's captured output —
 * CI failures must fail FAST and carry the server's side of the story, never a
 * mute jest timeout. */
async function withProdServer(
  inheritedNodeEnv: string | undefined,
  run: (server: RunningServer) => Promise<void>,
): Promise<void> {
  const server = await startProdServer(inheritedNodeEnv);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`scenario exceeded ${String(SCENARIO_TIMEOUT_MS)}ms`)),
        SCENARIO_TIMEOUT_MS,
      );
    });
    await Promise.race([run(server), deadline]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${detail}\n--- server output ---\n${server.output()}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await server.stop();
  }
}

describe('production topology via `npm start` (app-bootstrap)', () => {
  beforeAll(() => {
    for (const artifact of [frontendIndex, controlPlaneMain]) {
      if (!existsSync(artifact)) {
        throw new Error(`Missing build artifact ${artifact} — run \`npm run build\` first.`);
      }
    }
  });

  afterEach(async () => {
    // Reap by process group anything a failed test left behind; a lingering
    // server would hold jest open ("Jest did not exit…") until the job timeout.
    for (const child of spawnedChildren.splice(0)) {
      if (child.exitCode === null) {
        killGroup(child, 'SIGKILL');
        await new Promise((r) => child.once('close', r));
      }
    }
  });

  it('serves SPA + API on one port; the fallback never swallows /api or /v1', async () => {
    await withProdServer(undefined, async (server) => {
      // NODE_ENV unset → npm start must force production
      const shell = await probe(`${server.baseUrl}/`);
      expect(shell.status).toBe(200);
      expect(shell.headers.get('content-type')).toContain('text/html');
      expect(await bounded('SPA shell body', shell.text())).toContain('polyrouter');

      const health = await probe(`${server.baseUrl}/api/health`, {
        Origin: 'http://evil.example',
      });
      expect(health.status).toBe(200);
      expect(await bounded('health body', health.json())).toEqual({ status: 'ok' });
      expect(health.headers.get('access-control-allow-origin')).toBeNull();

      const deepLink = await probe(`${server.baseUrl}/agents`);
      expect(deepLink.status).toBe(200);
      expect(deepLink.headers.get('content-type')).toContain('text/html');
      await bounded('deep-link body', deepLink.text());

      const unknownApi = await probe(`${server.baseUrl}/api/nonexistent`);
      expect(unknownApi.status).toBe(404);
      expect(unknownApi.headers.get('content-type')).toContain('application/json');

      const unknownV1 = await probe(`${server.baseUrl}/v1/nonexistent`);
      expect(unknownV1.status).toBe(404);
      expect(unknownV1.headers.get('content-type')).toContain('application/json');

      // E9.2: an UPPER-CASE /API or /V1 path must also reach Nest, never the SPA
      // shell (otherwise the case-insensitive session guard would be bypassed).
      const upperApi = await probe(`${server.baseUrl}/API/nonexistent`);
      expect(upperApi.status).toBe(404);
      expect(upperApi.headers.get('content-type')).not.toContain('text/html');
      const upperV1 = await probe(`${server.baseUrl}/V1/nonexistent`);
      expect(upperV1.status).toBe(404);
      expect(upperV1.headers.get('content-type')).not.toContain('text/html');

      // #21/#22: the Prometheus scrape must reach Nest, never the SPA shell
      // (caught in-container by the packaging smoke pass).
      const metrics = await probe(`${server.baseUrl}/metrics`);
      expect(metrics.status).toBe(200);
      expect(metrics.headers.get('content-type')).toContain('text/plain');
      expect(await bounded('metrics body', metrics.text())).toContain('polyrouter_');
    });
  });

  it('forces production mode over an inherited NODE_ENV=development', async () => {
    await withProdServer('development', async (server) => {
      const shell = await probe(`${server.baseUrl}/`);
      expect(shell.status).toBe(200);
      expect(shell.headers.get('content-type')).toContain('text/html');
      await bounded('SPA shell body', shell.text());

      const health = await probe(`${server.baseUrl}/api/health`, {
        Origin: 'http://evil.example',
      });
      expect(health.status).toBe(200);
      expect(health.headers.get('access-control-allow-origin')).toBeNull();
    });
  });
});
