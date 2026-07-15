import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** Resolves the committed migrations folder for both runtimes: ts-jest/dev
 * (`src/database/migrations`, sibling of this file) and the production build
 * (`dist/database/migrations`, copied by the build step). */
export function resolveMigrationsFolder(): string {
  const sibling = join(__dirname, 'migrations');
  if (existsSync(sibling)) return sibling;
  const fromDist = join(__dirname, '..', '..', 'src', 'database', 'migrations');
  if (existsSync(fromDist)) return fromDist;
  throw new Error(`migrations folder not found near ${__dirname}`);
}

/** Applies all pending migrations. Runs during module init, BEFORE the HTTP
 * server binds — a migration failure is a boot failure (fail-fast). */
export async function runMigrations(db: NodePgDatabase): Promise<void> {
  await migrate(db, { migrationsFolder: resolveMigrationsFolder() });
}
