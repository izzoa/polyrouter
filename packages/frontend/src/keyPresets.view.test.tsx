/**
 * The key-subscription presets on the dashboard (add-key-subscription-presets, group 9;
 * dashboard-core "Key subscription presets are connected from cards beside the OAuth presets"
 * and "A key-preset provider shows its preset and pinned endpoint wherever it appears").
 *
 * The real App is mounted on the fake client. Every preset here is a FIXTURE in the server's
 * display shape: the shipped registry lists nothing until a region passes its live runbook, so
 * nothing in this file reflects a real provider's enabled state, and no key is a real key.
 */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ApiError, type KeyPresetDto, type ProviderDto } from './data/api';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { DEFAULT_SESSION, FakeApiClient, UNRECORDED_HEALTH } from './test/fakeClient';
import { labelText } from './test/labelText';

const NOW = '2026-11-06T12:00:00.000Z';
const KEY = 'fixture-secret-key-0123456789';

const ZAI: KeyPresetDto = {
  id: 'zai-coding-plan',
  displayName: 'Z.ai GLM Coding Plan',
  regions: [
    { id: 'intl', label: 'International', host: 'api.z.ai', imitationRequired: false },
    { id: 'cn', label: 'China', host: 'open.bigmodel.cn', imitationRequired: false },
  ],
  keyHint: { prefix: null, note: 'Use a Personal Coding Plan key.' },
  termsRisk: 'high',
  riskCopy: 'Z.ai’s terms forbid proxy use.',
  termsUrl: 'https://docs.z.ai/legal-agreement/subscription-terms',
  requiresAcknowledgement: true,
};
const KIMI_ONE_REGION: KeyPresetDto = {
  id: 'kimi-code',
  displayName: 'Kimi Code',
  regions: [{ id: 'intl', label: 'International', host: 'api.kimi.ai', imitationRequired: false }],
  keyHint: { prefix: 'sk-kimi-', note: 'Kimi Code keys start with sk-kimi-.' },
  termsRisk: 'medium',
  riskCopy: 'Kimi Code is meant for interactive use.',
  termsUrl: 'https://www.kimi.com/code/docs/en/kimi-code/community-guidelines.html',
  requiresAcknowledgement: false,
};
const KIMI_IMITATION: KeyPresetDto = {
  ...KIMI_ONE_REGION,
  regions: [{ id: 'intl', label: 'International', host: 'api.kimi.ai', imitationRequired: true }],
  termsRisk: 'high',
  requiresAcknowledgement: true,
};
const OPENCODE: KeyPresetDto = {
  id: 'opencode-go',
  displayName: 'OpenCode Go',
  regions: [{ id: 'default', label: 'OpenCode Go', host: 'opencode.ai', imitationRequired: false }],
  keyHint: null,
  termsRisk: 'low',
  riskCopy: 'OpenCode Go is open to other coding agents.',
  termsUrl: 'https://opencode.ai/v2/docs/console/go/',
  requiresAcknowledgement: false,
};

const mkProvider = (over: Partial<ProviderDto> = {}): ProviderDto => ({
  id: 'p1',
  name: 'Kimi Code',
  kind: 'subscription',
  protocol: 'openai_compatible',
  baseUrl: 'https://api.kimi.ai/coding/v1',
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
  imitateClientIdentity: false,
  clientIdentity: { label: 'Claude Code' },
  createdAt: NOW,
  ...UNRECORDED_HEALTH,
  ...over,
});

const disposers: (() => void)[] = [];

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

interface Harness {
  host: HTMLElement;
  store: AppStore;
  fake: FakeApiClient;
}

