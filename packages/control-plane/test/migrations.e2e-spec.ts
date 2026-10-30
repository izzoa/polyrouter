import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { loadConfig } from '@polyrouter/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { DatabaseModule } from '../src/database/database.module';
import '../src/database/database.config';
import { resolveMigrationsFolder, runMigrations } from '../src/database/migrations-runner';
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
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: freshUrl,
      PORT: String(port),
      NODE_ENV: 'production',
      BETTER_AUTH_SECRET: 'a'.repeat(64),
      API_KEY_HMAC_SECRET: 'b'.repeat(64),
      PROVIDER_CREDENTIAL_KEY: 'c'.repeat(64),
      NOTIFY_CREDENTIALS_SECRET: 'd'.repeat(64),
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
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: 'postgresql://polyrouter:polyrouter@127.0.0.1:59999/polyrouter',
      PORT: String(port),
      NODE_ENV: 'production',
      BETTER_AUTH_SECRET: 'a'.repeat(64),
      API_KEY_HMAC_SECRET: 'b'.repeat(64),
      PROVIDER_CREDENTIAL_KEY: 'c'.repeat(64),
      NOTIFY_CREDENTIALS_SECRET: 'd'.repeat(64),
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

/** zero-cost-unbilled-errors: the additive `request_log.billed` column. Runs the
 * REAL migration chain against a scratch database in two steps — everything BEFORE
 * the billed migration, a seed of legacy rows, then the rest — so "existing rows are
 * untouched" is proven against rows that genuinely predate the column, not asserted
 * on a fresh table. */
