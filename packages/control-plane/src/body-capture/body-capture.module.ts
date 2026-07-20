import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { BODY_CAPTURE_CONFIG, loadBodyCaptureConfig } from './body-capture.config';
import { BodyCaptureController } from './body-capture.controller';
import { BodyCaptureService } from './body-capture.service';
import { BodyPurgeScheduler } from './body-purge.scheduler';

/** add-body-capture: the invariant-8 opt-in door — settings surface, the
 * proxy's capture-context seam, and the daily retention purge. */
@Module({
  imports: [DatabaseModule, RedisModule],
  controllers: [BodyCaptureController],
  providers: [
    { provide: BODY_CAPTURE_CONFIG, useFactory: loadBodyCaptureConfig },
    BodyCaptureService,
    BodyPurgeScheduler,
  ],
  exports: [BodyCaptureService, BODY_CAPTURE_CONFIG],
})
export class BodyCaptureModule {}
