import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { loadProvidersConfig, resolveCredentialKey } from '../providers/providers.config';
import { PROVIDERS_RUNTIME, type ProvidersRuntime } from '../providers/providers.service';
import { SubscriptionOauthModule } from '../subscription-oauth/subscription-oauth.module';
import { KEY_PRESET_LOOKUP, defaultKeyPresetRegistry } from './key-presets';
import { KeyPresetsController } from './subscription-presets.controller';
import { SubscriptionPresetsService } from './subscription-presets.service';

/**
 * API-key subscription presets (add-key-subscription-presets): the list and connect
 * endpoints over the bundled key-preset registry. `KEY_PRESET_LOOKUP` is bound with
 * `useValue` to the bundled constants, exactly as `OAUTH_PRESET_LOOKUP` is — no factory, no
 * env var, no config value (design D6). e2e suites enable presets with
 * `.overrideProvider(KEY_PRESET_LOOKUP)`; nothing at runtime can.
 */
@Module({
  imports: [DatabaseModule, SubscriptionOauthModule],
  controllers: [KeyPresetsController],
  providers: [
    SubscriptionPresetsService,
    { provide: KEY_PRESET_LOOKUP, useValue: defaultKeyPresetRegistry },
    {
      provide: PROVIDERS_RUNTIME,
      useFactory: (): ProvidersRuntime => {
        const { providers, base } = loadProvidersConfig();
        return { key: resolveCredentialKey(providers, base), mode: base.MODE };
      },
    },
  ],
})
export class SubscriptionPresetsModule {}
