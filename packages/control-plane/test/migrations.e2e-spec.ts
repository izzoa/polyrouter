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

/** add-key-subscription-presets: the additive `provider.key_preset` column and its two
 * CHECKs. Runs the REAL migration chain against a scratch database in two steps —
 * everything BEFORE the key_preset migration, a seed of every provider shape, then the
 * rest — so "existing rows read NULL and nothing else moved" is proven against rows that
 * genuinely predate the column. */
describe('provider.key_preset migration (database-schema, add-key-subscription-presets)', () => {
  const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
  const dbName = `polyrouter_mig_kp_${Math.random().toString(36).slice(2, 8)}`;
  let admin: Pool;
  let pool: Pool;
  let partialDir: string;
  const OWNER = 'u-mig-kp';

  /** The migrations folder truncated just before the key_preset migration. */
  function partialFolder(): string {
    const full = resolveMigrationsFolder();
    const journal = JSON.parse(readFileSync(join(full, 'meta', '_journal.json'), 'utf8')) as {
      entries: { tag: string }[];
    };
    const at = journal.entries.findIndex((e) =>
      readFileSync(join(full, `${e.tag}.sql`), 'utf8').includes('ADD COLUMN "key_preset"'),
    );
    if (at < 0) throw new Error('key_preset migration not found in the journal');
    const dir = mkdtempSync(join(tmpdir(), 'polyrouter-mig-kp-'));
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

  const columnsOf = async (): Promise<string[]> =>
    (
      await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'provider' ORDER BY column_name`,
      )
    ).rows.map((r) => r.column_name);
  const providerRows = async (): Promise<Record<string, unknown>[]> =>
    (await pool.query(`SELECT * FROM provider ORDER BY id`)).rows;
  const appliedCount = async (): Promise<number> =>
    (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`))
      .rows[0]!.n;
  const insertProvider = (
    id: string,
    kind: string,
    protocol: string,
    oauthPreset: string | null,
    keyPreset?: string,
  ): Promise<unknown> =>
    keyPreset === undefined
      ? pool.query(
          `INSERT INTO provider (id, owner_user_id, name, kind, protocol, oauth_preset)
           VALUES ($1, $2, $1, $3, $4, $5)`,
          [id, OWNER, kind, protocol, oauthPreset],
        )
      : pool.query(
          `INSERT INTO provider (id, owner_user_id, name, kind, protocol, oauth_preset, key_preset)
           VALUES ($1, $2, $1, $3, $4, $5, $6)`,
          [id, OWNER, kind, protocol, oauthPreset, keyPreset],
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

  it('adds a nullable column and leaves every pre-existing row and column untouched', async () => {
    await migrate(drizzle(pool), { migrationsFolder: partialDir });
    expect(await columnsOf()).not.toContain('key_preset'); // the "before" world

    await pool.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1, 'mig', 'mig-kp@example.test')`,
      [OWNER],
    );
    // Every provider shape that exists before this change.
    await insertProvider('P-api', 'api_key', 'openai_compatible', null);
    await insertProvider('P-custom', 'custom', 'openai_compatible', null);
    await insertProvider('P-local', 'local', 'openai_compatible', null);
    await insertProvider('P-pasted', 'subscription', 'openai_compatible', null);
    await insertProvider('P-oauth', 'subscription', 'anthropic_compatible', 'claude');

    const colsBefore = await columnsOf();
    const rowsBefore = await providerRows();
    expect(rowsBefore).toHaveLength(5);

    await migrate(drizzle(pool), { migrationsFolder: resolveMigrationsFolder() });

    // The column: text, nullable, no default (so no row is rewritten).
    const col = await pool.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'provider' AND column_name = 'key_preset'`,
    );
    expect(col.rows).toEqual([{ data_type: 'text', is_nullable: 'YES', column_default: null }]);
    // Later migrations add their own provider columns (add-subscription-usage-history:
    // `check_plan_usage`; add-dismissible-terms-risk: `terms_risk_acknowledged_at`); they are not
    // this migration's to judge.
    const LATER = ['check_plan_usage', 'terms_risk_acknowledged_at'];
    expect((await columnsOf()).filter((c) => !LATER.includes(c))).toEqual(
      [...colsBefore, 'key_preset'].sort(),
    );

    // Every pre-existing row reads NULL and EVERY other value is untouched.
    const rowsAfter = await providerRows();
    expect(rowsAfter).toHaveLength(5);
    for (const r of rowsAfter) expect(r['key_preset']).toBeNull();
    expect(
      rowsAfter.map(
        ({
          key_preset: _keyPreset,
          check_plan_usage: _checkPlanUsage,
          terms_risk_acknowledged_at: _termsRisk,
          ...rest
        }) => rest,
      ),
    ).toEqual(rowsBefore);
    expect(rowsAfter.find((r) => r['id'] === 'P-oauth')).toMatchObject({ oauth_preset: 'claude' });
  }, 120_000);

  it('the database rejects both markers on one row, and a marker on a non-subscription row', async () => {
    const reject = (p: Promise<unknown>, constraint: string) =>
      expect(p).rejects.toMatchObject({ code: '23514', constraint });

    // Both markers on a subscription row: only the exclusivity CHECK is violated.
    await reject(
      insertProvider('R-both', 'subscription', 'openai_compatible', 'claude', 'kimi-code'),
      'provider_key_preset_exclusive',
    );
    // A key preset on any non-subscription kind: only the kind CHECK is violated.
    for (const kind of ['api_key', 'custom', 'local']) {
      await reject(
        insertProvider(`R-${kind}`, kind, 'openai_compatible', null, 'kimi-code'),
        'provider_key_preset_subscription',
      );
    }
    expect((await pool.query(`SELECT 1 FROM provider WHERE id LIKE 'R-%'`)).rowCount).toBe(0);

    // The coherent shapes land: a key-preset subscription row, and the existing
    // OAuth-only and unmarked shapes.
    await insertProvider('K-key', 'subscription', 'openai_compatible', null, 'kimi-code');
    await insertProvider('K-oauth', 'subscription', 'anthropic_compatible', 'claude');
    const landed = await pool.query<{ id: string; key_preset: string | null }>(
      `SELECT id, key_preset FROM provider WHERE id LIKE 'K-%' ORDER BY id`,
    );
    expect(landed.rows).toEqual([
      { id: 'K-key', key_preset: 'kimi-code' },
      { id: 'K-oauth', key_preset: null },
    ]);

    // An UPDATE cannot reach an incoherent state either.
    await reject(
      pool.query(`UPDATE provider SET oauth_preset = 'claude' WHERE id = 'K-key'`),
      'provider_key_preset_exclusive',
    );
    await reject(
      pool.query(`UPDATE provider SET kind = 'api_key' WHERE id = 'K-key'`),
      'provider_key_preset_subscription',
    );
    await reject(
      pool.query(`UPDATE provider SET key_preset = 'kimi-code' WHERE id = 'P-api'`),
      'provider_key_preset_subscription',
    );
  }, 60_000);

  it('a second boot-time migration run is a no-op: no error, nothing reapplied, schema unchanged', async () => {
    const applied = await appliedCount();
    const cols = await columnsOf();
    const rowsBefore = await providerRows();
    await runMigrations(drizzle(pool));
    await runMigrations(drizzle(pool));
    expect(await appliedCount()).toBe(applied);
    expect(await columnsOf()).toEqual(cols);
    expect(await providerRows()).toEqual(rowsBefore);
    const checks = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conname IN ('provider_key_preset_exclusive', 'provider_key_preset_subscription')
       ORDER BY conname`,
    );
    expect(checks.rows.map((r) => r.conname)).toEqual([
      'provider_key_preset_exclusive',
      'provider_key_preset_subscription',
    ]); // exactly one each, not re-added
  }, 60_000);
});

/** add-subscription-usage-history (migration 0046): the additive `plan_usage_sample` table and
 * the defaulted `provider.check_plan_usage` column. Same two-step shape as the key_preset suite:
 * everything BEFORE the migration, a seed of every provider shape, then the rest. */
describe('plan_usage_sample + provider.check_plan_usage migration (database-schema, add-subscription-usage-history)', () => {
  const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
  const dbName = `polyrouter_mig_pu_${Math.random().toString(36).slice(2, 8)}`;
  let admin: Pool;
  let pool: Pool;
  let partialDir: string;
  const OWNER = 'u-mig-pu';

  /** The migrations folder truncated just before the check_plan_usage migration. */
  function partialFolder(): string {
    const full = resolveMigrationsFolder();
    const journal = JSON.parse(readFileSync(join(full, 'meta', '_journal.json'), 'utf8')) as {
      entries: { tag: string }[];
    };
    const at = journal.entries.findIndex((e) =>
      readFileSync(join(full, `${e.tag}.sql`), 'utf8').includes('ADD COLUMN "check_plan_usage"'),
    );
    if (at < 0) throw new Error('check_plan_usage migration not found in the journal');
    const dir = mkdtempSync(join(tmpdir(), 'polyrouter-mig-pu-'));
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

  const providerColumns = async (): Promise<string[]> =>
    (
      await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'provider' ORDER BY column_name`,
      )
    ).rows.map((r) => r.column_name);
  const tableExists = async (name: string): Promise<boolean> =>
    (
      await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1`,
        [name],
      )
    ).rows[0]!.n === 1;
  const providerRows = async (): Promise<Record<string, unknown>[]> =>
    (await pool.query(`SELECT * FROM provider ORDER BY id`)).rows;
  const appliedCount = async (): Promise<number> =>
    (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`))
      .rows[0]!.n;
  const insertSample = (
    providerId: string,
    usedPercent: number | null,
    observedAt: string,
    windowKey = 'account:5h',
  ): Promise<unknown> =>
    pool.query(
      `INSERT INTO plan_usage_sample (id, provider_id, window_key, used_percent, reset_at, observed_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, NULL, $4)`,
      [providerId, windowKey, usedPercent, observedAt],
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

  it('creates an empty table and a defaulted column without touching a pre-existing row', async () => {
    await migrate(drizzle(pool), { migrationsFolder: partialDir });
    expect(await tableExists('plan_usage_sample')).toBe(false); // the "before" world
    expect(await providerColumns()).not.toContain('check_plan_usage');

    await pool.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1, 'mig', 'mig-pu@example.test')`,
      [OWNER],
    );
    // Every provider shape that exists before this change.
    const shapes: Array<[string, string, string, string | null, string | null]> = [
      ['P-api', 'api_key', 'openai_compatible', null, null],
      ['P-custom', 'custom', 'openai_compatible', null, null],
      ['P-local', 'local', 'openai_compatible', null, null],
      ['P-pasted', 'subscription', 'openai_compatible', null, null],
      ['P-claude', 'subscription', 'anthropic_compatible', 'claude', null],
      ['P-chatgpt', 'subscription', 'openai_responses', 'chatgpt', null],
      ['P-kimi', 'subscription', 'openai_compatible', null, 'kimi-code'],
    ];
    for (const [id, kind, protocol, oauthPreset, keyPreset] of shapes) {
      await pool.query(
        `INSERT INTO provider (id, owner_user_id, name, kind, protocol, oauth_preset, key_preset,
                               imitate_client_identity)
         VALUES ($1, $2, $1, $3, $4, $5, $6, $7)`,
        [id, OWNER, kind, protocol, oauthPreset, keyPreset, keyPreset !== null],
      );
    }
    const colsBefore = await providerColumns();
    const rowsBefore = await providerRows();
    expect(rowsBefore).toHaveLength(shapes.length);

    await migrate(drizzle(pool), { migrationsFolder: resolveMigrationsFolder() });

    // The column: boolean, NOT NULL, default true; every existing row reads true.
    const col = await pool.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'provider' AND column_name = 'check_plan_usage'`,
    );
    expect(col.rows).toEqual([{ data_type: 'boolean', is_nullable: 'NO', column_default: 'true' }]);
    // Later migrations add their own provider columns (add-dismissible-terms-risk:
    // `terms_risk_acknowledged_at`); they are not this migration's to judge.
    const LATER = ['terms_risk_acknowledged_at'];
    expect((await providerColumns()).filter((c) => !LATER.includes(c))).toEqual(
      [...colsBefore, 'check_plan_usage'].sort(),
    );
    const rowsAfter = await providerRows();
    expect(rowsAfter).toHaveLength(shapes.length);
    for (const r of rowsAfter) expect(r['check_plan_usage']).toBe(true);
    expect(
      rowsAfter.map(({ check_plan_usage: _c, terms_risk_acknowledged_at: _t, ...rest }) => rest),
    ).toEqual(rowsBefore);

    // The table exists, empty, with exactly the documented columns.
    expect(await tableExists('plan_usage_sample')).toBe(true);
    expect(
      (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM plan_usage_sample`)).rows[0]!
        .n,
    ).toBe(0);
    const sampleCols = await pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'plan_usage_sample' ORDER BY column_name`,
    );
    expect(sampleCols.rows).toEqual([
      { column_name: 'id', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'observed_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'provider_id', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'reset_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'used_percent', data_type: 'numeric', is_nullable: 'YES' },
      { column_name: 'window_key', data_type: 'text', is_nullable: 'NO' },
    ]);
  }, 120_000);

  it('the database refuses an out-of-range percent, skips a duplicate on conflict, and cascades a delete', async () => {
    const reject = (p: Promise<unknown>, code: string, constraint: string) =>
      expect(p).rejects.toMatchObject({ code, constraint });
    const at = '2026-11-09T10:05:00.000Z';

    await reject(
      insertSample('P-claude', 101, at),
      '23514',
      'plan_usage_sample_used_percent_range',
    );
    await reject(insertSample('P-claude', -1, at), '23514', 'plan_usage_sample_used_percent_range');
    await insertSample('P-claude', 0, at);
    await insertSample('P-claude', 100, '2026-11-09T10:20:00.000Z');
    await insertSample('P-claude', null, '2026-11-09T10:35:00.000Z'); // unknown stays null

    // The same (provider, window, observation) twice: a plain insert is a unique violation, and
    // the sampler's conflict clause skips it without error.
    await reject(insertSample('P-claude', 5, at), '23505', 'plan_usage_sample_observation_uniq');
    const skipped = await pool.query(
      `INSERT INTO plan_usage_sample (id, provider_id, window_key, used_percent, observed_at)
       VALUES (gen_random_uuid()::text, 'P-claude', 'account:5h', 5, $1)
       ON CONFLICT (provider_id, window_key, observed_at) DO NOTHING`,
      [at],
    );
    expect(skipped.rowCount).toBe(0);
    // Another window at the same instant is its own sample.
    await insertSample('P-claude', 7, at, 'account:weekly');
    const kept = await pool.query<{ window_key: string; used_percent: string | null }>(
      `SELECT window_key, used_percent FROM plan_usage_sample WHERE provider_id = 'P-claude'
       ORDER BY observed_at, window_key`,
    );
    expect(kept.rows).toEqual([
      { window_key: 'account:5h', used_percent: '0.00' },
      { window_key: 'account:weekly', used_percent: '7.00' },
      { window_key: 'account:5h', used_percent: '100.00' },
      { window_key: 'account:5h', used_percent: null },
    ]);

    // A sample of a provider that does not exist is refused by the foreign key.
    await reject(
      insertSample('P-missing', 5, at),
      '23503',
      'plan_usage_sample_provider_id_provider_id_fk',
    );

    // Deleting the provider deletes its samples in the same statement.
    await insertSample('P-kimi', 40, at);
    await pool.query(`DELETE FROM provider WHERE id = 'P-claude'`);
    const left = await pool.query<{ provider_id: string }>(
      `SELECT provider_id FROM plan_usage_sample ORDER BY provider_id`,
    );
    expect(left.rows).toEqual([{ provider_id: 'P-kimi' }]);
  }, 60_000);

  it('a second boot-time migration run is a no-op: no error, nothing reapplied, schema unchanged', async () => {
    const applied = await appliedCount();
    const cols = await providerColumns();
    const rowsBefore = await providerRows();
    await runMigrations(drizzle(pool));
    await runMigrations(drizzle(pool));
    expect(await appliedCount()).toBe(applied);
    expect(await providerColumns()).toEqual(cols);
    expect(await providerRows()).toEqual(rowsBefore);
    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'plan_usage_sample' ORDER BY indexname`,
    );
    expect(indexes.rows.map((r) => r.indexname)).toEqual([
      'plan_usage_sample_observation_uniq',
      'plan_usage_sample_observed_idx',
      'plan_usage_sample_pkey',
      'plan_usage_sample_provider_observed_idx',
    ]);
  }, 60_000);
});

/** add-dismissible-terms-risk (migration 0047): the nullable `provider.terms_risk_acknowledged_at`
 * column (database-schema "The terms-risk acknowledgment is an additive, nullable provider
 * column"). Same two-step shape: everything BEFORE the migration, a seed of every provider shape,
 * then the rest. */
describe('provider.terms_risk_acknowledged_at migration (database-schema, add-dismissible-terms-risk)', () => {
  const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
  const dbName = `polyrouter_mig_tr_${Math.random().toString(36).slice(2, 8)}`;
  let admin: Pool;
  let pool: Pool;
  let partialDir: string;
  const OWNER = 'u-mig-tr';
  const COLUMN = 'terms_risk_acknowledged_at';

  /** The migrations folder truncated just before the terms_risk_acknowledged_at migration. */
  function partialFolder(): string {
    const full = resolveMigrationsFolder();
    const journal = JSON.parse(readFileSync(join(full, 'meta', '_journal.json'), 'utf8')) as {
      entries: { tag: string }[];
    };
    const at = journal.entries.findIndex((e) =>
      readFileSync(join(full, `${e.tag}.sql`), 'utf8').includes(`ADD COLUMN "${COLUMN}"`),
    );
    if (at < 0) throw new Error(`${COLUMN} migration not found in the journal`);
    const dir = mkdtempSync(join(tmpdir(), 'polyrouter-mig-tr-'));
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

  const providerColumns = async (): Promise<string[]> =>
    (
      await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'provider' ORDER BY column_name`,
      )
    ).rows.map((r) => r.column_name);
  const providerRows = async (): Promise<Record<string, unknown>[]> =>
    (await pool.query(`SELECT * FROM provider ORDER BY id`)).rows;
  const appliedCount = async (): Promise<number> =>
    (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`))
      .rows[0]!.n;

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

  it('existing providers start unacknowledged: a nullable column, no row or other value touched', async () => {
    await migrate(drizzle(pool), { migrationsFolder: partialDir });
    expect(await providerColumns()).not.toContain(COLUMN); // the "before" world

    await pool.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1, 'mig', 'mig-tr@example.test')`,
      [OWNER],
    );
    // Every provider shape that exists before this change.
    const shapes: Array<[string, string, string, string | null, string | null]> = [
      ['P-api', 'api_key', 'openai_compatible', null, null],
      ['P-custom', 'custom', 'openai_compatible', null, null],
      ['P-local', 'local', 'openai_compatible', null, null],
      ['P-pasted', 'subscription', 'openai_compatible', null, null],
      ['P-claude', 'subscription', 'anthropic_compatible', 'claude', null],
      ['P-chatgpt', 'subscription', 'openai_responses', 'chatgpt', null],
      ['P-zai', 'subscription', 'openai_compatible', null, 'zai-coding'],
    ];
    for (const [id, kind, protocol, oauthPreset, keyPreset] of shapes) {
      await pool.query(
        `INSERT INTO provider (id, owner_user_id, name, kind, protocol, oauth_preset, key_preset,
                               check_plan_usage)
         VALUES ($1, $2, $1, $3, $4, $5, $6, $7)`,
        [id, OWNER, kind, protocol, oauthPreset, keyPreset, id !== 'P-claude'],
      );
    }
    const colsBefore = await providerColumns();
    const rowsBefore = await providerRows();
    expect(rowsBefore).toHaveLength(shapes.length);

    await migrate(drizzle(pool), { migrationsFolder: resolveMigrationsFolder() });

    // The column: timestamptz, nullable, no default (so no row is rewritten).
    const col = await pool.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'provider' AND column_name = $1`,
      [COLUMN],
    );
    expect(col.rows).toEqual([
      { data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
    ]);
    expect(await providerColumns()).toEqual([...colsBefore, COLUMN].sort());
    const rowsAfter = await providerRows();
    expect(rowsAfter).toHaveLength(shapes.length);
    for (const r of rowsAfter) expect(r[COLUMN]).toBeNull();
    expect(rowsAfter.map(({ [COLUMN]: _t, ...rest }) => rest)).toEqual(rowsBefore);
  }, 120_000);

  it('deleting a provider deletes its acknowledgment; a later provider starts at NULL', async () => {
    await pool.query(`UPDATE provider SET ${COLUMN} = now() WHERE id = 'P-zai'`);
    await pool.query(`DELETE FROM provider WHERE id = 'P-zai'`);
    await pool.query(
      `INSERT INTO provider (id, owner_user_id, name, kind, protocol, key_preset)
       VALUES ('P-zai-2', $1, 'P-zai-2', 'subscription', 'openai_compatible', 'zai-coding')`,
      [OWNER],
    );
    const rows = await pool.query<{ id: string; at: Date | null }>(
      `SELECT id, ${COLUMN} AS at FROM provider WHERE id LIKE 'P-zai%' ORDER BY id`,
    );
    expect(rows.rows).toEqual([{ id: 'P-zai-2', at: null }]);
  }, 60_000);

  it('a second boot-time migration run is a no-op: no error, nothing reapplied, schema unchanged', async () => {
    const applied = await appliedCount();
    const cols = await providerColumns();
    const rowsBefore = await providerRows();
    await runMigrations(drizzle(pool));
    await runMigrations(drizzle(pool));
    expect(await appliedCount()).toBe(applied);
    expect(await providerColumns()).toEqual(cols);
    expect(await providerRows()).toEqual(rowsBefore);
  }, 60_000);
});
