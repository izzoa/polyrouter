import { randomUUID } from 'node:crypto';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { loadConfig } from '@polyrouter/shared';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { AgentsController } from '../../src/agents/agents.controller';
import { configureApp } from '../../src/app.setup';
import { AuthModule } from '../../src/auth/auth.module';
import { mountAuth } from '../../src/auth/mount';
import { SessionGuard } from '../../src/auth/session.guard';
import { DatabaseModule } from '../../src/database/database.module';
import { HealthController } from '../../src/health/health.controller';
import { RedisModule } from '../../src/redis/redis.module';
import { COMPOSE_HINT } from '../tenancy/harness';
import { ProbeController } from './probe.controller';
import '../../src/database/database.config';
import '../../src/auth/auth.config';

export interface AuthEnv {
  MODE: 'selfhosted' | 'cloud';
  BIND_ADDRESS?: string;
  SEED_DATA?: boolean;
  realSecrets?: boolean;
}

/** Sets the process env a given app build needs. Config is read fresh at each
 * app construction, so one test file can build apps with differing MODE. */
export function applyAuthEnv(env: AuthEnv): void {
  process.env['NODE_ENV'] = 'test';
  process.env['MODE'] = env.MODE;
  process.env['BIND_ADDRESS'] = env.BIND_ADDRESS ?? '127.0.0.1';
  if (env.SEED_DATA) process.env['SEED_DATA'] = 'true';
  else delete process.env['SEED_DATA'];
  if (env.realSecrets) {
    process.env['BETTER_AUTH_SECRET'] = 'a'.repeat(64);
    process.env['API_KEY_HMAC_SECRET'] = 'b'.repeat(64);
  } else {
    delete process.env['BETTER_AUTH_SECRET'];
    delete process.env['API_KEY_HMAC_SECRET'];
  }
}

/** Boots the real auth stack against the dev database/redis (Better Auth
 * mounted exactly as production does it). Call applyAuthEnv first.
 * `extraModules` lets a spec mount additional real modules (e.g. the
 * user-administration AdminModule) on the same guarded app. */
export async function createAuthApp(extraModules: unknown[] = []): Promise<NestExpressApplication> {
  const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
  const probe = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await probe.query('SELECT 1');
  } catch (error) {
    throw new Error(`${COMPOSE_HINT}\n(${(error as Error).message})`);
  } finally {
    await probe.end();
  }

  const moduleRef = await Test.createTestingModule({
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Nest module refs are class values
    imports: [DatabaseModule, RedisModule, AuthModule, ...(extraModules as never[])],
    controllers: [HealthController, AgentsController, ProbeController],
    providers: [{ provide: APP_GUARD, useClass: SessionGuard }],
  }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  app.enableShutdownHooks();
  configureApp(app, { NODE_ENV: 'test' }, 'http://localhost:3000');
  mountAuth(app);
  await app.init();
  return app;
}

/** A pristine identity/tenant state for order-independent auth tests. */
export async function resetAuthState(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    // agents/tiers/sessions/accounts cascade from user; truncate the roots.
    await pool.query('TRUNCATE "user", verification RESTART IDENTITY CASCADE');
    // user-administration state: multi-user tests need the gate OPEN (specs
    // that test invite_only set it explicitly), and the bootstrap claim must
    // be cleared so each test's first signup can win it fresh.
    await pool.query(`
      INSERT INTO instance_settings (id, registration_mode, bootstrap_claimed_at)
      VALUES ('singleton', 'open', NULL)
      ON CONFLICT (id) DO UPDATE
        SET registration_mode = 'open', bootstrap_claimed_at = NULL
    `);
  } finally {
    await pool.end();
  }
}

/** Set the registration mode directly (for gate-specific specs). */
export async function setRegistrationMode(
  databaseUrl: string,
  mode: 'open' | 'invite_only',
): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await pool.query(`UPDATE instance_settings SET registration_mode = $1 WHERE id = 'singleton'`, [
      mode,
    ]);
  } finally {
    await pool.end();
  }
}

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID()}@auth.test`;
}

/** Clear the auth rate-limit counters so per-test signups don't exhaust the
 * shared loopback-IP window. */
export async function clearRateLimits(): Promise<void> {
  const url = loadConfig<{ REDIS_URL: string }>().REDIS_URL;
  const redis = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await redis.connect();
    const keys = await redis.keys('rl:auth:*');
    if (keys.length > 0) await redis.del(...keys);
  } finally {
    redis.disconnect();
  }
}
