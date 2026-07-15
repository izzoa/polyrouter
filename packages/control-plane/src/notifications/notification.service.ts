import { Injectable, Logger } from '@nestjs/common';
import { NotifyQueue } from './notify.queue';
import type { NotificationEvent } from './notification.types';

/**
 * The emit facade (#15a) — the entry point #16 (budget) and #15b (producers)
 * call. Enqueues off the caller's path and **never throws or blocks** (a
 * down/blackholed Redis is caught + logged), so it cannot stall a request or a
 * budget check (invariant 11).
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger('NotificationService');

  constructor(private readonly queue: NotifyQueue) {}

  async emit(event: NotificationEvent): Promise<void> {
    try {
      await this.queue.enqueueFanout(event);
    } catch (err) {
      // Never block/throw into the caller; the reason is opaque (no secret).
      this.logger.warn(`notify emit dropped (${event.type}): ${(err as Error)?.name ?? 'error'}`);
    }
  }
}
