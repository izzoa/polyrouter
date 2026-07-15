import { Module } from '@nestjs/common';
import {
  AUTH_ADAPTER_FACTORY,
  IDENTITY_PORT,
  type AuthAdapterFactory,
  type IdentityPort,
} from '@polyrouter/shared/server';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import type { AuthAdapter } from '../database/auth-adapter';
import './auth.config';
import { AgentApiKeyGuard } from './agent-key.guard';
import { AuthBootstrap } from './auth.bootstrap';
import { loadAuthConfig, resolveAuthSecrets } from './auth.config';
import { AUTH_INSTANCE } from './auth.tokens';
import { createAuth, type AuthInstance } from './better-auth';
import { AuthRateLimitMiddleware } from './rate-limit.middleware';
import { SessionGuard } from './session.guard';

/** The auth plane. Builds the Better Auth instance (async — ESM) over the
 * database module's opaque adapter, exposes both guards, seeds/reconciles at
 * bootstrap, and throttles the auth routes. The SessionGuard is bound to
 * `/api/**` by the app module, not globally (the `/v1` plane uses agent keys). */
@Module({
  imports: [DatabaseModule, RedisModule],
  providers: [
    {
      provide: AUTH_INSTANCE,
      useFactory: async (
        adapterFactory: AuthAdapterFactory,
        identity: IdentityPort,
      ): Promise<AuthInstance> => {
        const { auth, base } = loadAuthConfig();
        const { betterAuthSecret, usedDevFallback } = resolveAuthSecrets(auth, base);
        if (usedDevFallback) {
          console.warn(
            '[auth] using DEV fallback secrets — set BETTER_AUTH_SECRET and API_KEY_HMAC_SECRET for anything beyond local development',
          );
        }
        const adapter = (await adapterFactory()) as AuthAdapter;
        return createAuth({ adapter, identity, betterAuthSecret, config: auth });
      },
      inject: [AUTH_ADAPTER_FACTORY, IDENTITY_PORT],
    },
    SessionGuard,
    AgentApiKeyGuard,
    AuthBootstrap,
    // Provided (not registered as Nest middleware): mounted as raw Express
    // middleware in bootstrap so it runs BEFORE the Better Auth handler.
    AuthRateLimitMiddleware,
  ],
  exports: [AUTH_INSTANCE, SessionGuard, AgentApiKeyGuard, AuthRateLimitMiddleware],
})
export class AuthModule {}
