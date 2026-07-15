import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** Module-PRIVATE injection tokens (never exported from the module): the raw
 * pool and drizzle handle must not be injectable by feature modules —
 * everything outside goes through the scoped PersistencePort. */
export const PG_POOL = Symbol('polyrouter:internal:pg-pool');
export const DRIZZLE = Symbol('polyrouter:internal:drizzle');

/** The drizzle handle shape used internally (also matches a transaction). */
export type Db = Pick<
  NodePgDatabase,
  'select' | 'insert' | 'update' | 'delete' | 'transaction' | 'execute'
>;
