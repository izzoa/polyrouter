import { runWeeklyOccurrence } from './weekly-summary.scheduler';
import type { NotificationService } from '../notifications/notification.service';
import type { WeeklySpendReader } from '../database/weekly-spend.reader';

const PREV = 1_700_000_000_000; // fixed occurrence timestamp
const WEEK_MS = 7 * 86_400_000;

describe('runWeeklyOccurrence (#15b)', () => {
  it('emits one per-owner summary over [prev-7d, prev), keyed by the occurrence', async () => {
    const seen: { start: Date; end: Date }[] = [];
    const reader: WeeklySpendReader = {
      weeklySpendByOwner: (start, end) => {
        seen.push({ start, end });
        return Promise.resolve([
          { ownerUserId: 'a', total: 12.5, nativeFamilySpend: 0 },
          { ownerUserId: 'b', total: 0, nativeFamilySpend: 0 },
        ]);
      },
    };
    const emit = jest.fn().mockResolvedValue(undefined);
    await runWeeklyOccurrence(reader, { emit } as unknown as NotificationService, PREV);

    // bounded half-open interval from the occurrence timestamp
    expect(seen[0]!.end.getTime()).toBe(PREV);
    expect(seen[0]!.start.getTime()).toBe(PREV - WEEK_MS);

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[0]![0]).toEqual({
      type: 'weekly_spend_summary',
      scope: { ownerUserId: 'a', lifecycleId: String(PREV) },
      fields: { total: '$12.50' },
    });
    // an all-unknown-cost owner renders 0 (not a crash, not a misleading total)
    expect(emit.mock.calls[1]![0]).toMatchObject({
      scope: { ownerUserId: 'b' },
      fields: { total: '$0.00' },
    });
  });
});

describe('weekly summary — native-family split field (add-native-price-fallback)', () => {
  it('includes nativeFamilySpend only for owners whose week has estimate-priced spend', async () => {
    const reader: WeeklySpendReader = {
      weeklySpendByOwner: () =>
        Promise.resolve([
          { ownerUserId: 'a', total: 10, nativeFamilySpend: 1 },
          { ownerUserId: 'b', total: 5, nativeFamilySpend: 0 },
        ]),
    };
    const emit = jest.fn().mockResolvedValue(undefined);
    await runWeeklyOccurrence(reader, { emit }, Date.parse('2026-03-16T08:00:00Z'));
    const byOwner = new Map(
      emit.mock.calls.map((c) => [
        (c[0] as { scope: { ownerUserId: string } }).scope.ownerUserId,
        (c[0] as { fields: Record<string, string> }).fields,
      ]),
    );
    expect(byOwner.get('a')).toMatchObject({ total: '$10.00', nativeFamilySpend: '$1.00' });
    expect(byOwner.get('b')).toEqual({ total: '$5.00' }); // no field when zero
  });
});

