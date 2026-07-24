import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { InflightRegistry } from './inflight-registry';

/** Provides the ephemeral in-flight registry (add-inflight-requests) — imported by
 * the proxy (which publishes/settles entries) and by analytics (which reads them). */
@Module({
  imports: [RedisModule],
  providers: [InflightRegistry],
  exports: [InflightRegistry],
})
export class InflightModule {}
