import { describe, expect, it } from 'vitest';
import type { PlanCooldownDto, ProviderHealthDto } from './api';
import { activePause, providerHealthView } from './providerHealth';
import { fmtUntil } from './format';

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

describe('providerHealthView — a plan pause (classify-plan-quota-errors)', () => {
  const inMinutes = (m: number): string => new Date(NOW + m * 60_000).toISOString();
  const paused = (
    c: Partial<PlanCooldownDto>,
    health: Partial<ProviderHealthDto> = {},
  ): ReturnType<typeof card> & { planCooldown: PlanCooldownDto } => ({
    ...card(health),
    planCooldown: {
      kind: 'quota_exhausted',
      until: inMinutes(360),
      untilSource: 'provider',
      ...c,
    },
  });
  const view = (p: ReturnType<typeof paused>) => providerHealthView(p, NOW, false, 'UTC');

  it.each([
    ['quota_exhausted', /^Plan usage limit reached/],
    ['risk_control', /^Provider throttled the account \(fair-use policy\)/],
    ['plan_inactive', /^No active plan for this key/],
  ] as const)('%s leads with the account condition, in amber', (kind, lead) => {
    const v = view(paused({ kind }));
    expect(v.text).toMatch(lead);
    expect(v).toMatchObject({ tone: 'amber', banner: false });
  });

  it('plan_inactive names both causes: an expired plan, or a key that is not a plan key', () => {
    expect(view(paused({ kind: 'plan_inactive' })).text).toMatch(/expired, or not a plan key/);
  });

  it('a provider-stated end reads "resets at", never "polyrouter retries"', () => {
    const v = view(paused({ untilSource: 'provider' }));
    expect(v.text).toMatch(/ — resets at /);
    expect(v.text).not.toMatch(/polyrouter retries/);
  });

  it('a polyrouter-chosen end reads "polyrouter retries at", never as the provider reset', () => {
    const v = view(paused({ untilSource: 'default' }));
    expect(v.text).toMatch(/ — polyrouter retries at /);
    expect(v.text).not.toMatch(/resets/);
  });

  it('the end is exactly fmtUntil output for the future instant, never "just now"', () => {
    const c = paused({ until: inMinutes(60 * 24 * 3) }); // on another day
    const end = fmtUntil(c.planCooldown.until, NOW, 'UTC');
    expect(end).toMatch(/^Sep \d+, \d\d:\d\d UTC$/);
    expect(view(c).text).toBe(`Plan usage limit reached — resets at ${String(end)}`);
    expect(view(c).text).not.toMatch(/just now|ago/);
  });

  it('a pause outranks an error and an ok health while it holds', () => {
    const failing = view(
      paused(
        {},
        {
          state: 'failing',
          kind: 'rate_limit',
          message: 'x',
          source: 'traffic',
          at: minutesAgo(1),
        },
      ),
    );
    expect(failing.tone).toBe('amber');
    expect(failing.text).not.toMatch(/Last check failed|^x/);
    const ok = view(paused({}, { state: 'ok', source: 'test', at: minutesAgo(1) }));
    expect(ok.text).not.toMatch(/Healthy/);
  });

  it('an expired pause falls back to the displayed health', () => {
    const expired = paused(
      { until: inMinutes(-1) },
      { state: 'ok', source: 'test', at: minutesAgo(5) },
    );
    expect(view(expired)).toEqual({ tone: 'green', text: 'Healthy · Test 5m ago', banner: false });
    expect(activePause(expired, NOW)).toBeNull();
    expect(activePause(paused({ until: 'not a date' }), NOW)).toBeNull();
    expect(activePause({ planCooldown: null }, NOW)).toBeNull();
    expect(activePause({}, NOW)).toBeNull();
  });

  it('a pause line is never red and never "Healthy", in every kind and source', () => {
    for (const kind of ['quota_exhausted', 'risk_control', 'plan_inactive'] as const) {
      for (const untilSource of ['provider', 'default'] as const) {
        const v = view(
          paused({ kind, untilSource }, { state: 'ok', source: 'test', at: minutesAgo(1) }),
        );
        expect(v.tone).not.toBe('red');
        expect(v.text).not.toMatch(/Healthy/);
      }
    }
  });
});
