import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { loadConfig } from '@polyrouter/shared';
import { Pool } from 'pg';
import { DatabaseModule } from '../src/database/database.module';
import '../src/database/database.config';
import { COMPOSE_HINT } from './tenancy/harness';

/** Migrations-on-boot DoD: idempotent re-runs, self-contained production
 * build, and fail-fast (no port bound) when the database is unusable. */

const repoRoot = join(__dirname, '..', '..', '..');
const builtMain = join(repoRoot, 'packages', 'control-plane', 'dist', 'main.js');

function adminUrl(databaseUrl: string, db = 'postgres'): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${db}`;
  return url.toString();
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

describe('migrations on boot (database-schema)', () => {
  const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;

  beforeAll(async () => {
    const probe = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await probe.query('SELECT 1');
    } catch (error) {
      throw new Error(`${COMPOSE_HINT}\n(${(error as Error).message})`);
    } finally {
      await probe.end();
    }
  });

  it('boot is idempotent: a second init applies nothing and succeeds', async () => {
    for (let boot = 0; boot < 2; boot++) {
      const moduleRef = await Test.createTestingModule({ imports: [DatabaseModule] }).compile();
      const app = moduleRef.createNestApplication();
      await app.init();
      await app.close();
    }
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const tables = await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
      );
      const names = tables.rows.map((r: { table_name: string }) => r.table_name);
      for (const expected of [
        'user',
        'agent',
        'provider',
        'model',
        'tier',
        'routing_entry',
        'routing_rule',
      ]) {
        expect(names).toContain(expected);
      }
    } finally {
      await pool.end();
    }
  }, 60_000);

  it('the built app migrates a fresh database before serving', async () => {
    expect(existsSync(builtMain)).toBe(true);
    const dbName = `polyrouter_built_${Math.random().toString(36).slice(2, 8)}`;
    const admin = new Pool({ connectionString: adminUrl(databaseUrl), max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const freshUrl = adminUrl(databaseUrl, dbName);
    const port = await getFreePort();
    const env = {
      ...process.env,
      DATABASE_URL: freshUrl,
      PORT: String(port),
      NODE_ENV: 'production',
      BETTER_AUTH_SECRET: 'a'.repeat(64),
      API_KEY_HMAC_SECRET: 'b'.repeat(64),
      PROVIDER_CREDENTIAL_KEY: 'c'.repeat(64),
    };
    delete env['SEED_DATA'];
    const child = spawn(process.execPath, [builtMain], { env });
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    try {
      const deadline = Date.now() + 30_000;
      let healthy = false;
      while (Date.now() < deadline && !healthy) {
        if (child.exitCode !== null) break;
        try {
          const res = await fetch(`http://127.0.0.1:${String(port)}/api/health`, {
            signal: AbortSignal.timeout(1000),
          });
          healthy = res.ok;
        } catch {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      expect(healthy).toBe(true);
      const fresh = new Pool({ connectionString: freshUrl, max: 1 });
      try {
        const tables = await fresh.query(
          `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'routing_entry'`,
        );
        expect(tables.rows[0].n).toBe(1);
      } finally {
        await fresh.end();
      }
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('close', resolve));
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.end();
      if (
        child.exitCode !== 0 &&
        child.exitCode !== null &&
        !output.includes('polyrouter listening')
      ) {
        // aid debugging on failure
        console.error(output.slice(-2000));
      }
    }
  }, 90_000);

  it('an unusable database fails the boot without ever binding the port', async () => {
    const port = await getFreePort();
    const env = {
      ...process.env,
      DATABASE_URL: 'postgresql://polyrouter:polyrouter@127.0.0.1:59999/polyrouter',
      PORT: String(port),
      NODE_ENV: 'production',
      BETTER_AUTH_SECRET: 'a'.repeat(64),
      API_KEY_HMAC_SECRET: 'b'.repeat(64),
      PROVIDER_CREDENTIAL_KEY: 'c'.repeat(64),
    };
    delete env['SEED_DATA'];
    const child = spawn(process.execPath, [builtMain], { env });
    let bound = false;
    const exitCode: number = await new Promise((resolve) => {
      const probe = setInterval(() => {
        void fetch(`http://127.0.0.1:${String(port)}/api/health`, {
          signal: AbortSignal.timeout(300),
        })
          .then(() => (bound = true))
          .catch(() => undefined);
      }, 200);
      child.once('close', (code) => {
        clearInterval(probe);
        resolve(code ?? -1);
      });
      setTimeout(() => child.kill('SIGKILL'), 30_000);
    });
    expect(exitCode).not.toBe(0);
    expect(bound).toBe(false);
  }, 45_000);
});
