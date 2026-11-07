/**
 * The provider card's plan-usage line (add-subscription-quota-display task 7.2; dashboard-core
 * "A subscription provider card states its plan usage in one neutral line").
 *
 * The real App on a fake client. The line is the card's neutral caption (never green, red or amber,
 * the billing phrase alone in Ink 2); it is hidden while the status line states a plan pause or a
 * needed reconnect and returns at the pause's end; one timer flips a window to
 * `reset · awaiting new data` at its reset with no list reload, clamped to 24 hours so a reset a
 * month or a year away neither fires early nor loops; and a screen reader reads it as one line of
 * text naming each window, its percent and its reset, and the time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fmtAsOf, fmtReset } from './data/format';
import { PLAN_USAGE_COPY } from './data/planUsage';
import {
  calls,
  iso,
  mkProvider,
  mount,
  T0,
  unmountAll,
  usageLine,
  useFakeClock,
  usageOf,
  window5h,
  windowWeekly,
  flush,
} from './test/planUsageHarness';

beforeEach(useFakeClock);
afterEach(unmountAll);

const CLAUDE = usageOf([window5h(), windowWeekly()]);
const claudeCard = (over: Parameters<typeof mkProvider>[0] = {}) =>
  mkProvider({
    name: 'Claude Max',
    keyPreset: null,
    oauthPreset: 'claude',
    baseUrl: 'https://api.anthropic.com',
    planUsage: CLAUDE,
    ...over,
  });

describe('the line', () => {
  it('reads each window in order, then the observation time', async () => {
    const h = await mount(claudeCard());
    const reset5h = fmtReset(iso(T0 + 2 * 3_600_000), T0);
    const resetWeek = fmtReset(iso(T0 + 3 * 86_400_000), T0);
    const asOf = fmtAsOf(iso(T0 - 5 * 60_000), T0);
    expect(usageLine(h)?.textContent).toBe(
      `5h 62% · resets ${String(reset5h)} · weekly 31% · resets ${String(resetWeek)} · as of ${String(asOf)}`,
    );
  });

  it('sits under the token line and above the Terms-risk notice', async () => {
    const h = await mount(claudeCard());
    const order = (sel: string): number =>
      [...h.host.querySelectorAll('*')].indexOf(h.host.querySelector(sel)!);
    expect(order('[data-token-line]')).toBeGreaterThan(-1);
    expect(order('[data-usage-line]')).toBeGreaterThan(order('[data-token-line]'));
    const terms = [...h.host.querySelectorAll('*')].findIndex(
      (e) => /Terms risk/.test(e.textContent ?? '') && e.children.length === 0,
    );
    expect(order('[data-usage-line]')).toBeLessThan(terms);
  });

  it('is neutral: no green, red or amber on the line, and no word that states health', async () => {
    const h = await mount(
      claudeCard({
        planUsage: usageOf([window5h({ usedPercent: 100 })], {
          state: 'extra_usage',
          observedAt: iso(T0 - 60_000),
        }),
      }),
    );
    const el = usageLine(h)!;
    const painted = [el, ...el.querySelectorAll<HTMLElement>('*')]
      .map((n) => n.getAttribute('style') ?? '')
      .join(';');
    expect(painted).not.toMatch(/--green|--red|--amber/);
    expect(el.className).not.toMatch(/green|red|amber|warn|caution/);
    expect(el.textContent).not.toMatch(/healthy|failing|error|degraded|limit reached|stale/i);
    // The billing phrase is Ink 2, a full-contrast phrase; the rest is the caption's Ink 3.
    expect(el.querySelector('[data-usage-billing]')?.getAttribute('style')).toContain('--text2');
    expect(el.getAttribute('style')).toContain('--text3');
  });

  it('an aged observation keeps its own as-of time: never a stale caption, never amber', async () => {
    const observedAt = iso(T0 - 60_000);
    const h = await mount(claudeCard({ planUsage: usageOf([window5h({ observedAt })]) }));
    const asOf = `as of ${fmtAsOf(observedAt, T0)}`;
    expect(usageLine(h)?.textContent).toContain(asOf);
    // 38 minutes pass with no new data; the 5h reset (T0 + 2h) is still ahead.
    await vi.advanceTimersByTimeAsync(38 * 60_000);
    const el = usageLine(h)!;
    expect(el.textContent).toContain(asOf);
    expect(el.textContent).not.toMatch(/stale/i);
    const painted = [el, ...el.querySelectorAll<HTMLElement>('*')]
      .map((n) => n.getAttribute('style') ?? '')
      .join(';');
    expect(painted).not.toMatch(/--amber/);
  });

  it('leads with the billing phrase when the plan is billing extra usage', async () => {
    const h = await mount(
      claudeCard({
        planUsage: usageOf([window5h({ usedPercent: 100 })], {
          state: 'extra_usage',
          observedAt: iso(T0 - 60_000),
        }),
      }),
    );
    expect(usageLine(h)?.textContent?.startsWith(PLAN_USAGE_COPY.extraUsage)).toBe(true);
  });

  it('a provider with no usage shows no line, no 0% and no placeholder', async () => {
    const h = await mount(claudeCard({ planUsage: null }));
    expect(usageLine(h)).toBeNull();
    expect(h.host.querySelector('[data-usage]')).toBeNull();
    expect(h.host.textContent).not.toMatch(/\b0%|as of/);
  });

  it('states a missing value as unknown', async () => {
    const h = await mount(
      claudeCard({
        planUsage: usageOf([window5h({ usedPercent: null, resetAt: null })]),
      }),
    );
    expect(usageLine(h)?.textContent).toMatch(/^5h unknown · resets unknown · as of /);
  });

  it('lists model buckets under a native disclosure labelled with their count', async () => {
    const h = await mount(
      claudeCard({
        planUsage: usageOf([
          window5h(),
          window5h({
            key: 'model:gpt_5_2_codex_sonic',
            group: 'model',
            scope: 'gpt-5.2-codex-sonic',
            usedPercent: 80,
          }),
        ]),
      }),
    );
    const details = h.host.querySelector<HTMLDetailsElement>('details[data-usage-buckets]')!;
    expect(details.querySelector('summary')?.textContent).toBe('model limits (1)');
    expect(details.textContent).toContain('gpt-5.2-codex-sonic 80%');
    expect(usageLine(h)?.textContent).not.toMatch(/sonic/);
  });
});

describe('the line yields to the status line', () => {
  it('is absent during a plan pause and returns at the pause end, with no reload', async () => {
    const until = T0 + 10 * 60_000;
    const h = await mount(
      claudeCard({
        planCooldown: { kind: 'quota_exhausted', until: iso(until), untilSource: 'provider' },
      }),
    );
    expect(usageLine(h)).toBeNull();
    const loads = calls(h.fake, 'listProviders').length;
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 50);
    expect(usageLine(h)).not.toBeNull();
    expect(calls(h.fake, 'listProviders')).toHaveLength(loads);
  });

  it('is absent while the reconnect banner shows', async () => {
    const h = await mount(
      claudeCard({
        health: {
          state: 'reauthorize_required',
          kind: 'credential',
          message: 'x',
          source: 'refresh',
          at: iso(T0),
        },
      }),
    );
    expect(usageLine(h)).toBeNull();
    expect(h.host.textContent).toMatch(/Reconnect needed/);
  });

  it('shows beside the one status line otherwise, and states no health itself', async () => {
    const h = await mount(claudeCard());
    expect(h.host.querySelectorAll('[data-health-line]')).toHaveLength(1);
    expect(usageLine(h)).not.toBeNull();
  });
});

describe('a window flips at its reset instant', () => {
  it('reads reset · awaiting new data at the timer, with no reload', async () => {
    const reset = T0 + 2 * 3_600_000;
    const h = await mount(claudeCard());
    const loads = calls(h.fake, 'listProviders').length;
    expect(usageLine(h)?.textContent).toMatch(/^5h 62% /);
    await vi.advanceTimersByTimeAsync(reset - T0 - 1_000);
    expect(usageLine(h)?.textContent).toMatch(/^5h 62% /);
    await vi.advanceTimersByTimeAsync(1_000);
    const text = usageLine(h)?.textContent ?? '';
    expect(text).toMatch(/^5h reset · awaiting new data · weekly 31% /);
    expect(text).not.toMatch(/62%/);
    expect(calls(h.fake, 'listProviders')).toHaveLength(loads);
  });

  it('drops the billing phrase at the reset it said nothing past', async () => {
    const reset = T0 + 3_600_000;
    const h = await mount(
      claudeCard({
        planUsage: usageOf([window5h({ usedPercent: 100, resetAt: iso(reset) })], {
          state: 'extra_usage',
          observedAt: iso(T0 - 60_000),
        }),
      }),
    );
    expect(usageLine(h)?.textContent).toContain(PLAN_USAGE_COPY.extraUsage);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(usageLine(h)?.textContent).not.toMatch(/extra usage|credits/i);
    expect(usageLine(h)?.textContent).toMatch(/^5h reset · awaiting new data/);
  });

  describe.each([
    ['30 days', 30],
    ['400 days', 400],
  ] as const)('a reset %s away', (_name, days) => {
    it('arms 24 hours first, never fires early, never loops, and still flips at its instant', async () => {
      const reset = T0 + days * 86_400_000;
      // A spy passes through to the fake timers, and records every delay a timer is armed with.
      const spy = vi.spyOn(globalThis, 'setTimeout');
      const delays = (): number[] => spy.mock.calls.map((c) => Number(c[1] ?? 0));
      try {
        const h = await mount(
          claudeCard({
            planUsage: usageOf([
              window5h({ span: 'monthly', key: 'account:monthly', resetAt: iso(reset) }),
            ]),
          }),
        );
        // The clamp: the first usage timer waits 24 h, and nothing waits past setTimeout's limit.
        expect(delays()).toContain(86_400_000);
        expect(Math.max(...delays())).toBeLessThanOrEqual(2 ** 31 - 1);
        // Nothing fired at once: the window still shows its percent.
        await flush();
        expect(usageLine(h)?.textContent).toMatch(/^monthly 62% /);
        const armed = delays().length;

        await vi.advanceTimersByTimeAsync(reset - T0 - 1_000);
        expect(usageLine(h)?.textContent).toMatch(/^monthly 62% /);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(usageLine(h)?.textContent).toMatch(/^monthly reset · awaiting new data/);
        // One re-arm per day at most, with a little slack: bounded, never a loop.
        expect(delays().length - armed).toBeLessThanOrEqual(days + 5);
        expect(Math.max(...delays())).toBeLessThanOrEqual(2 ** 31 - 1);
      } finally {
        spy.mockRestore();
      }
    }, 30_000);
  });

  it('names the year of a reset outside the current one', async () => {
    const h = await mount(
      claudeCard({
        planUsage: usageOf([
          window5h({ span: 'annual', key: 'account:annual', resetAt: '2027-03-01T12:00:00.000Z' }),
        ]),
      }),
    );
    expect(usageLine(h)?.textContent).toMatch(/resets Mar 1, 2027, /);
  });
});

describe('read as text', () => {
  it('is one text line naming each window, its percent and its reset, and the time', async () => {
    const h = await mount(claudeCard());
    const el = usageLine(h)!;
    // One element holding plain text: no per-window widget, no aria-hidden part.
    expect(el.querySelector('[aria-hidden]')).toBeNull();
    const text = el.textContent ?? '';
    for (const part of ['5h 62%', 'weekly 31%', 'as of']) expect(text).toContain(part);
    expect(text.match(/resets /g)).toHaveLength(2);
    expect(el.getAttribute('aria-label')).toBeNull();
    expect(el.getAttribute('role')).toBeNull();
  });
});
