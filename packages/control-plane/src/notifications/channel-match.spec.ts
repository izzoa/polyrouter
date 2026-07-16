import { channelMatchesEvent, type NotificationEvent } from './notification.types';

const EVENT: NotificationEvent = {
  type: 'budget_alert',
  scope: { ownerUserId: 'u1' },
  fields: {},
};

function ch(p: Partial<{ id: string; enabled: boolean; eventsSubscribed: string }>) {
  return { id: 'c1', enabled: true, eventsSubscribed: 'budget_alert,test', ...p };
}

describe('channelMatchesEvent', () => {
  it('requires the channel to be enabled and subscribed to the type', () => {
    expect(channelMatchesEvent(ch({}), EVENT)).toBe(true);
    expect(channelMatchesEvent(ch({ enabled: false }), EVENT)).toBe(false);
    expect(channelMatchesEvent(ch({ eventsSubscribed: 'test' }), EVENT)).toBe(false);
  });

  it('intersects the per-event channel allow-list when present (#16 per-budget targeting)', () => {
    const targeted: NotificationEvent = { ...EVENT, channelIds: ['c2'] };
    expect(channelMatchesEvent(ch({ id: 'c1' }), targeted)).toBe(false);
    expect(channelMatchesEvent(ch({ id: 'c2' }), targeted)).toBe(true);
  });

  it('an absent allow-list targets all subscribed channels', () => {
    expect(channelMatchesEvent(ch({ id: 'cX' }), EVENT)).toBe(true);
  });
});
