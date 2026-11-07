/**
 * A provider paused by a plan cooldown says so, and can be resumed (classify-plan-quota-errors
 * task 9.3; dashboard-core "A provider paused by a plan cooldown says so in its status line and
 * can be resumed").
 *
 * The real App on a fake client. The status line is the card's ONE line, in words and amber, never
 * "Healthy" and never red; Resume now is a Secondary button; a risk-control pause asks first in the
 * consent confirmation (Primary commit, never Red Fill, busy and failure in the dialog); a pause
 * ends at its own instant through one timer, with no list reload; a failed resume is reported in
 * place and the pause stays. Assertions that name arguments read `callLog`, never `fake.calls`.
 */
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ApiError, type PlanCooldownDto, type ProviderDto } from './data/api';
import { fmtUntil } from './data/format';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { DEFAULT_SESSION, FakeApiClient, UNRECORDED_HEALTH } from './test/fakeClient';
import { labelText } from './test/labelText';

const T0 = Date.parse('2026-11-06T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

const mkProvider = (planCooldown: PlanCooldownDto | null, over: Partial<ProviderDto> = {}) =>
  ({
    id: 'p1',
    name: 'Kimi Code',
    kind: 'subscription',
    protocol: 'openai_compatible',
    baseUrl: 'https://api.kimi.com/coding/v1',
    status: 'ok',
    maxTokensSpelling: 'auto',
    hasCredential: true,
    oauthPreset: null,
    keyPreset: 'kimi-code',
    credentialExpiresAt: null,
    credentialError: null,
    firstByteTimeoutMs: null,
    idleTimeoutMs: null,
    autoPruneUnlisted: true,
    createdAt: iso(T0),
    ...UNRECORDED_HEALTH,
    health: { state: 'ok', kind: null, message: null, source: 'test', at: iso(T0 - 5 * 60_000) },
    ...over,
    planCooldown,
  }) satisfies ProviderDto;

const pause = (over: Partial<PlanCooldownDto> = {}): PlanCooldownDto => ({
  kind: 'quota_exhausted',
  until: iso(T0 + 6 * 3_600_000),
  untilSource: 'provider',
  ...over,
});

const disposers: (() => void)[] = [];

// Fake timers drive the clock, so the settle loop advances them instead of waiting on them.
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(0);
};

interface Harness {
  host: HTMLElement;
  store: AppStore;
  fake: FakeApiClient;
}

async function mount(provider: ProviderDto): Promise<Harness> {
  globalThis.history.replaceState(null, '', '/#/providers');
  const fake = new FakeApiClient({ session: DEFAULT_SESSION, providers: [provider] });
  const store = createAppStore(fake);
  const host = document.createElement('div');
  document.body.appendChild(host);
  disposers.push(
    render(
      () => (
        <AppProvider store={store}>
          <App live={false} />
        </AppProvider>
      ),
      host,
    ),
  );
  await flush();
  return { host, store, fake };
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

const line = (h: Harness): HTMLElement | null =>
  h.host.querySelector<HTMLElement>('[data-health-line]');
const buttonNamed = (root: ParentNode, name: string): HTMLButtonElement | undefined =>
  [...root.querySelectorAll('button')].find((b) => labelText(b) === name);
const resumeNow = (h: Harness): HTMLButtonElement | undefined => buttonNamed(h.host, 'Resume now');
const dialog = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="dialog"][aria-label^="Resume "]');
const calls = (fake: FakeApiClient, method: string): unknown[][] =>
  fake.callLog.filter((c) => c.method === method).map((c) => c.args);
const escape = (): void => {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
};

describe('the status line states the pause', () => {
  it('a quota pause reads as a pause, in amber, with the provider’s reset time', async () => {
    const until = iso(T0 + 6 * 3_600_000);
    const h = await mount(mkProvider(pause({ until })));
    const end = fmtUntil(until, T0);
    expect(end).not.toBeNull();
    const el = line(h)!;
    expect(el.textContent).toBe(`Plan usage limit reached — resets at ${String(end)}`);
    expect(el.textContent).not.toMatch(/Healthy|just now|ago/);
    expect(el.getAttribute('style')).toContain('var(--amber-text)');
    expect(el.getAttribute('style')).not.toMatch(/--red/);
    // The card states the pause once: no second status line, and no "Healthy" anywhere on it.
    expect(h.host.querySelectorAll('[data-health-line]')).toHaveLength(1);
    expect(h.host.textContent).not.toMatch(/Healthy/);
    expect(resumeNow(h)).toBeDefined();
  });

  it('a polyrouter-chosen end says when polyrouter retries, never presenting it as the reset', async () => {
    const h = await mount(mkProvider(pause({ untilSource: 'default' })));
    expect(line(h)!.textContent).toMatch(/ — polyrouter retries at /);
    expect(line(h)!.textContent).not.toMatch(/resets/);
  });

  it.each([
    ['risk_control', /Provider throttled the account \(fair-use policy\)/],
    ['plan_inactive', /No active plan for this key \(expired, or not a plan key\)/],
  ] as const)('a %s pause is named in words', async (kind, words) => {
    const h = await mount(mkProvider(pause({ kind })));
    expect(line(h)!.textContent).toMatch(words);
    expect(line(h)!.getAttribute('style')).toContain('var(--amber-text)');
  });

  it('Resume now is the Secondary button, not the ghost or the Red Fill', async () => {
    const h = await mount(mkProvider(pause()));
    const b = resumeNow(h)!;
    expect(b.classList.contains('btn-cancel')).toBe(true);
    expect(b.classList.contains('btn-destructive')).toBe(false);
    expect(b.classList.contains('btn-ghost')).toBe(false);
  });

  it('a card with no pause shows no Resume now', async () => {
    const h = await mount(mkProvider(null));
    expect(resumeNow(h)).toBeUndefined();
    expect(line(h)!.textContent).toMatch(/^Healthy/);
  });
});

