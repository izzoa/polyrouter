/**
 * Refresh usage on a provider card (add-subscription-quota-display task 7.3; dashboard-core
 * "Refresh usage is offered where a usage endpoint exists, with its cooldown stated").
 *
 * The real App on a fake client. The ghost button has the shared pressed, busy and disabled
 * states; while the cooldown holds it is natively disabled and the time it returns is stated in
 * text, linked by aria-describedby; the timer at `availableAt` re-enables it. Every outcome is
 * announced in its role, with focus moved to the focusable outcome text (the button stays disabled
 * for the cooldown, so focus would otherwise fall to the page). A success merges the response's
 * provider into the store by id: the card is the same node, an open model-limits disclosure stays
 * open and no list reload follows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  type PlanUsageDto,
  type PlanUsageRefreshResultDto,
  type ProviderDto,
} from './data/api';
import { fmtAsOf, fmtUntil } from './data/format';
import {
  calls,
  flush,
  iso,
  mkProvider,
  mount,
  refreshButton,
  T0,
  unmountAll,
  usageLine,
  useFakeClock,
  usageOf,
  window5h,
  windowWeekly,
  type Harness,
} from './test/planUsageHarness';

beforeEach(useFakeClock);
afterEach(unmountAll);

const COOLDOWN = 5 * 60_000;
// Factories, not shared objects: the store reconciles a response INTO the object it holds, so a
// module-level fixture would carry one test's merge into the next.
const oldUsage = (): PlanUsageDto => usageOf([window5h({ usedPercent: 40 })]);
const newUsage = (): PlanUsageDto =>
  usageOf([
    window5h({ usedPercent: 71, observedAt: iso(T0), source: 'refresh' }),
    windowWeekly({ usedPercent: 12, observedAt: iso(T0), source: 'refresh' }),
  ]);

const offered = (over: Parameters<typeof mkProvider>[0] = {}) =>
  mkProvider({ planUsage: oldUsage(), planUsageRefresh: { availableAt: null }, ...over });

/** The server's answer to a read: new usage (or the old, for a failed read) and the claimed cooldown. */
const answers =
  (ok: boolean, message?: string, usage: PlanUsageDto | null = newUsage()) =>
  (p: ProviderDto): PlanUsageRefreshResultDto => ({
    ok,
    ...(message === undefined ? {} : { message }),
    provider: {
      ...p,
      planUsage: ok ? usage : (p.planUsage ?? null),
      planUsageRefresh: { availableAt: iso(Date.now() + COOLDOWN) },
    },
  });

const button = (h: Harness): HTMLButtonElement =>
  h.host.querySelector<HTMLButtonElement>('[data-usage] button')!;
const status = (h: Harness): HTMLElement | null =>
  h.host.querySelector<HTMLElement>('[data-usage-refresh-status]');
const failure = (h: Harness): HTMLElement | null =>
  h.host.querySelector<HTMLElement>('[data-usage-refresh-failure]');
const press = async (h: Harness): Promise<void> => {
  button(h).click();
  await flush();
};
const described = (h: Harness): string =>
  (button(h).getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => h.host.querySelector(`[id="${id}"]`)?.textContent ?? `MISSING ${id}`)
    .join(' | ');

describe('the button is offered only where an endpoint exists', () => {
  it('is absent for planUsageRefresh = null, disabled or otherwise', async () => {
    const h = await mount(mkProvider({ planUsage: oldUsage(), planUsageRefresh: null }));
    expect(refreshButton(h)).toBeUndefined();
    expect(h.host.textContent).not.toMatch(/Refresh usage|Refreshing/);
    expect(h.host.querySelector('[data-usage-refresh-status]')).toBeNull();
  });

  it('is offered, at rest, as a ghost button when a refresh is allowed now', async () => {
    const h = await mount(offered());
    expect(refreshButton(h)).toBeDefined();
    expect(button(h).className).toBe('btn-ghost');
    expect(button(h).disabled).toBe(false);
    expect(button(h).getAttribute('aria-busy')).toBeNull();
    expect(h.host.textContent).not.toMatch(/next refresh/);
  });

  it('is offered with no line at all for a provider with no usage yet', async () => {
    const h = await mount(offered({ planUsage: null }));
    expect(usageLine(h)).toBeNull();
    expect(refreshButton(h)).toBeDefined();
  });

  it('describes itself as a read of the usage endpoint that makes no model call', async () => {
    const h = await mount(offered());
    const words = described(h);
    expect(words).toMatch(/usage endpoint/);
    expect(words).toMatch(/no model call/i);
    // It never claims the read is free of plan usage.
    expect(words).not.toMatch(/free|no cost|quota-free|does not count/i);
  });
});

