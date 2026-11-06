/**
 * Toasts: two always-mounted regions, a kind, and pausable timers (adopt-design-tokens-v2
 * task 10.2, design.md D13; dashboard-core "Toasts are announced without stealing focus",
 * "A toast gives its reader time" and "A failure still reported by toast is an alert").
 *
 * The real App is mounted on a fake client with fake timers. Both regions are in the document
 * before any message — a live region inserted together with its text is not reliably
 * announced. A confirmation lands in the polite `status` region and clears at 4000ms; a
 * failure that is still a toast lands in the `alert` region and clears at 8000ms. Either
 * timer pauses while the pointer rests on the bar or focus is inside it, and resumes with the
 * time it had left. The failures named by D13 — the clipboard write, a failed delete, a failed
 * sync, the connection and channel tests' failure halves — are walked into the alert region.
 * Neither kind cuts the other short: a toast of the other kind waits for the showing one's
 * time, as the scenario's "a confirmation, and later a clipboard failure" requires.
 */
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ApiError, type ProviderDto } from './data/api';
import { createAppStore, TOAST_MS, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { DEFAULT_SESSION, FakeApiClient, UNRECORDED_HEALTH } from './test/fakeClient';
import type { Agent } from './types';

const NOW = '2026-11-01T12:00:00.000Z';
const AGENT: Agent = {
  id: 'a1',
  name: 'claude-code',
  harness: 'curl',
  prefix: 'poly_abcd',
  lastUsedAt: null,
  createdAt: NOW,
};
const PROVIDER: ProviderDto = {
  id: 'p1',
  name: 'homelab-vllm',
  kind: 'custom',
  protocol: 'openai_compatible',
  baseUrl: 'https://1.1.1.1/v1',
  status: 'ok',
  maxTokensSpelling: 'auto',
  hasCredential: true,
  oauthPreset: null,
  credentialExpiresAt: null,
  credentialError: null,
  firstByteTimeoutMs: null,
  idleTimeoutMs: null,
  createdAt: NOW,
  ...UNRECORDED_HEALTH,
};

let dispose: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Let the fake client's promises and the store's continuations run, without moving the
 * clock: every toast timer stays where it is. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(0);
}

interface Harness {
  store: AppStore;
  fake: FakeApiClient;
  host: HTMLElement;
}

async function mount(fake = new FakeApiClient({ session: DEFAULT_SESSION })): Promise<Harness> {
  const store = createAppStore(fake);
  const host = document.createElement('div');
  document.body.appendChild(host);
  dispose = render(
    () => (
      <AppProvider store={store}>
        <App live={false} />
      </AppProvider>
    ),
    host,
  );
  await settle();
  expect(host.querySelector('[data-shell="true"]'), 'the shell is mounted').not.toBeNull();
  return { store, fake, host };
}

function region(h: Harness, kind: 'confirm' | 'failure'): HTMLElement {
  const el = h.host.querySelector<HTMLElement>(`[data-toast-region="${kind}"]`);
  expect(el, `the ${kind} region is mounted`).not.toBeNull();
  return el!;
}
/** The text each region holds, as a reader of either would hear it. */
function heard(h: Harness): { confirm: string; failure: string } {
  return {
    confirm: region(h, 'confirm').textContent ?? '',
    failure: region(h, 'failure').textContent ?? '',
  };
}
function bar(h: Harness): HTMLElement {
  const el = h.host.querySelector<HTMLElement>('.toast');
  expect(el, 'a toast bar is showing').not.toBeNull();
  return el!;
}

describe('the two toast regions are mounted before any message (D13)', () => {
  it('a polite status region and an alert region, both empty, before anything is said', async () => {
    const h = await mount();
    const confirm = region(h, 'confirm');
    const failure = region(h, 'failure');
    expect(confirm.getAttribute('role')).toBe('status');
    expect(confirm.getAttribute('aria-live')).toBe('polite');
    expect(failure.getAttribute('role')).toBe('alert');
    expect(heard(h)).toEqual({ confirm: '', failure: '' });
    expect(h.host.querySelector('.toast'), 'no bar is drawn while nothing is said').toBeNull();

    // The same nodes take the message: the regions are not re-inserted with it.
    h.store.say('Agent created');
    await settle();
    expect(region(h, 'confirm')).toBe(confirm);
    expect(confirm.textContent).toBe('Agent created');
    h.store.sayFailure('Copy failed — select the text manually');
    await settle();
    // The failure waits for the confirmation's time, then lands in the region already there.
    await vi.advanceTimersByTimeAsync(TOAST_MS.confirm);
    expect(region(h, 'failure')).toBe(failure);
    expect(heard(h)).toEqual({ confirm: '', failure: 'Copy failed — select the text manually' });
  });
});

