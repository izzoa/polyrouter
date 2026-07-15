import { NotificationService } from './notification.service';
import type { NotifyQueue } from './notify.queue';
import type { NotificationEvent } from './notification.types';

const EVENT: NotificationEvent = { type: 'test', scope: { ownerUserId: 'u1' }, fields: {} };

describe('NotificationService.emit', () => {
  it('enqueues the fan-out and resolves', async () => {
    const enqueueFanout = jest.fn().mockResolvedValue(undefined);
    const svc = new NotificationService({ enqueueFanout } as unknown as NotifyQueue);
    await svc.emit(EVENT);
    expect(enqueueFanout).toHaveBeenCalledWith(EVENT);
  });

  it('never throws when the queue rejects (Redis down)', async () => {
    const queue = {
      enqueueFanout: jest.fn().mockRejectedValue(new Error('redis blackholed')),
    } as unknown as NotifyQueue;
    const svc = new NotificationService(queue);
    await expect(svc.emit(EVENT)).resolves.toBeUndefined();
  });
});
