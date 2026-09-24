import { describe, expect, it } from 'vitest';
import type { ProviderHealthDto } from './api';
import { providerHealthView } from './providerHealth';

const NOW = Date.parse('2026-09-24T12:00:00Z');
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString();

const card = (
  health: Partial<ProviderHealthDto>,
  oauthPreset: string | null = null,
): { oauthPreset: string | null; health: ProviderHealthDto } => ({
  oauthPreset,
  health: { state: 'unknown', kind: null, message: null, source: null, at: null, ...health },
});

describe('providerHealthView (add-provider-health-signals)', () => {
  it('the reauthorize-required state is the distinct banner, over everything', () => {
    const v = providerHealthView(
      card({ state: 'reauthorize_required', kind: 'credential' }, 'claude'),
      NOW,
      true,
    );
    expect(v).toMatchObject({ tone: 'amber', banner: true });
    expect(v.text).toMatch(/reconnect/i);
  });

  it('a reconnect in flight reads as checking', () => {
    expect(
      providerHealthView(card({ state: 'unknown', source: 'reconnect' }, 'claude'), NOW, true),
    ).toEqual({
      tone: 'neutral',
      text: 'Reconnected — checking…',
      banner: false,
    });
  });

  it('a live-traffic failure states the reason, where, and how long ago', () => {
    const v = providerHealthView(
      card({
        state: 'failing',
        kind: 'auth',
        message: 'authentication failed',
        source: 'traffic',
        at: minutesAgo(12),
      }),
      NOW,
      false,
    );
    expect(v).toEqual({
      tone: 'red',
      text: 'authentication failed · seen in live traffic 12m ago',
      banner: false,
    });
  });

  it('an OAuth auth failure adds the reconnect hint; other kinds do not', () => {
    const auth = providerHealthView(
      card(
        {
          state: 'error',
          kind: 'auth',
          message: 'authentication failed',
          source: 'test',
          at: minutesAgo(120),
        },
        'chatgpt',
      ),
      NOW,
      false,
    );
    expect(auth.text).toBe('authentication failed · Test 2h ago — reconnect if this persists');
    const rate = providerHealthView(
      card(
        {
          state: 'failing',
          kind: 'rate_limit',
          message: 'provider rate limited',
          source: 'traffic',
          at: minutesAgo(1),
        },
        'chatgpt',
      ),
      NOW,
      false,
    );
    expect(rate.text).not.toMatch(/reconnect/);
  });

  it('healthy states its source and age', () => {
    expect(
      providerHealthView(card({ state: 'ok', source: 'traffic', at: minutesAgo(3) }), NOW, false),
    ).toEqual({ tone: 'green', text: 'Healthy · seen in live traffic 3m ago', banner: false });
    expect(
      providerHealthView(card({ state: 'ok', source: 'sync', at: minutesAgo(30) }), NOW, false)
        .text,
    ).toBe('Healthy · Sync 30m ago');
  });

  it('a legacy status with no recorded source renders without an invented reason or age', () => {
    expect(providerHealthView(card({ state: 'error' }), NOW, false)).toEqual({
      tone: 'red',
      text: 'Last check failed',
      banner: false,
    });
    expect(providerHealthView(card({ state: 'ok' }), NOW, false).text).toBe('Healthy');
  });

  it('nothing recorded reads as not tested yet', () => {
    expect(providerHealthView(card({}), NOW, false)).toEqual({
      tone: 'neutral',
      text: 'Not tested yet',
      banner: false,
    });
  });
});