describe('a toast gives its reader time (D13)', () => {
  it('the kinds stay 4000ms and 8000ms', () => {
    expect(TOAST_MS).toEqual({ confirm: 4000, failure: 8000 });
  });

  it('a confirmation clears at 4000ms, and its region stays mounted', async () => {
    const h = await mount();
    h.store.say('Agent created');
    await settle();
    expect(heard(h).confirm).toBe('Agent created');
    await vi.advanceTimersByTimeAsync(3999);
    expect(heard(h).confirm, 'still showing at 3999ms').toBe('Agent created');
    await vi.advanceTimersByTimeAsync(1);
    expect(heard(h).confirm, 'cleared at 4000ms').toBe('');
    expect(h.store.state.toast).toBeNull();
    expect(region(h, 'confirm').isConnected).toBe(true);
  });

  it('a confirmation does not clear while the pointer rests on it, and resumes with the time it had left', async () => {
    const h = await mount();
    h.store.say('Agent created');
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    bar(h).dispatchEvent(new Event('pointerenter'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(heard(h).confirm, 'held while hovered').toBe('Agent created');
    bar(h).dispatchEvent(new Event('pointerleave'));
    await vi.advanceTimersByTimeAsync(2999);
    expect(heard(h).confirm, '3000ms were left; 2999 have run').toBe('Agent created');
    await vi.advanceTimersByTimeAsync(1);
    expect(heard(h).confirm).toBe('');
  });

  it('a confirmation does not clear while focus is inside it', async () => {
    const h = await mount();
    h.store.say('Agent created');
    await settle();
    bar(h).dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(heard(h).confirm, 'held while focused').toBe('Agent created');
    bar(h).dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    await vi.advanceTimersByTimeAsync(3999);
    expect(heard(h).confirm).toBe('Agent created');
    await vi.advanceTimersByTimeAsync(1);
    expect(heard(h).confirm).toBe('');
  });

  it('the clipboard failure lands in the alert region and clears at 8000ms', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(() => Promise.reject(new Error('denied'))) },
    });
    const h = await mount();
    h.store.copy('poly_secret');
    await settle();
    expect(heard(h)).toEqual({ confirm: '', failure: 'Copy failed — select the text manually' });
    expect(h.store.state.toast?.kind).toBe('failure');
    await vi.advanceTimersByTimeAsync(7999);
    expect(heard(h).failure, 'still showing at 7999ms').toBe(
      'Copy failed — select the text manually',
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(heard(h).failure, 'cleared at 8000ms').toBe('');
  });

  it('a confirmation, then a clipboard failure: the confirmation stays 4000ms and the failure 8000ms', async () => {
    // dashboard-core "A toast gives its reader time", as written: WHEN a confirmation toast is
    // shown, and later a clipboard write fails, THEN the confirmation stays for 4 seconds and the
    // failure for 8. The failure waits for the confirmation's time, then runs its own.
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(() => Promise.reject(new Error('denied'))) },
    });
    const h = await mount();
    h.store.say('Agent created');
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    h.store.copy('poly_secret');
    await settle();
    expect(heard(h), 'the confirmation is not cut short').toEqual({
      confirm: 'Agent created',
      failure: '',
    });
    await vi.advanceTimersByTimeAsync(2999);
    expect(heard(h).confirm, 'still showing at 3999ms').toBe('Agent created');
    await vi.advanceTimersByTimeAsync(1);
    expect(heard(h), 'at 4000ms the confirmation clears and the failure lands').toEqual({
      confirm: '',
      failure: 'Copy failed — select the text manually',
    });
    await vi.advanceTimersByTimeAsync(7999);
    expect(heard(h).failure, 'the failure has its own 8000ms').toBe(
      'Copy failed — select the text manually',
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(heard(h)).toEqual({ confirm: '', failure: '' });
    expect(h.store.state.toast).toBeNull();
  });

  it('a failure, then a confirmation: the failure keeps its 8000ms, then the confirmation its 4000ms', async () => {
    const h = await mount();
    h.store.sayFailure('Sync failed — upstream 502');
    await settle();
    await vi.advanceTimersByTimeAsync(3000);
    h.store.say('Agent created');
    await settle();
    expect(heard(h)).toEqual({ confirm: '', failure: 'Sync failed — upstream 502' });
    await vi.advanceTimersByTimeAsync(4999);
    expect(heard(h).failure, 'still showing at 7999ms').toBe('Sync failed — upstream 502');
    await vi.advanceTimersByTimeAsync(1);
    expect(heard(h)).toEqual({ confirm: 'Agent created', failure: '' });
    await vi.advanceTimersByTimeAsync(3999);
    expect(heard(h).confirm).toBe('Agent created');
    await vi.advanceTimersByTimeAsync(1);
    expect(heard(h)).toEqual({ confirm: '', failure: '' });
  });

  it('a waiting toast waits while the showing one is held, then runs its own full time', async () => {
    // The wait is pause-aware: a reader resting on the confirmation keeps it, and the failure
    // behind it starts only when the confirmation's remaining time has run.
    const h = await mount();
    h.store.say('Agent created');
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    bar(h).dispatchEvent(new Event('pointerenter'));
    h.store.sayFailure('Sync failed — upstream 502');
    await settle();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(heard(h), 'held: the failure still waits').toEqual({
      confirm: 'Agent created',
      failure: '',
    });
    bar(h).dispatchEvent(new Event('pointerleave'));
    await vi.advanceTimersByTimeAsync(2999);
    expect(heard(h).confirm, '3000ms were left; 2999 have run').toBe('Agent created');
    await vi.advanceTimersByTimeAsync(1);
    expect(heard(h)).toEqual({ confirm: '', failure: 'Sync failed — upstream 502' });
    await vi.advanceTimersByTimeAsync(7999);
    expect(heard(h).failure).toBe('Sync failed — upstream 502');
    await vi.advanceTimersByTimeAsync(1);
    expect(heard(h).failure).toBe('');
  });

  it('a later toast of the same kind takes its region; the same message again re-arms it', async () => {
    const h = await mount();
    h.store.say('Agent created');
    await settle();
    await vi.advanceTimersByTimeAsync(2000);
    h.store.say('Key copied');
    await settle();
    expect(heard(h).confirm, 'the region holds its latest message').toBe('Key copied');
    await vi.advanceTimersByTimeAsync(3000);
    h.store.say('Key copied');
    await settle();
    await vi.advanceTimersByTimeAsync(3999);
    expect(heard(h).confirm, 'the repeat re-armed the full 4000ms').toBe('Key copied');
    await vi.advanceTimersByTimeAsync(1);
    expect(heard(h).confirm).toBe('');
  });

  it('clearing the toast drops one that was waiting', async () => {
    const h = await mount();
    h.store.say('Agent created');
    h.store.sayFailure('Sync failed — upstream 502');
    await settle();
    h.store.clearToast();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(heard(h)).toEqual({ confirm: '', failure: '' });
  });
});

