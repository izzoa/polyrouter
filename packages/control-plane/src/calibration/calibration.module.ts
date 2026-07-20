import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { ROUTING_CONFIG, loadRoutingConfig } from '../proxy/routing.config';
import { CALIBRATION_CONFIG, loadCalibrationConfig } from './calibration.config';
import { CalibrationScheduler } from './calibration.scheduler';

/** Threshold calibration (add-auto-threshold-calibration): the scheduled,
 * off-hot-path sweep. The proxy's hot-path override read lives in
 * ProxyModule; this module owns only the background loop. */
@Module({
  imports: [DatabaseModule, RedisModule],
  providers: [
    { provide: ROUTING_CONFIG, useFactory: loadRoutingConfig },
    { provide: CALIBRATION_CONFIG, useFactory: loadCalibrationConfig },
    CalibrationScheduler,
  ],
  exports: [CalibrationScheduler],
})
export class CalibrationModule {}
