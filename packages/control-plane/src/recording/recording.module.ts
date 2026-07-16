import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ObservabilityModule } from '../observability/observability.module';
import { PricingModule } from '../pricing/pricing.module';
import { DEFAULT_LOG_WRITER_CONFIG, LOG_WRITER_CONFIG, LogWriter } from './log-writer';
import { RequestRecorder } from './request-recorder';

/** Request logging (#11): the async, failure-isolated writer + the recorder the
 * proxy calls fire-and-forget. `PricingModule` supplies `PricingService` for the
 * writer's immutable price snapshot; `DatabaseModule` the persistence port;
 * `ObservabilityModule` the #21 metrics the recorder/writer emit. */
@Module({
  imports: [DatabaseModule, PricingModule, ObservabilityModule],
  providers: [
    LogWriter,
    RequestRecorder,
    { provide: LOG_WRITER_CONFIG, useValue: DEFAULT_LOG_WRITER_CONFIG },
  ],
  exports: [RequestRecorder],
})
export class RecordingModule {}