describe('a failure still reported by toast is an alert (D13)', () => {
  const failing = (): FakeApiClient =>
    new FakeApiClient({ session: DEFAULT_SESSION, agents: [AGENT], providers: [PROVIDER] });

  it('a failed agent delete lands in the alert region', async () => {
    const fake = failing();
    fake.deleteAgent = () => Promise.reject(new ApiError(500, 'internal', 'agent store down'));
    const h = await mount(fake);
    void h.store.deleteAgent(AGENT);
    await settle();
    expect(heard(h)).toEqual({ confirm: '', failure: 'agent store down' });
    await vi.advanceTimersByTimeAsync(TOAST_MS.confirm);
    expect(heard(h).failure, 'a failure outlives the confirmation timer').toBe('agent store down');
  });

  it('a failed sync lands in the alert region, whether reported or thrown', async () => {
    const reported = failing();
    reported.syncResult = {
      ok: false,
      status: 'error',
      message: 'upstream 502',
      traceId: 't1',
    };
    const a = await mount(reported);
    void a.store.syncProvider(PROVIDER.id);
    await settle();
    expect(heard(a)).toEqual({ confirm: '', failure: 'Sync failed — upstream 502' });
    dispose?.();
    document.body.innerHTML = '';

    const thrown = failing();
    thrown.syncModels = () => Promise.reject(new ApiError(503, 'unavailable', 'sync refused'));
    const b = await mount(thrown);
    void b.store.syncProvider(PROVIDER.id);
    await settle();
    expect(heard(b)).toEqual({ confirm: '', failure: 'sync refused' });
  });

  it('a connection test splits: success confirms, failure alerts', async () => {
    const fake = failing();
    fake.testResult = { ok: true, status: 'ok', message: 'ok', traceId: 't1' };
    const h = await mount(fake);
    void h.store.testProviderById(PROVIDER.id);
    await settle();
    expect(heard(h)).toEqual({ confirm: 'Connection ok', failure: '' });
    fake.testResult = { ok: false, status: 'error', message: '401 from upstream', traceId: 't2' };
    void h.store.testProviderById(PROVIDER.id);
    await settle();
    // The failure waits out the confirmation's time, then lands in the alert region.
    await vi.advanceTimersByTimeAsync(TOAST_MS.confirm);
    expect(heard(h)).toEqual({ confirm: '', failure: 'Connection failed — 401 from upstream' });
  });

  it('a channel test splits: success confirms, failure alerts', async () => {
    const fake = new FakeApiClient({
      session: DEFAULT_SESSION,
      channels: [
        {
          id: 'c1',
          name: 'homelab email',
          kind: 'smtp',
          enabled: true,
          eventsSubscribed: ['budget_alert'],
          hasConfig: true,
          lastTestAt: null,
          lastTestStatus: null,
        },
      ],
    });
    const h = await mount(fake);
    void h.store.testChannelById('c1');
    await settle();
    expect(heard(h)).toEqual({ confirm: 'Test sent', failure: '' });
    fake.channelTestResult = { ok: false, error: 'smtp refused' };
    void h.store.testChannelById('c1');
    await settle();
    await vi.advanceTimersByTimeAsync(TOAST_MS.confirm);
    expect(heard(h)).toEqual({ confirm: '', failure: 'Test failed — smtp refused' });
  });
});
