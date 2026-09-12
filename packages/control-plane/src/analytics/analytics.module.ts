import { Module } from '@nestjs/common';
import { BodyCaptureModule } from '../body-capture/body-capture.module';
import { DatabaseModule } from '../database/database.module';
import { PricingModule } from '../pricing/pricing.module';
import { InflightModule } from '../inflight/inflight.module';
import { ROUTING_CONFIG, loadRoutingConfig } from '../proxy/routing.config';
import {
  CALIBRATION_CONFIG,
  CALIBRATION_RAILS,
  loadCalibrationConfig,
  railsOf,
  type CalibrationRails,
} from '../calibration/calibration.config';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/** Analytics aggregation API (#17, spec §9). Reads the tenant-scoped `analytics`
 * accessor from the persistence port (`DatabaseModule`); no state of its own.
 *
 * The calibration config, rails and structural thresholds are provided LOCALLY by
 * their own factories rather than by importing `CalibrationModule` — the same
 * pattern `RoutingConfigModule` uses, and the reason there is no circular import:
 * these are pure boot-time config loaders, not another module's state. They exist
 * here so `calibrationEvidence` reports the geometry actually in force
 * (add-per-agent-calibration-evidence). */
@Module({
  imports: [DatabaseModule, PricingModule, BodyCaptureModule, InflightModule],
  controllers: [AnalyticsController],
  providers: [
    AnalyticsService,
    { provide: ROUTING_CONFIG, useFactory: loadRoutingConfig },
    { provide: CALIBRATION_CONFIG, useFactory: loadCalibrationConfig },
    {
      provide: CALIBRATION_RAILS,
      useFactory: (): CalibrationRails => railsOf(loadCalibrationConfig()),
    },
  ],
})
export class AnalyticsModule {}
