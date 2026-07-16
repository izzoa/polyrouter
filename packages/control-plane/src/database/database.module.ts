import {
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { loadConfig } from '@polyrouter/shared';
import {
  AUTH_ADAPTER_FACTORY,
  IDENTITY_PORT,
  PERSISTENCE_FACILITIES,
  PERSISTENCE_PORT,
} from '@polyrouter/shared/server';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import './database.config';
import { buildAuthAdapter } from './auth-adapter';
import { DRIZZLE, PG_POOL } from './database.internal';
import { runMigrations } from './migrations-runner';
import { buildPersistenceFacilities, buildPersistencePort } from './port';
import { buildIdentityPort } from './port-identity';
import { WEEKLY_SPEND_READER, buildWeeklySpendReader } from './weekly-spend.reader';
import { BUDGET_READER, buildBudgetReader } from './budget.reader';
import type { DatabaseConfig } from './database.config';

/** Applies migrations during app init — before `listen()` ever runs — so a
 * migration failure can never serve traffic (database-schema requirement). */
@Injectable()
class MigrationRunner implements OnModuleInit {
  constructor(@Inject(DRIZZLE) private readonly db: NodePgDatabase) {}
  async onModuleInit(): Promise<void> {
    await runMigrations(this.db);
  }
}

@Injectable()
class PoolLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

/** The persistence module. Raw Pool/drizzle providers are PRIVATE (module-
 * internal symbols, never exported) — the only exported surfaces are the
 * scoped PersistencePort and the privileged facilities, whose callbacks are
 * themselves scoped ports. Unscoped SQL is unwritable outside this module. */
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: () => {
        const config = loadConfig<DatabaseConfig>();
        return new Pool({ connectionString: config.DATABASE_URL });
      },
    },
    {
      provide: DRIZZLE,
      useFactory: (pool: Pool) => drizzle(pool),
      inject: [PG_POOL],
    },
    {
      provide: PERSISTENCE_PORT,
      useFactory: (db: NodePgDatabase) => buildPersistencePort(db),
      inject: [DRIZZLE],
    },
    {
      provide: PERSISTENCE_FACILITIES,
      useFactory: (db: NodePgDatabase) => buildPersistenceFacilities(db),
      inject: [DRIZZLE],
    },
    {
      provide: IDENTITY_PORT,
      useFactory: (db: NodePgDatabase) => buildIdentityPort(db),
      inject: [DRIZZLE],
    },
    {
      // Narrow, scheduler-only cross-owner reader (#15b weekly summary). Built on
      // the private handle; only this token is exported (never raw drizzle).
      provide: WEEKLY_SPEND_READER,
      useFactory: (db: NodePgDatabase) => buildWeeklySpendReader(db),
      inject: [DRIZZLE],
    },
    {
      // Narrow, scheduler-only cross-owner reconcile reader (#16 spend budgets).
      // Same discipline — private handle in, only the token out.
      provide: BUDGET_READER,
      useFactory: (db: NodePgDatabase) => buildBudgetReader(db),
      inject: [DRIZZLE],
    },
    {
      // LAZY factory: closes over the private handle so the auth plane needs
      // no raw handle of its own, but imports the ESM better-auth package only
      // when actually called — non-auth consumers of this module never do.
      provide: AUTH_ADAPTER_FACTORY,
      useFactory: (db: NodePgDatabase) => () => buildAuthAdapter(db),
      inject: [DRIZZLE],
    },
    MigrationRunner,
    PoolLifecycle,
  ],
  exports: [
    PERSISTENCE_PORT,
    PERSISTENCE_FACILITIES,
    IDENTITY_PORT,
    AUTH_ADAPTER_FACTORY,
    WEEKLY_SPEND_READER,
    BUDGET_READER,
  ],
})
export class DatabaseModule {}
