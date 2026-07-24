import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InflightModule } from '../inflight/inflight.module';
import { EventsBusModule } from './events-bus.module';
import { EventsController } from './events.controller';

/**
 * The dashboard event-stream ENDPOINT (phase2-add-dashboard-event-stream). The bus
 * itself lives in `EventsBusModule` so publishers can import it without pulling in
 * the controller's dependency on the in-flight registry (which would be a cycle).
 */
@Module({
  imports: [EventsBusModule, AuthModule, InflightModule],
  controllers: [EventsController],
})
export class EventsModule {}
