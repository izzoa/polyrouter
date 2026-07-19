import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { loadProvidersConfig, resolveCredentialKey } from '../providers/providers.config';
import { SubscriptionOauthController } from './subscription-oauth.controller';
import {
  OAUTH_PRESET_LOOKUP,
  OAUTH_TOKEN_FETCH,
  SUBSCRIPTION_OAUTH_RUNTIME,
  SubscriptionOauthService,
  defaultPresetRegistry,
  defaultTokenFetch,
  type SubscriptionOauthRuntime,
} from './subscription-oauth.service';

/** Subscription OAuth (add-subscription-oauth): connect sessions, token lifecycle,
 * and the credential-resolution seam. `OAUTH_TOKEN_FETCH` / `OAUTH_PRESET_LOOKUP`
 * are overridable in tests (stub IdP / stub presets); the runtime reuses the
 * provider-credential key + mode resolution. */
@Module({
  imports: [DatabaseModule, RedisModule],
  controllers: [SubscriptionOauthController],
  providers: [
    SubscriptionOauthService,
    { provide: OAUTH_TOKEN_FETCH, useValue: defaultTokenFetch },
    { provide: OAUTH_PRESET_LOOKUP, useValue: defaultPresetRegistry },
    {
      provide: SUBSCRIPTION_OAUTH_RUNTIME,
      useFactory: (): SubscriptionOauthRuntime => {
        const { providers, base } = loadProvidersConfig();
        return { key: resolveCredentialKey(providers, base), mode: base.MODE };
      },
    },
  ],
  exports: [SubscriptionOauthService],
})
export class SubscriptionOauthModule {}
