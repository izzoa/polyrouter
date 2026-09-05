import { Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PERSISTENCE_MAINTENANCE, PERSISTENCE_PORT } from '@polyrouter/shared/server';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DatabaseModule } from './database.module';
import { DRIZZLE } from './database.internal';
import { buildPersistenceMaintenance } from './maintenance';

/**
 * The persistence module's SECOND half (add-batch-inference D19, tenant-isolation):
 * the instance-level maintenance accessors — B-1's classification pass, the batch
 * poller's sweep, the reconciler's pending read — under their own token.
 *
 * Why a separate module: `DatabaseModule` is what every request-handling module
 * imports, and a Nest export is resolvable by every importer. Providing the
 * maintenance token HERE instead means a module that imports only
 * `DatabaseModule` cannot resolve `PERSISTENCE_MAINTENANCE` at all — Nest refuses
 * the injection at compile time, which is the negative DI test the contract asks
 * for, rather than a convention. Scheduler and bootstrap modules import this
 * module; controller-bearing modules never do (an architecture test walks the
 * application graph to pin that).
 *
 * The accessors are built over the same private drizzle handle: `ModuleRef.get`
 * with `strict: false` reaches `DatabaseModule`'s un-exported `DRIZZLE` provider
 * from inside the persistence folder — the raw handle still never crosses a
 * module boundary as an export, and only this file (next to `database.module.ts`)
 * knows the private symbol.
 */
@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: PERSISTENCE_MAINTENANCE,
      // `PERSISTENCE_PORT` is injected ONLY as an ordering dependency: Nest builds a
      // factory's declared dependencies first, and the port depends on `DRIZZLE`, so
      // by the time this runs the private handle exists for the global lookup
      // (an undeclared dependency is not ordered and reads back null).
      useFactory: (moduleRef: ModuleRef, _port: unknown) => {
        const db = moduleRef.get<NodePgDatabase | null>(DRIZZLE, { strict: false });
        if (db === null || db === undefined) {
          throw new Error('DatabaseMaintenanceModule: the persistence handle is not initialized');
        }
        return buildPersistenceMaintenance(db);
      },
      inject: [ModuleRef, PERSISTENCE_PORT],
    },
  ],
  exports: [PERSISTENCE_MAINTENANCE],
})
export class DatabaseMaintenanceModule {}