describe('Resume now on a quota or inactive pause lifts it at once', () => {
  it.each(['quota_exhausted', 'plan_inactive'] as const)(
    'a %s pause lifts with no dialog, then the list reloads and the line returns to health',
    async (kind) => {
      const h = await mount(mkProvider(pause({ kind })));
      const listed = calls(h.fake, 'listProviders').length;
      resumeNow(h)!.click();
      await flush();
      expect(dialog()).toBeNull();
      expect(calls(h.fake, 'liftPlanCooldown')).toEqual([['p1']]);
      expect(calls(h.fake, 'listProviders').length).toBe(listed + 1);
      expect(line(h)!.textContent).toMatch(/^Healthy/);
      expect(resumeNow(h)).toBeUndefined();
    },
  );

  it('a failed lift is reported next to the action and the pause line stays', async () => {
    const h = await mount(mkProvider(pause()));
    const before = line(h)!.textContent;
    h.fake.liftPlanCooldownRejects = new ApiError(503, 'Service Unavailable', 'store down');
    resumeNow(h)!.click();
    await flush();
    const alert = h.host.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toMatch(/Couldn’t reach the shared pause store/);
    expect(line(h)!.textContent).toBe(before);
    // The action left its busy state and can be tried again.
    const b = resumeNow(h)!;
    expect(b.disabled).toBe(false);
    expect(b.hasAttribute('aria-busy')).toBe(false);
    b.click();
    await flush();
    expect(calls(h.fake, 'liftPlanCooldown')).toHaveLength(2);
    expect(line(h)!.textContent).toMatch(/^Healthy/);
  });

  it('a 404 reports the server’s own reason in place', async () => {
    const h = await mount(mkProvider(pause()));
    h.fake.liftPlanCooldownRejects = new ApiError(404, 'Not Found', 'provider not found');
    resumeNow(h)!.click();
    await flush();
    expect(h.host.querySelector('[role="alert"]')?.textContent).toBe('provider not found');
  });
});

