import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { IdentityPort } from '@polyrouter/shared/server';
import type { AuthAdapter } from '../database/auth-adapter';
import { nativeImport } from '../util/native-import';
import type { AuthConfig } from './auth.config';

interface BetterAuthModule {
  betterAuth: (options: unknown) => {
    api: unknown;
  };
}
interface BetterAuthNodeModule {
  toNodeHandler: (auth: unknown) => (req: IncomingMessage, res: ServerResponse) => void;
  fromNodeHeaders: (headers: IncomingHttpHeaders) => Headers;
}

/** The slice of the Better Auth instance the app uses. Structural, because
 * better-auth is ESM-only and can't be statically imported into this CJS
 * package — the dynamic import result is adapted to this shape. */
export interface SessionUser {
  id: string;
  role: string | null;
}
export interface AuthInstance {
  /** Node handler for `/api/auth/*` (mounted in bootstrap before body parsing). */
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  /** Validate a request's cookies → session, or null (accepts node headers). */
  getSession: (headers: IncomingHttpHeaders) => Promise<{ user: SessionUser } | null>;
  /** Seed path: create a user through the normal signup flow (hooks run). */
  signUpEmail: (input: { name: string; email: string; password: string }) => Promise<unknown>;
}

interface CreateAuthDeps {
  adapter: AuthAdapter;
  identity: IdentityPort;
  betterAuthSecret: string;
  config: AuthConfig;
}

/** Builds the Better Auth instance. The `user.create.after` hook does the
 * common-path first-admin promotion + default-tier provisioning; the boot
 * reconciliation (elsewhere) heals crashes. sendResetPassword is a stub that
 * never logs the token — email delivery is deferred to #15. */
export async function createAuth(deps: CreateAuthDeps): Promise<AuthInstance> {
  const { betterAuth } = await nativeImport<BetterAuthModule>('better-auth');
  const { fromNodeHeaders, toNodeHandler } =
    await nativeImport<BetterAuthNodeModule>('better-auth/node');
  const { config, identity } = deps;

  const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {};
  if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) {
    socialProviders['google'] = {
      clientId: config.GOOGLE_CLIENT_ID,
      clientSecret: config.GOOGLE_CLIENT_SECRET,
    };
  }
  if (config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET) {
    socialProviders['github'] = {
      clientId: config.GITHUB_CLIENT_ID,
      clientSecret: config.GITHUB_CLIENT_SECRET,
    };
  }
  if (config.DISCORD_CLIENT_ID && config.DISCORD_CLIENT_SECRET) {
    socialProviders['discord'] = {
      clientId: config.DISCORD_CLIENT_ID,
      clientSecret: config.DISCORD_CLIENT_SECRET,
    };
  }

  const auth = betterAuth({
    // The adapter was built inside the database module (opaque handle).
    database: deps.adapter as never,
    secret: deps.betterAuthSecret,
    baseURL: config.BETTER_AUTH_URL,
    basePath: '/api/auth',
    trustedOrigins: [config.DASHBOARD_ORIGIN],
    emailAndPassword: {
      enabled: true,
      sendResetPassword: () => {
        // Token flow works now; delivery is deferred to #15. NEVER log the token.
        console.log('[auth] password reset requested (delivery pending — see change #15)');
        return Promise.resolve();
      },
    },
    socialProviders,
    user: {
      additionalFields: {
        // Server-owned: signup payloads cannot assign a role (no escalation).
        role: { type: 'string', required: false, input: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user: { id: string }) => {
            await identity.ensureFirstAdmin();
            await identity.provisionDefaultTier(user.id);
          },
        },
      },
    },
  });

  const api = auth.api as {
    getSession: (input: { headers: Headers }) => Promise<{ user: SessionUser } | null>;
    signUpEmail: (input: {
      body: { name: string; email: string; password: string };
    }) => Promise<unknown>;
  };

  return {
    handler: toNodeHandler(auth),
    getSession: (headers) => api.getSession({ headers: fromNodeHeaders(headers) }),
    signUpEmail: (input) => api.signUpEmail({ body: input }),
  } satisfies AuthInstance;
}
