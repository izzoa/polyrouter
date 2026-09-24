import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { DatabaseMaintenanceModule } from '../database/maintenance.module';
import { RedisModule } from '../redis/redis.module';
import { OauthRefreshScheduler } from './oauth-refresh.scheduler';
import { SubscriptionOauthModule } from './subscription-oauth.module';

/**
 * The OAuth proactive-refresh sweep's own module (add-provider-health-signals).
 * Controller-free by construction: the sweep enumerates connected providers across
 * owners through `PERSISTENCE_MAINTENANCE`, and a request-handling module — such as
 * `SubscriptionOauthModule`, which carries a controller — never imports that. It
 * consumes the OAuth service through `SubscriptionOauthModule`'s export.
 */
@Module({
  imports: [DatabaseModule, DatabaseMaintenanceModule, RedisModule, SubscriptionOauthModule],
  providers: [OauthRefreshScheduler],
})
export class OauthRefreshSchedulerModule {}
