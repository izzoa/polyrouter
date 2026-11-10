/**
 * The provider card's Terms-risk notice can be dismissed once per provider
 * (add-dismissible-terms-risk task 4.2; dashboard-core "A subscription provider's Terms-risk
 * notice can be dismissed once per provider"). The real App on a fake client: the `×` sends one
 * acknowledgment, the answer's provider replaces the stored one, and the card then shows nothing
 * in the notice's place. A failure keeps the notice and toasts; a provider whose acknowledgment
 * is null again (a kind change) shows it again. Reconnect needed, beside it, keeps no dismiss.
 */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { ApiError, type ProviderDto } from './data/api';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { DEFAULT_SESSION, FakeApiClient } from './test/fakeClient';
import { labelText } from './test/labelText';
import { mkProvider } from './test/planUsageHarness';

interface Harness {
  host: HTMLElement;
  store: AppStore;
  fake: FakeApiClient;
}

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
  document.body.innerHTML = '';
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
};

async function mount(providers: ProviderDto[], fake?: FakeApiClient): Promise<Harness> {
  globalThis.history.replaceState(null, '', '/#/providers');
  const client = fake ?? new FakeApiClient({ session: DEFAULT_SESSION, providers });
  const store = createAppStore(client);
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
  store.go('providers');
  await flush();
  return { host, store, fake: client };
}

const CLAUDE = (): ProviderDto =>
  mkProvider({
    id: 'p-claude',
    name: 'Claude',
    protocol: 'anthropic_compatible',
    baseUrl: 'https://api.anthropic.com/',
    oauthPreset: 'claude',
    keyPreset: null,
    termsRiskAcknowledgedAt: null,
  });
const CHATGPT = (): ProviderDto =>
  mkProvider({
    id: 'p-chatgpt',
    name: 'ChatGPT',
    protocol: 'openai_responses',
    baseUrl: 'https://chatgpt.com/',
    oauthPreset: 'chatgpt',
    keyPreset: null,
    termsRiskAcknowledgedAt: null,
  });

/** The card that carries the provider's name. */
function cardOf(h: Harness, name: string): HTMLElement {
  const cards = [...h.host.querySelectorAll<HTMLElement>('.panel.card')].filter((c) =>
    (c.textContent ?? '').includes(name),
  );
  expect(cards, `one card for ${name}`).toHaveLength(1);
  return cards[0]!;
}
function termsNotice(card: HTMLElement): HTMLElement | null {
  return (
    [...card.querySelectorAll<HTMLElement>('.notice')].find(
      (n) => n.querySelector('.notice-title')?.textContent === 'Terms risk',
    ) ?? null
  );
}
const dismissOf = (card: HTMLElement): HTMLButtonElement | null =>
  termsNotice(card)?.querySelector<HTMLButtonElement>('.notice-dismiss') ?? null;
const testButtonOf = (card: HTMLElement): HTMLButtonElement =>
  [...card.querySelectorAll<HTMLButtonElement>('button')].find((b) => labelText(b) === 'Test')!;
const ackCalls = (fake: FakeApiClient): unknown[][] =>
  fake.callLog.filter((c) => c.method === 'acknowledgeTermsRisk').map((c) => c.args);

describe('the Terms-risk notice carries one dismiss, named for its provider', () => {
  it('shows on an unacknowledged subscription card with its action and the labelled ×', async () => {
    const h = await mount([CLAUDE()]);
    const card = cardOf(h, 'Claude');
    const n = termsNotice(card)!;
    expect(n).not.toBeNull();
    expect(n.classList.contains('notice--caution')).toBe(true);
    expect(dismissOf(card)?.getAttribute('aria-label')).toBe('Dismiss terms risk for Claude');
    expect([...n.querySelectorAll('button:not(.notice-dismiss)')].map((b) => labelText(b))).toEqual(
      ['Add a pay-per-token fallback'],
    );
  });

  it('an acknowledged provider shows no Terms-risk notice, text or placeholder', async () => {
    const h = await mount([{ ...CLAUDE(), termsRiskAcknowledgedAt: '2026-11-10T09:00:00.000Z' }]);
    const card = cardOf(h, 'Claude');
    expect(termsNotice(card)).toBeNull();
    expect(card.textContent).not.toMatch(/terms risk/i);
    expect(card.querySelector('.notice-dismiss')).toBeNull();
  });
});

