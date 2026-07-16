import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

/**
 * Production single-port topology (app-bootstrap): spawns the real
 * `npm start` (which must force NODE_ENV=production) and probes it over HTTP.
 * Requires a prior `npm run build` (frontend dist + control-plane dist).
 */

const repoRoot = join(__dirname, '..', '..', '..');
const frontendIndex = join(repoRoot, 'packages', 'frontend', 'dist', 'index.html');
const controlPlaneMain = join(repoRoot, 'packages', 'control-plane', 'dist', 'main.js');

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
  stop: () => Promise<void>;
}

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

  return { child, baseUrl, stop };
}

describe('production topology via `npm start` (app-bootstrap)', () => {
  beforeAll(() => {
    for (const artifact of [frontendIndex, controlPlaneMain]) {
      if (!existsSync(artifact)) {
        throw new Error(`Missing build artifact ${artifact} — run \`npm run build\` first.`);
      }
    }
  });

  it('serves SPA + API on one port; the fallback never swallows /api or /v1', async () => {
    const server = await startProdServer(undefined); // NODE_ENV unset → npm start must force production
    try {
      const shell = await fetch(`${server.baseUrl}/`);
      expect(shell.status).toBe(200);
      expect(shell.headers.get('content-type')).toContain('text/html');
      expect(await shell.text()).toContain('polyrouter');

      const health = await fetch(`${server.baseUrl}/api/health`, {
        headers: { Origin: 'http://evil.example' },
      });
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: 'ok' });
      expect(health.headers.get('access-control-allow-origin')).toBeNull();

      const deepLink = await fetch(`${server.baseUrl}/agents`);
      expect(deepLink.status).toBe(200);
      expect(deepLink.headers.get('content-type')).toContain('text/html');

      const unknownApi = await fetch(`${server.baseUrl}/api/nonexistent`);
      expect(unknownApi.status).toBe(404);
      expect(unknownApi.headers.get('content-type')).toContain('application/json');

      const unknownV1 = await fetch(`${server.baseUrl}/v1/nonexistent`);
      expect(unknownV1.status).toBe(404);
      expect(unknownV1.headers.get('content-type')).toContain('application/json');

      // #21/#22: the Prometheus scrape must reach Nest, never the SPA shell
      // (caught in-container by the packaging smoke pass).
      const metrics = await fetch(`${server.baseUrl}/metrics`);
      expect(metrics.status).toBe(200);
      expect(metrics.headers.get('content-type')).toContain('text/plain');
      expect(await metrics.text()).toContain('polyrouter_');
    } finally {
      await server.stop();
    }
  });

  it('forces production mode over an inherited NODE_ENV=development', async () => {
    const server = await startProdServer('development');
    try {
      const shell = await fetch(`${server.baseUrl}/`);
      expect(shell.status).toBe(200);
      expect(shell.headers.get('content-type')).toContain('text/html');

      const health = await fetch(`${server.baseUrl}/api/health`, {
        headers: { Origin: 'http://evil.example' },
      });
      expect(health.status).toBe(200);
      expect(health.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await server.stop();
    }
  });
});