describe('a risk-control pause asks first, in the consent confirmation', () => {
  const open = async (): Promise<Harness> => {
    const h = await mount(mkProvider(pause({ kind: 'risk_control' })));
    resumeNow(h)!.click();
    await flush();
    return h;
  };

  it('opens a consent dialog and lifts nothing yet', async () => {
    const h = await open();
    const d = dialog()!;
    expect(d).not.toBeNull();
    expect(d.getAttribute('aria-label')).toBe('Resume Kimi Code?');
    expect(calls(h.fake, 'liftPlanCooldown')).toEqual([]);
    expect(d.textContent).toMatch(/throttled this account under its own risk-control policy/);
    expect(d.textContent).toMatch(/restrict the account further/);
  });

  it('the warning is the dialog description, and focus lands on the Primary commit', async () => {
    await open();
    const d = dialog()!;
    const describedBy = d.getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)?.textContent).toMatch(/restrict the account/);
    const commit = buttonNamed(d, 'Resume provider')!;
    expect(document.activeElement).toBe(commit);
  });

  it('its commit is the Primary button and never the Red Fill', async () => {
    await open();
    const commit = buttonNamed(dialog()!, 'Resume provider')!;
    expect(commit.classList.contains('btn-primary')).toBe(true);
    expect(commit.classList.contains('btn-destructive')).toBe(false);
    expect(buttonNamed(dialog()!, 'Cancel')?.classList.contains('btn-cancel')).toBe(true);
    // It is not the shared destructive dialog's markup.
    expect(dialog()!.querySelector('.btn-destructive')).toBeNull();
  });

  it('Cancel and Escape change nothing', async () => {
    const h = await open();
    buttonNamed(dialog()!, 'Cancel')!.click();
    await flush();
    expect(dialog()).toBeNull();
    expect(calls(h.fake, 'liftPlanCooldown')).toEqual([]);
    expect(line(h)!.textContent).toMatch(/Provider throttled the account/);

    resumeNow(h)!.click();
    await flush();
    expect(dialog()).not.toBeNull();
    escape();
    await flush();
    expect(dialog()).toBeNull();
    expect(calls(h.fake, 'liftPlanCooldown')).toEqual([]);
  });

  it('the commit lifts the pause, closes the dialog and reloads the list', async () => {
    const h = await open();
    const listed = calls(h.fake, 'listProviders').length;
    buttonNamed(dialog()!, 'Resume provider')!.click();
    await flush();
    expect(calls(h.fake, 'liftPlanCooldown')).toEqual([['p1']]);
    expect(dialog()).toBeNull();
    expect(calls(h.fake, 'listProviders').length).toBe(listed + 1);
    expect(line(h)!.textContent).toMatch(/^Healthy/);
  });

  it('shows a busy state while the request is in flight: both buttons disabled, Escape refused', async () => {
    const h = await open();
    let release!: () => void;
    h.fake.liftPlanCooldownGate = new Promise<void>((r) => {
      release = r;
    });
    buttonNamed(dialog()!, 'Resume provider')!.click();
    await flush();
    const d = dialog()!;
    const commit = [...d.querySelectorAll('button')].find((b) =>
      b.classList.contains('btn-primary'),
    )!;
    expect(commit.disabled).toBe(true);
    expect(commit.getAttribute('aria-busy')).toBe('true');
    expect(labelText(commit)).toBe('Resuming…');
    expect(buttonNamed(d, 'Cancel')!.disabled).toBe(true);
    // Focus stays inside the dialog, not on the body.
    expect(d.contains(document.activeElement)).toBe(true);
    escape();
    await flush();
    expect(dialog()).not.toBeNull();
    // A second activation cannot start a second request.
    commit.click();
    await flush();
    expect(calls(h.fake, 'liftPlanCooldown')).toHaveLength(1);
    release();
    await flush();
    expect(dialog()).toBeNull();
  });

  it('a failing lift keeps the dialog open with the failure text, and a retry can succeed', async () => {
    const h = await open();
    h.fake.liftPlanCooldownRejects = new ApiError(503, 'Service Unavailable', 'store down');
    buttonNamed(dialog()!, 'Resume provider')!.click();
    await flush();
    const d = dialog()!;
    expect(d).not.toBeNull();
    const alert = d.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toMatch(/Resume provider failed/);
    expect(alert?.textContent).toMatch(/Couldn’t reach the shared pause store/);
    // The pause line stays as it was, the buttons are back, and focus is on the commit again.
    expect(line(h)!.textContent).toMatch(/Provider throttled the account/);
    const commit = buttonNamed(d, 'Resume provider')!;
    expect(commit.disabled).toBe(false);
    expect(document.activeElement).toBe(commit);
    commit.click();
    await flush();
    expect(dialog()).toBeNull();
    expect(calls(h.fake, 'liftPlanCooldown')).toHaveLength(2);
    expect(line(h)!.textContent).toMatch(/^Healthy/);
  });
});

describe('a pause ends without a reload', () => {
  it('advancing past the end returns the line to the displayed health, with no list reload', async () => {
    const until = iso(T0 + 10 * 60_000);
    const h = await mount(mkProvider(pause({ until })));
    expect(line(h)!.textContent).toMatch(/Plan usage limit reached/);
    const listed = calls(h.fake, 'listProviders').length;

    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    expect(line(h)!.textContent).toMatch(/Plan usage limit reached/);
    expect(resumeNow(h)).toBeDefined();

    await vi.advanceTimersByTimeAsync(2);
    await flush();
    expect(line(h)!.textContent).toMatch(/^Healthy/);
    expect(resumeNow(h)).toBeUndefined();
    expect(calls(h.fake, 'listProviders').length).toBe(listed);
  });

  it('a pause that moved is re-armed for its new end, and the old timer is gone', async () => {
    const h = await mount(mkProvider(pause({ until: iso(T0 + 10 * 60_000) })));
    // A reload brings a later end (a longer window recorded elsewhere).
    h.fake.providers = [mkProvider(pause({ until: iso(T0 + 60 * 60_000) }))];
    await h.store.loadProviders();
    await flush();
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await flush();
    expect(line(h)!.textContent).toMatch(/Plan usage limit reached/);
    await vi.advanceTimersByTimeAsync(50 * 60_000);
    await flush();
    expect(line(h)!.textContent).toMatch(/^Healthy/);
  });

  it('an already-expired pause from the server shows the displayed health at once', async () => {
    const h = await mount(mkProvider(pause({ until: iso(T0 - 1_000) })));
    expect(line(h)!.textContent).toMatch(/^Healthy/);
    expect(resumeNow(h)).toBeUndefined();
  });

  it('no timer is left pending once the card is gone', async () => {
    await mount(mkProvider(pause({ until: iso(T0 + 10 * 60_000) })));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    for (const dispose of disposers.splice(0)) dispose();
    document.body.innerHTML = '';
    expect(vi.getTimerCount()).toBe(0);
  });
});
