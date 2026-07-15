import {
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { loadConfig } from '@polyrouter/shared';
import { PERSISTENCE_FACILITIES, PERSISTENCE_PORT } from '@polyrouter/shared/server';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import './database.config';
import { DRIZZLE, PG_POOL } from './database.internal';
import { runMigrations } from './migrations-runner';
import { buildPersistenceFacilities, buildPersistencePort } from './port';
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
    MigrationRunner,
    PoolLifecycle,
  ],
  exports: [PERSISTENCE_PORT, PERSISTENCE_FACILITIES],
})
export class DatabaseModule {}