describe('dismissing (add-dismissible-terms-risk task 4.2)', () => {
  it('Dismissing hides the notice on every browser: gone, focus on Test, and still gone on a reload', async () => {
    const h = await mount([CLAUDE()]);
    const card = cardOf(h, 'Claude');
    const x = dismissOf(card)!;
    x.focus();
    x.click();
    await flush();
    expect(ackCalls(h.fake)).toEqual([['p-claude']]);
    expect(termsNotice(card)).toBeNull();
    expect(card.textContent).not.toMatch(/terms risk/i);
    expect(document.activeElement).toBe(testButtonOf(card));
    expect(h.store.state.toast).toBeNull();

    // Another browser: a fresh store on the same server state reads the acknowledgment.
    const other = await mount([], h.fake);
    const fresh = [...other.host.querySelectorAll<HTMLElement>('.panel.card')].find((c) =>
      (c.textContent ?? '').includes('Claude'),
    )!;
    expect(termsNotice(fresh)).toBeNull();
    expect(fresh.textContent).not.toMatch(/terms risk/i);
  });

  it('Each provider is dismissed separately', async () => {
    const h = await mount([CLAUDE(), CHATGPT()]);
    dismissOf(cardOf(h, 'Claude'))!.click();
    await flush();
    expect(termsNotice(cardOf(h, 'Claude'))).toBeNull();
    const other = cardOf(h, 'ChatGPT');
    expect(termsNotice(other)).not.toBeNull();
    expect(dismissOf(other)?.getAttribute('aria-label')).toBe('Dismiss terms risk for ChatGPT');
    expect(ackCalls(h.fake)).toEqual([['p-claude']]);
  });

  it('The dismiss control is busy while the acknowledgment is in flight: one request only', async () => {
    let release: () => void = () => undefined;
    const h = await mount([CLAUDE()]);
    h.fake.acknowledgeTermsRiskGate = new Promise<void>((r) => {
      release = r;
    });
    const card = cardOf(h, 'Claude');
    const x = dismissOf(card)!;
    x.click();
    await flush();
    expect(x.disabled).toBe(true);
    expect(x.getAttribute('aria-busy')).toBe('true');
    x.click();
    await flush();
    expect(ackCalls(h.fake)).toHaveLength(1);
    release();
    await flush();
    expect(termsNotice(card)).toBeNull();
    expect(ackCalls(h.fake)).toHaveLength(1);
  });

  it('A failed dismissal keeps the notice, its control usable again, and says so', async () => {
    const h = await mount([CLAUDE()]);
    h.fake.acknowledgeTermsRiskRejects = new ApiError(503, 'unavailable', 'down');
    const card = cardOf(h, 'Claude');
    const x = dismissOf(card)!;
    x.focus();
    x.click();
    await flush();
    expect(termsNotice(card)).not.toBeNull();
    const again = dismissOf(card)!;
    expect(again.disabled).toBe(false);
    expect(again.hasAttribute('aria-busy')).toBe(false);
    expect(document.activeElement).toBe(again);
    expect(h.store.state.toast).toEqual({
      kind: 'failure',
      text: 'Couldn’t dismiss the terms notice. Try again.',
    });
    expect(h.store.state.providers[0]!.termsRiskAcknowledgedAt).toBeNull();
  });

  it('A provider that becomes a subscription again shows the notice again', async () => {
    const h = await mount([{ ...CLAUDE(), termsRiskAcknowledgedAt: '2026-11-10T09:00:00.000Z' }]);
    expect(termsNotice(cardOf(h, 'Claude'))).toBeNull();
    // The server cleared the acknowledgment on a kind change and back (provider-management D4).
    h.fake.providers = h.fake.providers.map((p) => ({ ...p, termsRiskAcknowledgedAt: null }));
    await h.store.loadProviders();
    await flush();
    const card = cardOf(h, 'Claude');
    expect(termsNotice(card)).not.toBeNull();
    expect(dismissOf(card)).not.toBeNull();
  });

  it('Reconnect needed beside Terms risk on the same card keeps no dismiss', async () => {
    const h = await mount([
      {
        ...CHATGPT(),
        credentialError: 'reauthorize_required',
        health: {
          state: 'reauthorize_required',
          kind: 'credential',
          message: 'credential needs reauthorization',
          source: 'refresh',
          at: new Date().toISOString(),
        },
      },
    ]);
    const card = cardOf(h, 'ChatGPT');
    const reconnect = [...card.querySelectorAll<HTMLElement>('.notice')].find(
      (n) => n.querySelector('.notice-title')?.textContent === 'Reconnect needed',
    )!;
    expect(reconnect).toBeDefined();
    expect(reconnect.querySelector('.notice-dismiss')).toBeNull();
    expect(dismissOf(card)).not.toBeNull();
    expect(card.querySelectorAll('.notice-dismiss')).toHaveLength(1);
  });
});
