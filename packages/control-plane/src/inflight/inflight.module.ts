import { Module } from '@nestjs/common';
import { EventsBusModule } from '../events/events-bus.module';
import { InflightTransitionsAdapter } from '../events/inflight-transitions.adapter';
import { RedisModule } from '../redis/redis.module';
import { INFLIGHT_TRANSITIONS, InflightRegistry } from './inflight-registry';

/** Provides the ephemeral in-flight registry (add-inflight-requests) — imported by
 * the proxy (which publishes/settles entries) and by analytics (which reads them).
 * Also binds the optional transition sink so mark/settle reach the dashboard event
 * bus (phase2-add-dashboard-event-stream); the registry itself stays unaware of it. */
@Module({
  imports: [RedisModule, EventsBusModule],
  providers: [
    InflightRegistry,
    InflightTransitionsAdapter,
    { provide: INFLIGHT_TRANSITIONS, useExisting: InflightTransitionsAdapter },
  ],
  exports: [InflightRegistry],
})
export class InflightModule {}
