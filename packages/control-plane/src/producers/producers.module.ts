import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MailerModule } from './mailer.module';
import { NotificationProducers } from './notification-producers';
import { WeeklySummaryScheduler } from './weekly-summary.scheduler';

/** #15b event producers (provider_down, spike, weekly). Emits into #15a's
 * non-blocking `NotificationService`; the weekly rollup reads the narrow
 * `WEEKLY_SPEND_READER`; `PRODUCERS_CONFIG`/`SystemMailer` come from `MailerModule`. */
@Module({
  imports: [MailerModule, DatabaseModule, RedisModule, NotificationsModule],
  providers: [NotificationProducers, WeeklySummaryScheduler],
  exports: [NotificationProducers, MailerModule],
})
export class ProducersModule {}
