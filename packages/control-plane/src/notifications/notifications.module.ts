import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';
import { NotificationService } from './notification.service';
import { NotifyQueue } from './notify.queue';
import { NOTIFY_RUNTIME, resolveNotifyRuntime } from './notify.config';
import './notify.config';

/**
 * Notification delivery core (#15a). `NOTIFY_RUNTIME` is an **async** provider
 * that SSRF-validates `APPRISE_API_URL` before resolving — the queue/adapters
 * depend on it, so a bad value fails construction + boot. Exports
 * `NotificationService` for #16 (budget) and #15b (producers) to `emit` into.
 */
@Module({
  imports: [DatabaseModule, RedisModule],
  controllers: [ChannelsController],
  providers: [
    { provide: NOTIFY_RUNTIME, useFactory: resolveNotifyRuntime },
    NotifyQueue,
    NotificationService,
    ChannelsService,
  ],
  exports: [NotificationService],
})
export class NotificationsModule {}
