/**
 * The real App on a fake client, mounted on the Providers page with ONE provider, for the plan-usage
 * view tests (add-subscription-quota-display tasks 7.2 and 7.3). Fake timers drive the clock, so
 * `flush` advances them instead of waiting on them. `src/test/` keeps it out of the `.test.` files, so
 * both suites import it without one registering the other's tests.
 */
import { render } from 'solid-js/web';
import { vi } from 'vitest';
import { App } from '../App';
import type { PlanUsageDto, PlanUsageWindowDto, ProviderDto } from '../data/api';
import { createAppStore, type AppStore } from '../state/appState';
import { AppProvider } from '../state/context';
import { DEFAULT_SESSION, FakeApiClient, UNRECORDED_HEALTH } from './fakeClient';
import { labelText } from './labelText';

/** 2026-11-06 12:00 UTC. */
export const T0 = Date.parse('2026-11-06T12:00:00.000Z');
export const iso = (ms: number): string => new Date(ms).toISOString();

export const window5h = (over: Partial<PlanUsageWindowDto> = {}): PlanUsageWindowDto => ({
  key: 'account:5h',
  group: 'account',
  span: '5h',
  minutes: 300,
  scope: null,
  usedPercent: 62,
  resetAt: iso(T0 + 2 * 3_600_000),
  observedAt: iso(T0 - 5 * 60_000),
  source: 'traffic',
  ...over,
});

export const windowWeekly = (over: Partial<PlanUsageWindowDto> = {}): PlanUsageWindowDto => ({
  key: 'account:weekly',
  group: 'account',
  span: 'weekly',
  minutes: 10080,
  scope: null,
  usedPercent: 31,
  resetAt: iso(T0 + 3 * 86_400_000),
  observedAt: iso(T0 - 5 * 60_000),
  source: 'traffic',
  ...over,
});

export const usageOf = (
  windows: PlanUsageWindowDto[],
  billing: PlanUsageDto['billing'] = null,
): PlanUsageDto => ({ windows, billing });

/** A Kimi Code key-plan provider: it has a usage endpoint, so its card offers Refresh usage. */
export const mkProvider = (over: Partial<ProviderDto> = {}): ProviderDto =>
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
    planUsage: null,
    planUsageRefresh: null,
    ...over,
  }) satisfies ProviderDto;

const disposers: (() => void)[] = [];

export const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(0);
};

export interface Harness {
  host: HTMLElement;
  store: AppStore;
  fake: FakeApiClient;
}

/** `setup` runs on the fake before the App mounts, so a test can seed what the card reads on its
 * own mount (the usage history, a gate, a rejection). */
export async function mount(
  provider: ProviderDto,
  setup?: (fake: FakeApiClient) => void,
): Promise<Harness> {
  globalThis.history.replaceState(null, '', '/#/providers');
  const fake = new FakeApiClient({ session: DEFAULT_SESSION, providers: [provider] });
  setup?.(fake);
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

export function useFakeClock(): void {
  vi.useFakeTimers({ now: T0, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
}

export function unmountAll(): void {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.innerHTML = '';
  vi.useRealTimers();
}

export const usageLine = (h: Harness): HTMLElement | null =>
  h.host.querySelector<HTMLElement>('[data-usage-line]');
export const buttonNamed = (root: ParentNode, name: string): HTMLButtonElement | undefined =>
  [...root.querySelectorAll('button')].find((b) => labelText(b) === name);
export const refreshButton = (h: Harness): HTMLButtonElement | undefined =>
  buttonNamed(h.host, 'Refresh usage');
export const calls = (fake: FakeApiClient, method: string): unknown[][] =>
  fake.callLog.filter((c) => c.method === method).map((c) => c.args);
