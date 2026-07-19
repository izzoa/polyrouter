import { Module } from '@nestjs/common';
import { createProviderAdapter } from '@polyrouter/data-plane';
import { DatabaseModule } from '../database/database.module';
import { SubscriptionOauthModule } from '../subscription-oauth/subscription-oauth.module';
import { loadProvidersConfig, resolveCredentialKey } from './providers.config';
import { ModelsController } from './models.controller';
import { ProvidersController } from './providers.controller';
import {
  PROVIDER_ADAPTER_FACTORY,
  PROVIDERS_RUNTIME,
  ProvidersService,
  type ProvidersRuntime,
} from './providers.service';

/** Provider management (#7): CRUD + test-connection/sync-models + Models API.
 * The `PROVIDER_ADAPTER_FACTORY` default is #6's `createProviderAdapter`,
 * overridable in tests to avoid the network; `PROVIDERS_RUNTIME` resolves the
 * credential key + mode from config (boot fails fast on a missing prod key). */
@Module({
  imports: [DatabaseModule, SubscriptionOauthModule],
  controllers: [ProvidersController, ModelsController],
  providers: [
    ProvidersService,
    { provide: PROVIDER_ADAPTER_FACTORY, useValue: createProviderAdapter },
    {
      provide: PROVIDERS_RUNTIME,
      useFactory: (): ProvidersRuntime => {
        const { providers, base } = loadProvidersConfig();
        return { key: resolveCredentialKey(providers, base), mode: base.MODE };
      },
    },
  ],
})
export class ProvidersModule {}
