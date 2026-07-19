// add-native-price-fallback — renderer provenance: estimate-priced spend is never
// presented as exact in budget alerts/blocks or the weekly summary; unmarked
// payloads render exactly as before.
import { renderEvent, type NotificationEvent } from './notification.types';

const base = { id: 'n1', createdAt: new Date() };

function ev(
  type: NotificationEvent['type'],
  fields: Record<string, string>,
): NotificationEvent {
  return {
    ...base,
    type,
    scope: { ownerUserId: 'u1' },
    fields,
  } as unknown as NotificationEvent;
}

describe('renderEvent — estimate-priced spend provenance', () => {
  it('budget_alert marks estimate-containing spend; unmarked renders as before', () => {
    const marked = renderEvent(
      ev('budget_alert', { limitName: 'Cap', spent: '$12.00', threshold: '$10.00', spendEstimated: 'true' }),
    );
    expect(marked.body).toContain('crossed the alert threshold');
    expect(marked.body).toContain('includes estimate-priced components');
    const plain = renderEvent(
      ev('budget_alert', { limitName: 'Cap', spent: '$12.00', threshold: '$10.00' }),
    );
    expect(plain.body).not.toContain('estimate-priced');
  });

  it('budget_block carries the same marking rule', () => {
    const marked = renderEvent(ev('budget_block', { limitName: 'Cap', spendEstimated: 'true' }));
    expect(marked.body).toContain('includes estimate-priced components');
    expect(renderEvent(ev('budget_block', { limitName: 'Cap' })).body).not.toContain(
      'estimate-priced',
    );
  });

  it('weekly summary includes the native-family split only when present', () => {
    const marked = renderEvent(
      ev('weekly_spend_summary', { total: '$10.00', nativeFamilySpend: '$1.00' }),
    );
    expect(marked.body).toContain('Known spend this week: $10.00.');
    expect(marked.body).toContain('Includes $1.00 priced by estimate');
    const plain = renderEvent(ev('weekly_spend_summary', { total: '$10.00' }));
    expect(plain.body).toBe('Known spend this week: $10.00.');
  });
});
