import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DataPlaneModule } from '@polyrouter/data-plane';
import { AgentsController } from './agents/agents.controller';
import { AuthModule } from './auth/auth.module';
import { SessionGuard } from './auth/session.guard';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { NotificationsModule } from './notifications/notifications.module';
import { PricingModule } from './pricing/pricing.module';
import { ProvidersModule } from './providers/providers.module';
import { ProxyModule } from './proxy/proxy.module';
import { RecordingModule } from './recording/recording.module';
import { RedisModule } from './redis/redis.module';
import { RoutingConfigModule } from './routing-config/routing-config.module';

@Module({
  imports: [
    DatabaseModule,
    RedisModule,
    AuthModule,
    DataPlaneModule,
    ProvidersModule,
    PricingModule,
    RoutingConfigModule,
    ProxyModule,
    RecordingModule,
    NotificationsModule,
  ],
  controllers: [HealthController, AgentsController],
  providers: [
    // Global registration, but the guard itself early-returns for non-`/api`
    // paths, so `/v1` stays on the agent-key plane.
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
})
export class AppModule {}
