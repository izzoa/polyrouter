import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

/**
 * Production single-port topology (app-bootstrap): spawns the real
 * `npm start` (which must force NODE_ENV=production) and probes it over HTTP.
 * Requires a prior `npm run build` (frontend dist + control-plane dist).
 *
 * CI-hardened: every probe carries an abort deadline (a served-but-stalled
 * response fails in seconds, attributed to its line — never a mute jest
 * timeout), any failure rethrows WITH the server's captured stdout/stderr,
 * and spawned children are reaped in afterEach so jest always exits.
 */

const repoRoot = join(__dirname, '..', '..', '..');
const frontendIndex = join(repoRoot, 'packages', 'frontend', 'dist', 'index.html');
const controlPlaneMain = join(repoRoot, 'packages', 'control-plane', 'dist', 'main.js');

/** Per-request bound: generous for a loaded 2-vCPU CI runner, tiny next to jest's 120s. */
const PROBE_TIMEOUT_MS = 15_000;

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

/** Every child ever spawned — reaped in afterEach so a failed test can never
 * leak a live `npm start` (which would hold jest open until the job timeout). */
const spawnedChildren: ChildProcess[] = [];

async function startProdServer(nodeEnv: string | undefined): Promise<RunningServer> {
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
  if (nodeEnv !== undefined) {
    env['NODE_ENV'] = nodeEnv;
  }

  const child = spawn('npm', ['start'], { cwd: repoRoot, env });
  spawnedChildren.push(child);
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));

  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`npm start exited early (${String(child.exitCode)}):\n${output}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(`server did not become healthy in time:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      child.once('close', () => {
        clearTimeout(killTimer);
        resolve();
      });
      child.kill('SIGTERM');
    });

  return { child, baseUrl, output: () => output, stop };
}

/** Deadline-bound GET so a stalled response is a fast, line-attributed failure. */
function probe(url: string, headers?: Record<string, string>): Promise<Response> {
  return fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
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

/** Boot, run the probes, always stop; on ANY failure rethrow with the server's
 * captured output appended — CI failures must carry the server's side of the story. */
async function withProdServer(
  nodeEnv: string | undefined,
  run: (server: RunningServer) => Promise<void>,
): Promise<void> {
  const server = await startProdServer(nodeEnv);
  try {
    await run(server);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${detail}\n--- server output ---\n${server.output()}`);
  } finally {
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
    // Reap anything a failed test left behind; a lingering child would hold
    // jest open ("Jest did not exit…") until the CI job timeout.
    for (const child of spawnedChildren.splice(0)) {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
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
