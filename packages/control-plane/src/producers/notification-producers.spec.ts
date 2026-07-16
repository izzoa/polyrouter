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

describe('NotificationProducers.budgetAlert / budgetBlock', () => {
  it('emits an owner+limit-scoped budget_alert with formatted money and channelIds', () => {
    const { producers, emit } = make(1);
    producers.budgetAlert({
      ownerUserId: 'u1',
      agentId: 'ag1',
      budgetId: 'b1',
      periodId: '2026-03-15',
      name: 'Cap',
      spent: 12_000_000,
      threshold: 10_000_000,
      channelIds: ['ch1'],
    });
    expect(emit).toHaveBeenCalledWith({
      type: 'budget_alert',
      scope: { ownerUserId: 'u1', agentId: 'ag1', limitId: 'b1', lifecycleId: '2026-03-15' },
      fields: { limitName: 'Cap', spent: '$12.00', threshold: '$10.00' },
      channelIds: ['ch1'],
    });
  });

  it('omits channelIds when empty and agentId when absent (budget_block)', () => {
    const { producers, emit } = make(1);
    producers.budgetBlock({
      ownerUserId: 'u1',
      budgetId: 'b1',
      periodId: 'p',
      name: 'Cap',
      spent: 0,
      threshold: 5_000_000,
      channelIds: [],
    });
    expect(emit).toHaveBeenCalledWith({
      type: 'budget_block',
      scope: { ownerUserId: 'u1', limitId: 'b1', lifecycleId: 'p' },
      fields: { limitName: 'Cap', spent: '$0.00', threshold: '$5.00' },
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
