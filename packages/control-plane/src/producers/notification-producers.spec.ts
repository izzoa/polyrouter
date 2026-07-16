import { userPrincipal } from '@polyrouter/shared/server';
import { Redis } from 'ioredis';
import { NotificationProducers } from './notification-producers';
import type { NotificationService } from '../notifications/notification.service';
import type { ProducersConfig } from './producers.config';

const PRINCIPAL = userPrincipal('u1');

function make(evalResult: number | Error) {
  const emit = jest.fn().mockResolvedValue(undefined);
  const notifications = { emit } as unknown as NotificationService;
  const redis = {
    eval:
      evalResult instanceof Error
        ? jest.fn().mockRejectedValue(evalResult)
        : jest.fn().mockResolvedValue(evalResult),
  } as unknown as Redis;
  const cfg: ProducersConfig = {
    mode: 'selfhosted',
    allowedEndpoints: [],
    systemSmtp: undefined,
    failureThreshold: 3,
    failureWindowMs: 900_000,
    weeklyEnabled: false,
    weeklyCron: '0 8 * * 1',
  };
  return { producers: new NotificationProducers(notifications, redis, cfg), emit };
}

describe('NotificationProducers.providerDown', () => {
  it('emits an owner-scoped provider_down with the provider name', () => {
    const { producers, emit } = make(1);
    producers.providerDown('prov-1', 'OpenAI', 'u1');
    expect(emit).toHaveBeenCalledWith({
      type: 'provider_down',
      scope: { ownerUserId: 'u1', providerId: 'prov-1' },
      fields: { providerName: 'OpenAI' },
    });
  });
});

describe('NotificationProducers.onRequestFailed', () => {
  it('emits a spike exactly when the counter reaches the threshold', async () => {
    const { producers, emit } = make(3);
    await producers.onRequestFailed(PRINCIPAL);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0]).toMatchObject({
      type: 'request_failures_spike',
      scope: { ownerUserId: 'u1' },
      fields: { count: 3 },
    });
  });

  it('does not emit below the threshold', async () => {
    const { producers, emit } = make(2);
    await producers.onRequestFailed(PRINCIPAL);
    expect(emit).not.toHaveBeenCalled();
  });

  it('does not re-emit above the threshold (only on equality)', async () => {
    const { producers, emit } = make(4);
    await producers.onRequestFailed(PRINCIPAL);
    expect(emit).not.toHaveBeenCalled();
  });

  it('swallows a Redis fault (never throws, never emits)', async () => {
    const { producers, emit } = make(new Error('redis down'));
    await expect(producers.onRequestFailed(PRINCIPAL)).resolves.toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
  });
});
