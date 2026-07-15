import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadConfig } from '@polyrouter/shared';
import {
  PERSISTENCE_FACILITIES,
  PERSISTENCE_PORT,
  userPrincipal,
  type PersistenceFacilities,
  type PersistencePort,
  type Principal,
} from '@polyrouter/shared/server';
import { Pool } from 'pg';
import { DatabaseModule } from '../../src/database/database.module';
import '../../src/database/database.config';

export const COMPOSE_HINT =
  'Dev database unreachable — start it with: docker compose -f docker-compose.dev.yml up -d';

export interface TestPrincipal {
  principal: Principal;
  userId: string;
}

/** Boots the persistence layer against the real dev database (migrations
 * included) and fabricates principals directly — no auth plane exists yet.
 * The reusable pattern every later CRUD change's isolation tests extend. */
export class TenancyHarness {
  private constructor(
    public readonly app: INestApplication,
    public readonly port: PersistencePort,
    public readonly facilities: PersistenceFacilities,
    public readonly pool: Pool,
    private readonly userIds: string[] = [],
  ) {}

  static async create(): Promise<TenancyHarness> {
    const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      await pool.end();
      // Fail LOUDLY, never skip — a silently-skipped isolation suite would
      // fake the tenant-isolation DoD.
      throw new Error(`${COMPOSE_HINT}\n(${(error as Error).message})`);
    }
    const moduleRef = await Test.createTestingModule({ imports: [DatabaseModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init(); // runs migrations before anything else
    return new TenancyHarness(
      app,
      app.get<PersistencePort>(PERSISTENCE_PORT),
      app.get<PersistenceFacilities>(PERSISTENCE_FACILITIES),
      pool,
    );
  }

  /** Inserts a user row directly (identity plane; not tenant data). */
  async createTestPrincipal(label: string): Promise<TestPrincipal> {
    const userId = randomUUID();
    await this.pool.query(
      'INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $3, false)',
      [userId, label, `${label}-${userId}@tenancy.test`],
    );
    this.userIds.push(userId);
    return { principal: userPrincipal(userId), userId };
  }

  /** Owner FKs cascade, so deleting the fabricated users wipes all owned rows. */
  async cleanup(): Promise<void> {
    if (this.userIds.length > 0) {
      await this.pool.query('DELETE FROM "user" WHERE id = ANY($1)', [this.userIds]);
    }
    await this.pool.end();
    await this.app.close();
  }
}
