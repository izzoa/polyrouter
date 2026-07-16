import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { Logger } from '@nestjs/common';
import type { IdentityPort } from '@polyrouter/shared/server';
import type { AuthAdapter } from '../database/auth-adapter';
import type { SystemMailer } from '../producers/system-mailer';
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
  /** Server-wide system mailer (#15b) for the password-reset email; when absent
   * or unconfigured, reset falls back to a warn + skip (the token flow works). */
  mailer?: SystemMailer;
}

/** The `sendResetPassword` hook (#15b), extracted for unit testing. **Detached**:
 * Better Auth awaits this hook, so the reset request must not wait on SMTP — it
 * returns synchronously and the send runs in the background. The token/url is
 * NEVER logged (only fixed config-state strings). */
export function buildResetPasswordSender(
  mailer: SystemMailer | undefined,
  logger: Pick<Logger, 'warn'>,
): (data: { user: { email: string }; url: string }) => void {
  return (data) => {
    if (!mailer?.configured) {
      logger.warn('password-reset email skipped: SMTP not configured');
      return;
    }
    void mailer
      .send(data.user.email, 'Reset your polyrouter password', `Reset your password: ${data.url}`)
      .catch(() => logger.warn('password-reset email failed to send'));
  };
}

/** Builds the Better Auth instance. The `user.create.after` hook does the
 * common-path first-admin promotion + default-tier provisioning; the boot
 * reconciliation (elsewhere) heals crashes. sendResetPassword mails the reset
 * link via the system mailer, **detached** so the request never waits on SMTP,
 * and never logs the token/url. */
export async function createAuth(deps: CreateAuthDeps): Promise<AuthInstance> {
  const logger = new Logger('auth');
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
      sendResetPassword: buildResetPasswordSender(deps.mailer, logger),
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