describe('request_log.billed migration (database-schema, zero-cost-unbilled-errors)', () => {
  const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
  const dbName = `polyrouter_mig_billed_${Math.random().toString(36).slice(2, 8)}`;
  let admin: Pool;
  let pool: Pool;
  let partialDir: string;
  const OWNER = 'u-mig-billed';

  /** The migrations folder truncated just before the billed migration (journal +
   * SQL files only — the migrator reads nothing else). */
  function partialFolder(): string {
    const full = resolveMigrationsFolder();
    const journal = JSON.parse(readFileSync(join(full, 'meta', '_journal.json'), 'utf8')) as {
      entries: { tag: string }[];
    };
    const at = journal.entries.findIndex((e) =>
      readFileSync(join(full, `${e.tag}.sql`), 'utf8').includes('ADD COLUMN "billed"'),
    );
    if (at < 0) throw new Error('billed migration not found in the journal');
    const dir = mkdtempSync(join(tmpdir(), 'polyrouter-mig-'));
    mkdirSync(join(dir, 'meta'));
    writeFileSync(
      join(dir, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, at) }),
    );
    for (const e of journal.entries.slice(0, at)) {
      writeFileSync(join(dir, `${e.tag}.sql`), readFileSync(join(full, `${e.tag}.sql`)));
    }
    return dir;
  }

  const columnsOf = async (table: string): Promise<string[]> =>
    (
      await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name`,
        [table],
      )
    ).rows.map((r) => r.column_name);
  const rowsOf = async (table: string): Promise<Record<string, unknown>[]> =>
    (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
  const appliedCount = async (): Promise<number> =>
    (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`))
      .rows[0]!.n;

  /** A row written by this version: every column the CHECK reads is explicit. */
  const insertLog = (
    id: string,
    cost: number | null,
    billed: boolean | null,
    status: string,
  ): Promise<unknown> =>
    pool.query(
      `INSERT INTO request_log
         (id, owner_user_id, decision_layer, routing_reason, input_tokens, output_tokens,
          usage_estimated, cost, billed, duration_ms, status)
       VALUES ($1, $2, 'default', 'default tier', 100, 0, true, $3, $4, 5, $5)`,
      [id, OWNER, cost, billed, status],
    );

  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl(databaseUrl), max: 1 });
    try {
      await admin.query(`CREATE DATABASE ${dbName}`);
    } catch (error) {
      throw new Error(`${COMPOSE_HINT}\n(${(error as Error).message})`);
    }
    pool = new Pool({ connectionString: adminUrl(databaseUrl, dbName), max: 2 });
    partialDir = partialFolder();
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
    if (partialDir !== undefined) rmSync(partialDir, { recursive: true, force: true });
  });

  it('adds a nullable column without touching a single pre-existing row or column', async () => {
    await migrate(drizzle(pool), { migrationsFolder: partialDir });
    expect(await columnsOf('request_log')).not.toContain('billed'); // the "before" world

    await pool.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1, 'mig', 'mig-billed@example.test')`,
      [OWNER],
    );
    // Legacy rows, INCLUDING the field-report shape: an error row that recorded an
    // estimated cost (open circuits, 54,040 estimated input tokens at $2/1M).
    const legacy = (
      id: string,
      status: string,
      cost: number | null,
      estimated: boolean,
      source: string | null,
    ): Promise<unknown> =>
      pool.query(
        `INSERT INTO request_log
           (id, owner_user_id, decision_layer, routing_reason, input_tokens, output_tokens,
            input_price_snapshot, output_price_snapshot, price_version_id, price_source,
            usage_estimated, cost, duration_ms, status)
         VALUES ($1, $2, 'auto', 'workload:research', 54040, 0, 2, 8, 'v-legacy', $3, $4, $5, 5, $6)`,
        [id, OWNER, source, estimated, cost, status],
      );
    await legacy('L-err-est', 'error', 0.10808, true, 'native_family');
    await legacy('L-ok', 'success', 0.0004, false, 'bundled');
    await legacy('L-err-unpriced', 'error', null, true, null);
    await legacy('L-free', 'success', 0, false, 'model');
    await pool.query(
      `INSERT INTO request_attempt
         (id, request_log_id, owner_user_id, attempt_index, input_tokens, output_tokens,
          cost, status, usage_estimated)
       VALUES ('A-1', 'L-ok', $1, 0, 10, 4, 0.0003, 'fallback', false)`,
      [OWNER],
    );

    const logColsBefore = await columnsOf('request_log');
    const attemptColsBefore = await columnsOf('request_attempt');
    const logBefore = await rowsOf('request_log');
    const attemptBefore = await rowsOf('request_attempt');
    expect(logBefore).toHaveLength(4);

    await migrate(drizzle(pool), { migrationsFolder: resolveMigrationsFolder() });

    // The column: boolean, nullable, no default (so no row is rewritten and an older
    // writer that never names it stores NULL).
    const col = await pool.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'request_log' AND column_name = 'billed'`,
    );
    expect(col.rows).toEqual([{ data_type: 'boolean', is_nullable: 'YES', column_default: null }]);
    expect(await columnsOf('request_log')).toEqual([...logColsBefore, 'billed'].sort());

    // Every legacy row reads NULL and EVERY other value is untouched — cost, the
    // price snapshots and price_source above all.
    const logAfter = await rowsOf('request_log');
    expect(logAfter).toHaveLength(4);
    for (const r of logAfter) expect(r['billed']).toBeNull();
    expect(logAfter.map(({ billed: _billed, ...rest }) => rest)).toEqual(logBefore);
    const phantom = logAfter.find((r) => r['id'] === 'L-err-est')!;
    expect(phantom).toMatchObject({
      cost: 0.10808,
      price_source: 'native_family',
      input_price_snapshot: 2,
      usage_estimated: true,
    });

    // request_attempt is unchanged: same columns, same row — it holds only calls
    // that ran, which are always billed, so it never carries the marker.
    expect(await columnsOf('request_attempt')).toEqual(attemptColsBefore);
    expect(attemptColsBefore).not.toContain('billed');
    expect(await rowsOf('request_attempt')).toEqual(attemptBefore);
  }, 120_000);

  it('the database rejects an inconsistent not-billed row and accepts every consistent one', async () => {
    const reject = (p: Promise<unknown>) =>
      expect(p).rejects.toMatchObject({
        code: '23514',
        constraint: 'request_log_not_billed_consistent',
      });
    await reject(insertLog('R-cost', 0.5, false, 'error')); // non-zero cost
    await reject(insertLog('R-null', null, false, 'error')); // NULL cost: unknown, not a known $0
    await reject(insertLog('R-succ', 0, false, 'success'));
    await reject(insertLog('R-fb', 0, false, 'fallback'));
    await reject(insertLog('R-canc-cost', 0.01, false, 'cancelled'));

    // The consistent shapes land: a not-billed error / cancel, a billed row of any
    // status and cost (including an estimated error), and a NULL marker (an older
    // app version writing after a rollback, or a legacy row).
    await insertLog('K-err', 0, false, 'error');
    await insertLog('K-canc', 0, false, 'cancelled');
    await insertLog('K-billed-err', 0.1081, true, 'error');
    await insertLog('K-billed-ok', 0.002, true, 'success');
    await insertLog('K-null-ok', 0.002, null, 'success');
    // An older writer's INSERT never names the column at all.
    await pool.query(
      `INSERT INTO request_log (id, owner_user_id, decision_layer, routing_reason, input_tokens,
         output_tokens, duration_ms, status, cost)
       VALUES ('K-old-writer', $1, 'default', 'default tier', 1, 1, 5, 'error', 0.5)`,
      [OWNER],
    );
    const landed = await pool.query<{ id: string; billed: boolean | null }>(
      `SELECT id, billed FROM request_log WHERE id LIKE 'K-%' ORDER BY id`,
    );
    expect(landed.rows).toEqual([
      { id: 'K-billed-err', billed: true },
      { id: 'K-billed-ok', billed: true },
      { id: 'K-canc', billed: false },
      { id: 'K-err', billed: false },
      { id: 'K-null-ok', billed: null },
      { id: 'K-old-writer', billed: null },
    ]);
    const rejected = await pool.query(`SELECT 1 FROM request_log WHERE id LIKE 'R-%'`);
    expect(rejected.rowCount).toBe(0);

    // An UPDATE cannot sneak a not-billed marker onto an inconsistent row either.
    await expect(
      pool.query(`UPDATE request_log SET billed = false WHERE id = 'K-billed-ok'`),
    ).rejects.toMatchObject({ code: '23514' });
  }, 60_000);

  it('a second boot-time migration run is a no-op: no error, nothing reapplied, schema unchanged', async () => {
    const applied = await appliedCount();
    const logCols = await columnsOf('request_log');
    const rowsBefore = await rowsOf('request_log');
    await runMigrations(drizzle(pool));
    await runMigrations(drizzle(pool));
    expect(await appliedCount()).toBe(applied);
    expect(await columnsOf('request_log')).toEqual(logCols);
    expect(await rowsOf('request_log')).toEqual(rowsBefore);
    const checks = await pool.query(
      `SELECT conname FROM pg_constraint WHERE conname = 'request_log_not_billed_consistent'`,
    );
    expect(checks.rowCount).toBe(1); // exactly one, not re-added
  }, 60_000);
});