describe('pressing it', () => {
  it('is busy while the read runs: disabled, aria-busy and the Refreshing… label', async () => {
    const h = await mount(offered());
    let release!: () => void;
    h.fake.planUsageRefreshGate = new Promise<void>((r) => {
      release = r;
    });
    await press(h);
    expect(button(h).disabled).toBe(true);
    expect(button(h).getAttribute('aria-busy')).toBe('true');
    expect(button(h).textContent).toContain('Refreshing…');
    release();
    await flush();
    expect(button(h).getAttribute('aria-busy')).toBeNull();
  });

  it('a second press while it runs starts no second read', async () => {
    const h = await mount(offered());
    let release!: () => void;
    h.fake.planUsageRefreshGate = new Promise<void>((r) => {
      release = r;
    });
    await press(h);
    button(h).click();
    await flush();
    release();
    await flush();
    expect(calls(h.fake, 'refreshPlanUsage')).toEqual([['p1']]);
  });
});

describe('a success', () => {
  it('shows the new windows, disables the button with the next refresh time in text', async () => {
    const h = await mount(offered());
    h.fake.planUsageRefreshResult = answers(true);
    await press(h);
    expect(usageLine(h)?.textContent).toMatch(/^5h 71% · resets .* · weekly 12% · resets /);
    expect(button(h).disabled).toBe(true);
    const end = fmtUntil(iso(T0 + COOLDOWN), T0);
    expect(end).not.toBeNull();
    expect(h.host.textContent).toContain(`next refresh ${String(end)}`);
    // The disabled button names why, through aria-describedby.
    expect(described(h)).toContain(`next refresh ${String(end)}`);
  });

  it('announces itself through a polite status region, with the new as of', async () => {
    const h = await mount(offered());
    h.fake.planUsageRefreshResult = answers(true);
    const region = status(h)!;
    expect(region.getAttribute('role')).toBe('status');
    expect(region.textContent).toBe('');
    await press(h);
    expect(status(h)).toBe(region);
    expect(region.textContent).toBe(`Usage refreshed · as of ${String(fmtAsOf(iso(T0), T0))}`);
    expect(failure(h)).toBeNull();
  });

  it('moves focus to the outcome text, not the page, because the button stays disabled', async () => {
    const h = await mount(offered());
    h.fake.planUsageRefreshResult = answers(true);
    button(h).focus();
    await press(h);
    expect(button(h).disabled).toBe(true);
    expect(document.activeElement).toBe(status(h));
    expect(status(h)?.getAttribute('tabindex')).toBe('-1');
  });

  it('merges in place: no list reload, the same card node, an open disclosure stays open', async () => {
    const buckets = usageOf([
      window5h({ usedPercent: 40 }),
      window5h({
        key: 'model:sonic',
        group: 'model',
        scope: 'sonic',
        usedPercent: 80,
      }),
    ]);
    const h = await mount(offered({ planUsage: buckets }));
    const card = h.host.querySelector('.panel.card');
    const details = h.host.querySelector<HTMLDetailsElement>('details[data-usage-buckets]')!;
    details.open = true;
    const loads = calls(h.fake, 'listProviders').length;
    h.fake.planUsageRefreshResult = answers(
      true,
      undefined,
      usageOf([
        window5h({ usedPercent: 71, observedAt: iso(T0) }),
        window5h({ key: 'model:sonic', group: 'model', scope: 'sonic', usedPercent: 90 }),
      ]),
    );
    await press(h);
    expect(calls(h.fake, 'listProviders')).toHaveLength(loads);
    expect(h.host.querySelector('.panel.card')).toBe(card);
    expect(card?.isConnected).toBe(true);
    const after = h.host.querySelector<HTMLDetailsElement>('details[data-usage-buckets]')!;
    expect(after).toBe(details);
    expect(after.open).toBe(true);
    expect(after.textContent).toContain('sonic 90%');
    expect(usageLine(h)?.textContent).toMatch(/^5h 71%/);
  });
});

