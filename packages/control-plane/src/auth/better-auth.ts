import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { Logger } from '@nestjs/common';
import type { IdentityPort } from '@polyrouter/shared/server';
import type { AuthAdapter } from '../database/auth-adapter';
import type { SystemMailer } from '../producers/system-mailer';
import { nativeImport } from '../util/native-import';
import type { AuthConfig } from './auth.config';
import { inviteBypassEmail } from './signup-gate';

interface BetterAuthModule {
  betterAuth: (options: unknown) => {
    api: unknown;
  };
}
interface BetterAuthApiModule {
  APIError: new (status: string, body?: { message?: string }) => Error;
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
  /** Invite-accept path: same signup flow, but returns the response headers so
   * the caller can forward Set-Cookie — the invitee lands signed in. */
  signUpEmailWithHeaders: (input: {
    name: string;
    email: string;
    password: string;
  }) => Promise<{ headers: Headers }>;
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
  const { APIError } = await nativeImport<BetterAuthApiModule>('better-auth/api');
  const { config, identity } = deps;

  /** Registration admission (user-administration), evaluated at USER CREATION —
   * the one seam that covers both email/password and OAuth new accounts. A
   * server-side claimed-invite bypass (ALS) wins; a zero-user instance admits
   * exactly ONE bootstrap winner via the atomic claim (losers refused); after
   * that the authoritative registration_mode decides. Never gates an existing
   * user's sign-in (this hook only runs on creation). */
  const admitNewAccount = async (email: string | undefined): Promise<void> => {
    const bypass = inviteBypassEmail();
    if (bypass !== null && email !== undefined && bypass === email.toLowerCase()) {
      return; // invite already atomically claimed by the accept endpoint
    }
    if (!(await identity.userAdmin.anyUserExists())) {
      if (await identity.userAdmin.claimBootstrap()) return; // THE first user
      throw new APIError('FORBIDDEN', {
        message: 'Instance setup is in progress — try again shortly.',
      });
    }
    const mode = await identity.userAdmin.getRegistrationMode();
    if (mode === 'open') return;
    throw new APIError('FORBIDDEN', { message: 'Registration is invite-only.' });
  };

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
          // The registration gate: throwing here aborts creation for BOTH the
          // email/password flow and OAuth new-account creation.
          before: async (user: { email?: string | null }) => {
            await admitNewAccount(user.email ?? undefined);
          },
          after: async (user: { id: string }) => {
            // With adapter transactions on, after-hooks still run when the
            // surrounding transaction failed (1.6.23) — tolerate a rolled-back
            // user instead of FK-throwing into a dead signup.
            const exists = await identity.getIdentity(user.id);
            if (!exists) return;
            await identity.ensureFirstAdmin();
            await identity.provisionDefaultTier(user.id);
          },
        },
      },
      session: {
        create: {
          // Better Auth intercepts /api/auth/* before the app guard, so a
          // disabled user must be refused HERE: no new session (sign-in) can
          // be minted while disabled — email and OAuth alike.
          before: async (session: { userId: string }) => {
            // Tri-state read: this hook runs INSIDE the signup transaction,
            // where the brand-new user row isn't committed yet — an invisible
            // row means "being created", never "disabled" (only explicit true
            // blocks; the deleted-user case has no credentials to sign in with).
            if ((await identity.disabledFlag(session.userId)) === true) {
              throw new APIError('UNAUTHORIZED', { message: 'This account is disabled.' });
            }
          },
        },
      },
    },
  });

  const api = auth.api as {
    getSession: (input: { headers: Headers }) => Promise<{ user: SessionUser } | null>;
    signUpEmail: ((input: {
      body: { name: string; email: string; password: string };
    }) => Promise<unknown>) &
      ((input: {
        body: { name: string; email: string; password: string };
        returnHeaders: true;
      }) => Promise<{ headers: Headers }>);
  };

  return {
    handler: toNodeHandler(auth),
    getSession: (headers) => api.getSession({ headers: fromNodeHeaders(headers) }),
    signUpEmail: (input) => api.signUpEmail({ body: input }),
    signUpEmailWithHeaders: (input) => api.signUpEmail({ body: input, returnHeaders: true }),
  } satisfies AuthInstance;
}
