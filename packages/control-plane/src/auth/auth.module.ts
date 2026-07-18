import { Module } from '@nestjs/common';
import {
  AUTH_ADAPTER_FACTORY,
  IDENTITY_PORT,
  type AuthAdapterFactory,
  type IdentityPort,
} from '@polyrouter/shared/server';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { MailerModule } from '../producers/mailer.module';
import { SystemMailer } from '../producers/system-mailer';
import type { AuthAdapter } from '../database/auth-adapter';
import './auth.config';
import { AgentApiKeyGuard } from './agent-key.guard';
import { AuthBootstrap } from './auth.bootstrap';
import { loadAuthConfig, resolveAuthSecrets } from './auth.config';
import { AUTH_INSTANCE } from './auth.tokens';
import { createAuth, type AuthInstance } from './better-auth';
import { InvitesController } from './invites.controller';
import { InvitesService } from './invites.service';
import { AuthRateLimitMiddleware } from './rate-limit.middleware';
import { SessionGuard } from './session.guard';

/** The auth plane. Builds the Better Auth instance (async — ESM) over the
 * database module's opaque adapter, exposes both guards, seeds/reconciles at
 * bootstrap, and throttles the auth routes. The SessionGuard is bound to
 * `/api/**` by the app module, not globally (the `/v1` plane uses agent keys). */
@Module({
  imports: [DatabaseModule, RedisModule, MailerModule],
  controllers: [InvitesController],
  providers: [
    {
      provide: AUTH_INSTANCE,
      useFactory: async (
        adapterFactory: AuthAdapterFactory,
        identity: IdentityPort,
        mailer: SystemMailer,
      ): Promise<AuthInstance> => {
        const { auth, base } = loadAuthConfig();
        const { betterAuthSecret, usedDevFallback } = resolveAuthSecrets(auth, base);
        if (usedDevFallback) {
          console.warn(
            '[auth] using DEV fallback secrets — set BETTER_AUTH_SECRET and API_KEY_HMAC_SECRET for anything beyond local development',
          );
        }
        const adapter = (await adapterFactory()) as AuthAdapter;
        return createAuth({ adapter, identity, betterAuthSecret, config: auth, mailer });
      },
      inject: [AUTH_ADAPTER_FACTORY, IDENTITY_PORT, SystemMailer],
    },
    SessionGuard,
    AgentApiKeyGuard,
    AuthBootstrap,
    InvitesService,
    // Provided (not registered as Nest middleware): mounted as raw Express
    // middleware in bootstrap so it runs BEFORE the Better Auth handler.
    AuthRateLimitMiddleware,
  ],
  exports: [AUTH_INSTANCE, SessionGuard, AgentApiKeyGuard, AuthRateLimitMiddleware, InvitesService],
})
export class AuthModule {}