async function mount(
  opts: { presets?: KeyPresetDto[]; providers?: ProviderDto[]; oauth?: boolean } = {},
): Promise<Harness> {
  globalThis.history.replaceState(null, '', '/#/providers');
  const fake = new FakeApiClient({ session: DEFAULT_SESSION, providers: opts.providers ?? [] });
  fake.keyPresets = opts.presets ?? [];
  if (opts.oauth === false) fake.oauthPresets = [];
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

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const buttonNamed = (root: ParentNode, name: string): HTMLButtonElement | undefined =>
  [...root.querySelectorAll('button')].find((b) => labelText(b) === name);

const field = <T extends HTMLElement>(h: Harness, id: string): T | null =>
  h.host.querySelector<T>(`#${id}`);

const type = async (el: HTMLInputElement, value: string): Promise<void> => {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
};

const pick = async (el: HTMLSelectElement, value: string): Promise<void> => {
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
};

const tick = async (el: HTMLInputElement, on: boolean): Promise<void> => {
  el.checked = on;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
};

/** Open the new-provider modal on the subscription kind. */
const openConnect = async (h: Harness): Promise<void> => {
  h.store.openModal('newProvider');
  await flush();
  const sub = [...h.host.querySelectorAll<HTMLButtonElement>('.kind-card')].find((b) =>
    (b.textContent ?? '').startsWith('Subscription'),
  );
  sub?.click();
  await flush();
};

const chooseCard = async (h: Harness, id: string): Promise<void> => {
  h.host.querySelector<HTMLButtonElement>(`[data-key-preset="${id}"]`)!.click();
  await flush();
};

const connects = (fake: FakeApiClient): Record<string, unknown>[] =>
  fake.callLog.filter((c) => c.method === 'keyPresetConnect').map((c) => c.args[0] as never);

const patches = (fake: FakeApiClient): Record<string, unknown>[] =>
  fake.callLog
    .filter((c) => c.method === 'updateProvider')
    .map((c) => c.args[1] as Record<string, unknown>);

const escape = (): void => {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
};

const modalText = (h: Harness): string => h.host.querySelector('.modal-card')?.textContent ?? '';

describe('connecting a key preset end to end (Z.ai)', () => {
  it('shows the card, region, key and acknowledgement, and connects through the endpoint', async () => {
    const h = await mount({ presets: [ZAI] });
    await openConnect(h);
    expect(h.host.querySelector('[data-key-preset="zai-coding-plan"]')).not.toBeNull();
    await chooseCard(h, 'zai-coding-plan');

    // No free-text endpoint or protocol: the form replaced those fields.
    expect(field(h, 'f-np-baseurl')).toBeNull();
    expect(field(h, 'f-np-protocol')).toBeNull();
    expect(field(h, 'f-np-credential')).toBeNull();

    const connect = buttonNamed(h.host, 'Connect')!;
    await pick(field<HTMLSelectElement>(h, 'f-kp-region')!, 'intl');
    await type(field<HTMLInputElement>(h, 'f-kp-key')!, KEY);
    // Unavailable until the acknowledgement is ticked.
    expect(connect.disabled).toBe(true);
    const ack = field<HTMLInputElement>(h, 'f-kp-ack')!;
    expect(ack.checked).toBe(false);
    await tick(ack, true);
    expect(connect.disabled).toBe(false);

    connect.click();
    await flush();
    expect(connects(h.fake)).toEqual([
      {
        preset: 'zai-coding-plan',
        region: 'intl',
        credential: KEY,
        acknowledgeTermsRisk: true,
      },
    ]);
    expect(h.store.state.modal).toBeNull();
    expect(h.store.state.providers.some((p) => p.keyPreset === 'zai-coding-plan')).toBe(true);
    expect(h.store.state.toast?.text).toBe(
      'Z.ai GLM Coding Plan connected — sync models to start routing',
    );
  });

  it('cannot be dismissed while the connect is in flight', async () => {
    const h = await mount({ presets: [OPENCODE] });
    await openConnect(h);
    await chooseCard(h, 'opencode-go');
    await type(field<HTMLInputElement>(h, 'f-kp-key')!, KEY);
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const real = h.fake.keyPresetConnect.bind(h.fake);
    vi.spyOn(h.fake, 'keyPresetConnect').mockImplementation(async (body) => {
      await held;
      return real(body);
    });
    const connect = buttonNamed(h.host, 'Connect')!;
    connect.click();
    await flush();
    expect(connect.disabled).toBe(true);
    expect(connect.getAttribute('aria-busy')).toBe('true');
    escape();
    h.store.closeModal();
    await flush();
    expect(h.store.state.modal).toBe('newProvider'); // not dismissed
    release();
    await flush();
    expect(h.store.state.modal).toBeNull();
  });
});

describe('each card states its own terms risk', () => {
  it('names the level and copy in text with a new-tab terms link, beside the generic note', async () => {
    const h = await mount({ presets: [ZAI, OPENCODE] });
    await openConnect(h);
    const zai = h.host.querySelector('[role="group"][aria-label="Z.ai GLM Coding Plan"]')!;
    expect(zai.textContent).toContain('High terms risk.');
    expect(zai.textContent).toContain('Z.ai’s terms forbid proxy use.');
    const link = zai.querySelector<HTMLAnchorElement>('a')!;
    expect(link.href).toBe(ZAI.termsUrl);
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noreferrer');
    expect(link.textContent).toContain('opens in a new tab');
    const og = h.host.querySelector('[role="group"][aria-label="OpenCode Go"]')!;
    expect(og.textContent).toContain('Low terms risk.');
    // The generic flat-rate note still covers the OAuth cards and "Other subscription".
    expect(modalText(h)).toContain('may violate the provider’s ToS');
    expect(modalText(h)).toContain('Other subscription (paste a credential)');
  });

  it('carries no link nested inside a button', async () => {
    const h = await mount({ presets: [ZAI] });
    await openConnect(h);
    expect(h.host.querySelector('button a')).toBeNull();
  });
});

describe('a preset listed with one region', () => {
  it('shows no region choice and connects with that region id', async () => {
    // Its second registry region is disabled, so the list carries only one.
    const h = await mount({ presets: [KIMI_ONE_REGION] });
    await openConnect(h);
    await chooseCard(h, 'kimi-code');
    expect(field(h, 'f-kp-region')).toBeNull();
    await type(field<HTMLInputElement>(h, 'f-kp-key')!, 'sk-kimi-fixture');
    buttonNamed(h.host, 'Connect')!.click();
    await flush();
    expect(connects(h.fake)).toEqual([
      { preset: 'kimi-code', region: 'intl', credential: 'sk-kimi-fixture' },
    ]);
  });

  it('a several-region preset asks for the region, on the field', async () => {
    const h = await mount({ presets: [ZAI] });
    await openConnect(h);
    await chooseCard(h, 'zai-coding-plan');
    await type(field<HTMLInputElement>(h, 'f-kp-key')!, KEY);
    await tick(field<HTMLInputElement>(h, 'f-kp-ack')!, true);
    buttonNamed(h.host, 'Connect')!.click();
    await flush();
    expect(connects(h.fake)).toHaveLength(0);
    const region = field<HTMLSelectElement>(h, 'f-kp-region')!;
    expect(region.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(region.getAttribute('aria-describedby')!)?.textContent).toBe(
      'Choose a region',
    );
    expect(document.activeElement).toBe(region);
  });
});

describe('an imitation-required region says so before and after connecting', () => {
  it('shows the caution on the card and the form, and the toast points to Edit', async () => {
    const h = await mount({ presets: [KIMI_IMITATION] });
    await openConnect(h);
    const card = h.host.querySelector('[role="group"][aria-label="Kimi Code"]')!;
    expect(card.textContent).toContain('currently refuses polyrouter’s own identity');
    expect(card.textContent).toContain('turned on in Edit');
    await chooseCard(h, 'kimi-code');
    expect(modalText(h)).toContain('Identity imitation required');
    expect(modalText(h)).toContain('turn on identity imitation in the provider’s Edit dialog');
    await type(field<HTMLInputElement>(h, 'f-kp-key')!, 'sk-kimi-fixture');
    await tick(field<HTMLInputElement>(h, 'f-kp-ack')!, true);
    buttonNamed(h.host, 'Connect')!.click();
    await flush();
    expect(connects(h.fake)[0]).toMatchObject({ acknowledgeTermsRisk: true });
    expect(h.store.state.toast?.text).toContain('turn on identity imitation in its Edit dialog');
    expect(h.store.state.toast?.text).not.toContain('sync models');
  });
});

describe('the key hint warns but never blocks', () => {
  it('shows a caution for a mismatched prefix while Connect stays enabled', async () => {
    const h = await mount({ presets: [KIMI_ONE_REGION] });
    await openConnect(h);
    await chooseCard(h, 'kimi-code');
    expect(modalText(h)).not.toContain('pay-as-you-go');
    await type(field<HTMLInputElement>(h, 'f-kp-key')!, 'sk-other-fixture');
    const caution = document.getElementById('f-kp-key-caution')!;
    expect(caution.textContent).toContain('may be a pay-as-you-go key');
    expect(caution.textContent).toContain('bills your account balance');
    expect(field(h, 'f-kp-key')!.getAttribute('aria-describedby')).toContain('f-kp-key-caution');
    expect(buttonNamed(h.host, 'Connect')!.disabled).toBe(false);
    await type(field<HTMLInputElement>(h, 'f-kp-key')!, 'sk-kimi-fixture');
    expect(document.getElementById('f-kp-key-caution')).toBeNull();
  });
});

describe('the pasted key is never shown again', () => {
  it('is cleared and not echoed after a successful connect', async () => {
    const h = await mount({ presets: [OPENCODE] });
    await openConnect(h);
    await chooseCard(h, 'opencode-go');
    await type(field<HTMLInputElement>(h, 'f-kp-key')!, KEY);
    buttonNamed(h.host, 'Connect')!.click();
    await flush();
    expect(h.store.state.kp.key).toBe('');
    expect(document.body.textContent).not.toContain(KEY);
    expect(h.store.state.toast?.text ?? '').not.toContain(KEY);
    expect(JSON.stringify(h.store.state.providers)).not.toContain(KEY);
  });

  it('is cleared and not echoed after a failed connect, which keeps the form open', async () => {
    const h = await mount({ presets: [OPENCODE] });
    h.fake.keyPresetConnectRejects = new ApiError(422, 'Unprocessable', 'the key was refused');
    await openConnect(h);
    await chooseCard(h, 'opencode-go');
    await type(field<HTMLInputElement>(h, 'f-kp-key')!, KEY);
    buttonNamed(h.host, 'Connect')!.click();
    await flush();
    expect(h.store.state.modal).toBe('newProvider');
    expect(field<HTMLInputElement>(h, 'f-kp-key')!.value).toBe('');
    expect(modalText(h)).toContain('the key was refused');
    expect(document.body.textContent).not.toContain(KEY);
    expect(h.store.state.kp.key).toBe('');
  });
});

describe('the connect path appears whenever any preset is listed', () => {
  it('shows key-preset cards with no OAuth preset, and keeps Other subscription', async () => {
    const h = await mount({ presets: [OPENCODE], oauth: false });
    await openConnect(h);
    expect(h.host.querySelector('[data-key-preset="opencode-go"]')).not.toBeNull();
    expect(buttonNamed(h.host, 'Other subscription (paste a credential)')).toBeDefined();
    // The classic fields are not shown until "Other subscription" is chosen.
    expect(field(h, 'f-np-baseurl')).toBeNull();
    buttonNamed(h.host, 'Other subscription (paste a credential)')!.click();
    await flush();
    expect(field(h, 'f-np-baseurl')).not.toBeNull();
  });

  it('shows no connect path with nothing listed at all', async () => {
    const h = await mount({ presets: [], oauth: false });
    await openConnect(h);
    expect(h.host.querySelector('[data-key-preset]')).toBeNull();
    expect(field(h, 'f-np-baseurl')).not.toBeNull();
  });

  it('drops a half-filled key form, and its key, when the kind changes', async () => {
    const h = await mount({ presets: [OPENCODE] });
    await openConnect(h);
    await chooseCard(h, 'opencode-go');
    await type(field<HTMLInputElement>(h, 'f-kp-key')!, KEY);
    h.store.setState('np', 'kind', 'api');
    await flush();
    expect(h.store.state.kp.key).toBe('');
    expect(h.store.state.kp.preset).toBeNull();
  });
});

describe('the connect form is keyboard- and screen-reader-accessible', () => {
  it('labels every control with a real label, natively focusable, and lands focus on the first', async () => {
    const h = await mount({ presets: [ZAI] });
    await openConnect(h);
    await chooseCard(h, 'zai-coding-plan');
    await flush();
    const form = h.host.querySelector('[data-key-preset-form]')!;
    const controls = [...form.querySelectorAll<HTMLElement>('input, select, button')];
    expect(controls.length).toBeGreaterThan(4);
    for (const el of controls) {
      expect(el.getAttribute('tabindex')).not.toBe('-1');
      if (el instanceof HTMLButtonElement) {
        expect(labelText(el)).not.toBe('');
        continue;
      }
      const label = form.querySelector(`label[for="${el.id}"]`);
      expect(label, `${el.id} has a real label`).not.toBeNull();
    }
    expect((field(h, 'f-kp-key') as HTMLInputElement).type).toBe('password');
    expect((field(h, 'f-kp-ack') as HTMLInputElement).type).toBe('checkbox');
    expect(document.activeElement?.id).toBe('f-kp-region');
  });

  it('announces a missing key on the field it concerns', async () => {
    const h = await mount({ presets: [OPENCODE] });
    await openConnect(h);
    await chooseCard(h, 'opencode-go');
    buttonNamed(h.host, 'Connect')!.click();
    await flush();
    const key = field<HTMLInputElement>(h, 'f-kp-key')!;
    expect(key.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(key.getAttribute('aria-describedby')!)?.textContent).toMatch(
      /Paste your plan key/,
    );
    expect(document.activeElement).toBe(key);
    expect(connects(h.fake)).toHaveLength(0);
  });

  it('Back returns to the cards and moves focus to the card', async () => {
    const h = await mount({ presets: [OPENCODE] });
    await openConnect(h);
    await chooseCard(h, 'opencode-go');
    buttonNamed(h.host, 'Back')!.click();
    await flush();
    expect(document.activeElement).toBe(h.host.querySelector('[data-key-preset="opencode-go"]'));
    expect(h.store.state.kp.preset).toBeNull();
  });
});

describe('editing a key-preset provider', () => {
  const openEdit = async (h: Harness, id = 'p1'): Promise<void> => {
    h.store.openEditProvider(h.store.state.providers.find((p) => p.id === id)!);
    await flush();
  };

  it('rotates the key in place: read-only pinned fields, and the PATCH carries only name and key', async () => {
    const h = await mount({ presets: [KIMI_ONE_REGION], providers: [mkProvider()] });
    await openEdit(h);
    expect(modalText(h)).toContain('Subscription — Kimi Code (International)');
    for (const id of ['f-np-baseurl', 'f-np-protocol', 'f-np-kind']) {
      const el = field<HTMLInputElement>(h, id)!;
      expect(el, id).not.toBeNull();
      expect(el.readOnly, `${id} is read-only`).toBe(true);
      expect(el.disabled, `${id} is not disabled`).toBe(false);
    }
    expect(field<HTMLInputElement>(h, 'f-np-baseurl')!.value).toBe('https://api.kimi.ai/coding/v1');
    expect(buttonNamed(h.host, 'Reconnect')).toBeUndefined();
    await type(field<HTMLInputElement>(h, 'f-np-name')!, 'Kimi work');
    await type(field<HTMLInputElement>(h, 'f-np-credential')!, 'sk-kimi-rotated');
    buttonNamed(h.host, 'Save changes')!.click();
    await flush();
    expect(patches(h.fake)).toEqual([{ name: 'Kimi work', credential: 'sk-kimi-rotated' }]);
    expect(h.store.state.modal).toBeNull();
    expect(h.store.state.providers[0]!.keyPreset).toBe('kimi-code');
  });

  it('a blank key keeps the stored one: nothing but the changed name is sent', async () => {
    const h = await mount({ presets: [KIMI_ONE_REGION], providers: [mkProvider()] });
    await openEdit(h);
    await type(field<HTMLInputElement>(h, 'f-np-name')!, 'Renamed');
    buttonNamed(h.host, 'Save changes')!.click();
    await flush();
    expect(patches(h.fake)).toEqual([{ name: 'Renamed' }]);
  });

  it('falls back to the marker id and host when the preset is no longer listed', async () => {
    const h = await mount({ presets: [], providers: [mkProvider()] });
    await openEdit(h);
    expect(modalText(h)).toContain('Subscription — kimi-code (api.kimi.ai)');
  });
});

describe('edit offers identity imitation only on a declaring key preset', () => {
  const switchBox = (h: Harness): HTMLInputElement | null =>
    field<HTMLInputElement>(h, 'f-np-imitate');

  it('shows the switch beside the ToS caution, and turning it on asks first', async () => {
    const h = await mount({ presets: [KIMI_ONE_REGION], providers: [mkProvider()] });
    h.store.openEditProvider(h.store.state.providers[0]!);
    await flush();
    expect(modalText(h)).toContain('may violate the provider’s ToS');
    const box = switchBox(h)!;
    expect(box).not.toBeNull();
    expect(box.checked).toBe(false);
    await tick(box, true);
    const dialog = h.host.querySelector('[role="dialog"][aria-label^="Imitate "]');
    expect(dialog).not.toBeNull();
    expect(box.checked).toBe(false); // the box stays off until the consent commits
    expect(patches(h.fake)).toHaveLength(0);
    buttonNamed(dialog as HTMLElement, 'Turn on imitation')!.click();
    await flush();
    expect(switchBox(h)!.checked).toBe(true);
    buttonNamed(h.host, 'Save changes')!.click();
    await flush();
    expect(patches(h.fake)).toEqual([{ imitateClientIdentity: true }]);
  });

  it.each([
    [
      'an OpenCode Go row',
      {
        keyPreset: 'opencode-go',
        baseUrl: 'https://opencode.ai/inference/go/openai/v1',
        clientIdentity: null,
      },
    ],
    [
      'a MiniMax row',
      { keyPreset: 'minimax-m-plan', baseUrl: 'https://api.minimax.io/v1', clientIdentity: null },
    ],
    ['a row whose safe view names no identity', { clientIdentity: null }],
  ] as const)('shows no switch for %s', async (_name, over) => {
    const h = await mount({ providers: [mkProvider({ ...over })] });
    h.store.openEditProvider(h.store.state.providers[0]!);
    await flush();
    expect(field(h, 'f-np-name')).not.toBeNull(); // the dialog is open
    expect(switchBox(h)).toBeNull();
    expect(modalText(h)).toContain('may violate the provider’s ToS');
  });
});

describe('the provider card names its preset’s risk', () => {
  const zaiRow = mkProvider({
    id: 'p2',
    name: 'Z.ai work',
    keyPreset: 'zai-coding-plan',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
  });

  it('names the preset and level, keeps the fallback action, and shows no Reconnect or token line', async () => {
    const h = await mount({ presets: [ZAI], providers: [zaiRow] });
    const card = h.host.querySelector('main')!;
    const notice = [...card.querySelectorAll<HTMLElement>('.notice')].find((n) =>
      (n.textContent ?? '').includes('Terms risk'),
    )!;
    expect(notice.textContent).toContain('Z.ai GLM Coding Plan');
    expect(notice.textContent).toContain('high terms risk');
    expect(notice.textContent).toContain('Z.ai’s terms forbid proxy use.');
    expect(buttonNamed(notice, 'Add a pay-per-token fallback')).toBeDefined();
    expect(buttonNamed(card, 'Reconnect')).toBeUndefined();
    expect(card.querySelector('[data-token-line]')).toBeNull();
  });

  it('falls back to the generic wording, still naming the preset id, when it is no longer listed', async () => {
    const h = await mount({ presets: [], providers: [zaiRow] });
    const notice = [...h.host.querySelectorAll<HTMLElement>('.notice')].find((n) =>
      (n.textContent ?? '').includes('Terms risk'),
    )!;
    expect(notice.textContent).toContain('may violate the provider’s ToS');
    expect(notice.textContent).toContain('zai-coding-plan');
    expect(notice.textContent).not.toContain('high terms risk');
  });

  it('the subscription kind blurb no longer names only ChatGPT and Claude', async () => {
    const h = await mount({ presets: [] });
    h.store.openModal('newProvider');
    await flush();
    expect(modalText(h)).toContain('coding plan');
  });
});