describe('the cooldown', () => {
  it('re-enables the button at availableAt with no reload, and removes its text', async () => {
    const h = await mount(offered({ planUsageRefresh: { availableAt: iso(T0 + COOLDOWN) } }));
    expect(button(h).disabled).toBe(true);
    expect(h.host.textContent).toMatch(/next refresh /);
    const loads = calls(h.fake, 'listProviders').length;
    await vi.advanceTimersByTimeAsync(COOLDOWN - 1_000);
    expect(button(h).disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000 + 50);
    expect(button(h).disabled).toBe(false);
    expect(h.host.textContent).not.toMatch(/next refresh /);
    expect(calls(h.fake, 'listProviders')).toHaveLength(loads);
    expect(described(h)).not.toMatch(/next refresh/);
  });

  it('a press after the cooldown works again', async () => {
    const h = await mount(offered({ planUsageRefresh: { availableAt: iso(T0 + COOLDOWN) } }));
    await vi.advanceTimersByTimeAsync(COOLDOWN + 50);
    await press(h);
    expect(calls(h.fake, 'refreshPlanUsage')).toEqual([['p1']]);
  });
});

describe('a failure is reported next to the action', () => {
  it('a read that failed answers ok:false: the text says why, the line keeps its values', async () => {
    const h = await mount(offered());
    const before = usageLine(h)?.textContent;
    h.fake.planUsageRefreshResult = answers(false, 'The usage endpoint is unavailable.');
    await press(h);
    expect(usageLine(h)?.textContent).toBe(before);
    expect(usageLine(h)?.textContent).toMatch(/^5h 40%/);
    // A failed refresh never turns the line into a "stale" caption or paints it amber.
    expect(usageLine(h)?.textContent).not.toMatch(/stale/i);
    expect(usageLine(h)?.getAttribute('style') ?? '').not.toMatch(/--amber/);
    expect(failure(h)?.textContent).toBe(
      'Couldn’t refresh usage. The usage endpoint is unavailable.',
    );
    expect(failure(h)?.getAttribute('role')).toBe('alert');
    expect(status(h)?.textContent).toBe('');
    // The server claimed the cooldown even for a failed read, and the button says so.
    expect(button(h).disabled).toBe(true);
    expect(h.host.textContent).toMatch(/next refresh /);
  });

  it('moves focus to the alert text', async () => {
    const h = await mount(offered());
    h.fake.planUsageRefreshResult = answers(false, 'The usage endpoint is unavailable.');
    button(h).focus();
    await press(h);
    expect(document.activeElement).toBe(failure(h));
    expect(failure(h)?.getAttribute('tabindex')).toBe('-1');
  });

  it('a 503 leaves the button at rest, says the store is unreachable, and keeps the line', async () => {
    const h = await mount(offered());
    h.fake.planUsageRefreshRejects = new ApiError(503, 'Service Unavailable', 'store');
    await press(h);
    expect(failure(h)?.textContent).toMatch(/^Couldn’t refresh usage\. .*could not be reached/);
    expect(failure(h)?.getAttribute('role')).toBe('alert');
    expect(button(h).disabled).toBe(false);
    expect(usageLine(h)?.textContent).toMatch(/^5h 40%/);
    expect(document.activeElement).toBe(failure(h));
  });

  it('a 429 reloads the list once to learn the cooldown, and states it', async () => {
    const h = await mount(offered());
    const loads = calls(h.fake, 'listProviders').length;
    h.fake.providers = h.fake.providers.map((p) => ({
      ...p,
      planUsageRefresh: { availableAt: iso(Date.now() + COOLDOWN) },
    }));
    h.fake.planUsageRefreshRejects = new ApiError(429, 'Too Many Requests', 'cooling down');
    await press(h);
    expect(calls(h.fake, 'listProviders')).toHaveLength(loads + 1);
    expect(failure(h)?.textContent).toMatch(/refreshed a moment ago/);
    expect(button(h).disabled).toBe(true);
    expect(h.host.textContent).toMatch(/next refresh /);
  });

  it('a request that fails outright is reported in the same place', async () => {
    const h = await mount(offered());
    h.fake.planUsageRefreshRejects = new ApiError(500, 'Server Error', 'boom');
    await press(h);
    expect(failure(h)?.textContent).toMatch(/^Couldn’t refresh usage\./);
    expect(button(h).disabled).toBe(false);
  });

  it('the next press clears the last outcome', async () => {
    const h = await mount(offered());
    h.fake.planUsageRefreshRejects = new ApiError(503, 'Service Unavailable', 'store');
    await press(h);
    expect(failure(h)).not.toBeNull();
    h.fake.planUsageRefreshResult = answers(true);
    await press(h);
    expect(failure(h)).toBeNull();
    expect(status(h)?.textContent).toMatch(/^Usage refreshed/);
  });
});
