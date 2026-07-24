import { Module } from '@nestjs/common';
import { DashboardEvents } from './dashboard-events';
import { DashboardStreamRegistry } from './dashboard-stream.registry';
import { EVENTS_CONFIG, loadEventsConfig } from './events.config';

/**
 * The event BUS alone — no controller, and deliberately no dependency on the
 * in-flight registry (phase2-add-dashboard-event-stream).
 *
 * This split is what keeps the dependency graph acyclic: the publishers (the in-flight
 * registry, the log writer) import the bus, while the stream CONTROLLER imports both
 * the bus and the registry. Putting the controller here would make
 * `InflightModule → EventsModule → InflightModule` a cycle.
 */
@Module({
  providers: [
    DashboardEvents,
    DashboardStreamRegistry,
    { provide: EVENTS_CONFIG, useFactory: loadEventsConfig },
  ],
  exports: [DashboardEvents, DashboardStreamRegistry, EVENTS_CONFIG],
})
export class EventsBusModule {}
