import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/** Analytics aggregation API (#17, spec §9). Reads the tenant-scoped `analytics`
 * accessor from the persistence port (`DatabaseModule`); no state of its own. */
@Module({
  imports: [DatabaseModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
