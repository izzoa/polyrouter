import { accounts, sessions, users, verifications } from '@polyrouter/shared/server';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { nativeImport } from '../util/native-import';

/** Opaque handle for the Better Auth drizzle adapter. Its concrete type lives
 * in an ESM-only package the CJS control plane cannot statically import; by
 * design it is passed straight into `betterAuth({ database })` and never
 * inspected, so an opaque brand is the honest boundary type. */
export type AuthAdapter = { readonly __authAdapter: unique symbol };

interface DrizzleAdapterModule {
  drizzleAdapter: (db: NodePgDatabase, options: unknown) => unknown;
}

/** Better Auth's drizzle adapter, constructed inside the database module over
 * its private handle. The explicit map ties Better Auth's singular model keys
 * to our plural table consts. Exported only as an opaque token, so the auth
 * plane never receives a raw handle it could use for arbitrary tenant SQL.
 *
 * Async because better-auth is ESM-only and the control plane compiles to CJS
 * — a dynamic import is the interop-safe path. */
export async function buildAuthAdapter(db: NodePgDatabase): Promise<AuthAdapter> {
  const { drizzleAdapter } = await nativeImport<DrizzleAdapterModule>(
    'better-auth/adapters/drizzle',
  );
  const adapter = drizzleAdapter(db, {
    provider: 'pg',
    // Real transactions (user-administration): the user insert and its
    // account/session inserts commit or roll back TOGETHER — a post-insert
    // failure can never leave a partial user. (The adapter default is false.)
    transaction: true,
    schema: {
      user: users,
      session: sessions,
      account: accounts,
      verification: verifications,
    },
  });
  return adapter as AuthAdapter;
}
