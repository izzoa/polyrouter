/**
 * The key-subscription presets on the dashboard (add-key-subscription-presets, group 9;
 * redesign-subscription-picker group 4): dashboard-core "Subscription plans are chosen from one
 * list with a detail pane" and "A key-preset provider shows its preset and pinned endpoint
 * wherever it appears".
 *
 * The real App is mounted on the fake client. The fake client's default key-preset list is the
 * SHIPPED one (every region ships enabled); the named fixtures below are shapes a test needs
 * (one region, an imitation-required region). No key is a real key.
 */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ApiError, type KeyPresetDto, type ProviderDto } from './data/api';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import {
  DEFAULT_SESSION,
  FakeApiClient,
  SHIPPED_KEY_PRESETS,
  UNRECORDED_HEALTH,
} from './test/fakeClient';
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
  declaresIdentity: true,
  clientIdentityLabel: 'Claude Code',
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
  declaresIdentity: true,
  clientIdentityLabel: 'Claude Code',
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
  declaresIdentity: false,
  clientIdentityLabel: null,
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

const tick = async (el: HTMLInputElement, on: boolean): Promise<void> => {
  el.checked = on;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
};

/** Open the new-provider modal on the subscription kind: the picker. */
const openConnect = async (h: Harness): Promise<void> => {
  h.store.openModal('newProvider');
  await flush();
  const sub = [...h.host.querySelectorAll<HTMLButtonElement>('.kind-card')].find((b) =>
    (b.textContent ?? '').startsWith('Subscription'),
  );
  sub?.click();
  await flush();
};

/** A plan's entry in the picker's list. */
const entry = (h: Harness, id: string): HTMLButtonElement | null =>
  h.host.querySelector<HTMLButtonElement>(`button.sp-entry[data-plan="${id}"]`);

const choosePlan = async (h: Harness, id: string): Promise<void> => {
  entry(h, id)!.click();
  await flush();
};

/** A region option of the chosen preset's segmented control, by its label. */
const regionOption = (h: Harness, label: string): HTMLButtonElement | undefined =>
  [...h.host.querySelectorAll<HTMLButtonElement>('#f-kp-region .rs-seg')].find(
    (b) => labelText(b) === label,
  );

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

describe('every subscription plan is listed from the first view', () => {
  it('lists the sign-in plans and the four coding plans, the first chosen, with no verification wording', async () => {
    const h = await mount({ presets: SHIPPED_KEY_PRESETS.map((p) => ({ ...p })) });
    await openConnect(h);
    const card = h.host.querySelector('.modal-card')!;
    expect(card.classList.contains('modal-card--picker')).toBe(true);
    expect(card.querySelector('#modal-title')?.textContent).toBe('Connect a subscription');
    const groups = [...card.querySelectorAll<HTMLElement>('.sp-list [role="group"]')];
    expect(groups.map((g) => g.querySelector('.sp-group-label')?.textContent)).toEqual([
      'Sign in with your account',
      'Coding-plan API key',
    ]);
    const names = (g: HTMLElement): string[] =>
      [...g.querySelectorAll('.sp-entry-name')].map((n) => n.textContent ?? '');
    expect(names(groups[0]!)).toEqual(['Claude Pro / Max', 'ChatGPT Plus / Pro', 'Fixture Plan']);
    expect(names(groups[1]!)).toEqual([
      'OpenCode Go',
      'MiniMax M Plan',
      'Kimi Code',
      'Z.ai GLM Coding Plan',
    ]);
    // The first listed plan is chosen, so the detail is never empty.
    expect(entry(h, 'claude')?.getAttribute('aria-current')).toBe('true');
    expect(card.querySelectorAll('.sp-entry[aria-current="true"]')).toHaveLength(1);
    expect(card.querySelector('#sp-detail-title')?.textContent).toBe('Claude Pro / Max');
    // No verification status anywhere (user decision 2026-11-09).
    expect(modalText(h)).not.toMatch(/verif|not available|unavailable/i);
    expect(card.innerHTML).not.toContain('dashed');
    expect(buttonNamed(h.host, 'Sign in')!.disabled).toBe(false);
    expect(h.host.querySelector('button a')).toBeNull();
    // The classic endpoint and credential fields are not shown on the picker.
    expect(field(h, 'f-np-baseurl')).toBeNull();
    expect(field(h, 'f-np-credential')).toBeNull();
    expect(field(h, 'f-np-name')).toBeNull();
  });

  it('choosing another plan swaps only the detail, and the footer names its action', async () => {
    const h = await mount({ presets: SHIPPED_KEY_PRESETS.map((p) => ({ ...p })) });
    await openConnect(h);
    await choosePlan(h, 'kimi-code');
    expect(entry(h, 'kimi-code')?.getAttribute('aria-current')).toBe('true');
    expect(entry(h, 'claude')?.getAttribute('aria-current')).toBeNull();
    expect(h.host.querySelector('#sp-detail-title')?.textContent).toBe('Kimi Code');
    expect(buttonNamed(h.host, 'Connect Kimi Code')).toBeDefined();
    expect(buttonNamed(h.host, 'Sign in')).toBeUndefined();
    expect(h.host.querySelectorAll('.modal-card .btn-primary')).toHaveLength(1);
    // A half-filled key of the previous plan is discarded.
    await type(field<HTMLInputElement>(h, 'f-kp-key')!, KEY);
    await choosePlan(h, 'opencode-go');
    expect(field<HTMLInputElement>(h, 'f-kp-key')!.value).toBe('');
    expect(h.store.state.kp.key).toBe('');
    expect(document.body.textContent).not.toContain(KEY);
  });
});

describe('connecting a key preset end to end (Z.ai)', () => {
  it('shows the region, key and acknowledgement, and connects through the endpoint', async () => {
    const h = await mount({ presets: [ZAI] });
    await openConnect(h);
    await choosePlan(h, 'zai-coding-plan');

    // No free-text endpoint or protocol: the detail replaced those fields.
    expect(field(h, 'f-np-baseurl')).toBeNull();
    expect(field(h, 'f-np-protocol')).toBeNull();
    expect(field(h, 'f-np-credential')).toBeNull();

    // The first region is preselected and its pinned host shown.
    expect(regionOption(h, 'International')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.getElementById('f-kp-region-host')?.textContent).toContain('api.z.ai');
    const connect = buttonNamed(h.host, 'Connect Z.ai GLM Coding Plan')!;
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
    await choosePlan(h, 'opencode-go');
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
    const connect = buttonNamed(h.host, 'Connect OpenCode Go')!;
    connect.click();
    await flush();
    expect(connect.disabled).toBe(true);
    expect(connect.getAttribute('aria-busy')).toBe('true');
    // The plan cannot change while the connect is in flight.
    expect(entry(h, 'opencode-go')?.getAttribute('aria-disabled')).toBe('true');
    escape();
    h.store.closeModal();
    await flush();
    expect(h.store.state.modal).toBe('newProvider'); // not dismissed
    release();
    await flush();
    expect(h.store.state.modal).toBeNull();
  });
});

describe('each plan states its own terms risk', () => {
  it('names the level in the list and the level and copy in the detail, with a new-tab terms link', async () => {
    const h = await mount({ presets: [ZAI, OPENCODE] });
    await openConnect(h);
    expect(entry(h, 'zai-coding-plan')?.textContent).toContain('High risk');
    expect(entry(h, 'opencode-go')?.textContent).toContain('Low risk');
    await choosePlan(h, 'zai-coding-plan');
    const detail = h.host.querySelector('.sp-detail')!;
    expect(detail.textContent).toContain('High terms risk');
    expect(detail.textContent).toContain('Z.ai’s terms forbid proxy use.');
    // add-dismissible-terms-risk 4.3 ("The connect dialog still states the risk"): the picker's
    // terms notice is part of a one-time flow and carries no dismiss.
    expect(detail.querySelector('.notice')).not.toBeNull();
    expect(detail.querySelector('.notice-dismiss')).toBeNull();
    const link = [...detail.querySelectorAll<HTMLAnchorElement>('a')].find((a) =>
      (a.textContent ?? '').includes('Read the plan’s terms'),
    )!;
    expect(link.href).toBe(ZAI.termsUrl);
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noreferrer');
    expect(link.textContent).toContain('opens in a new tab');
    // An OAuth plan's detail carries the generic flat-plan caution.
    await choosePlan(h, 'claude');
    expect(h.host.querySelector('.sp-detail')?.textContent).toContain(
      'may violate the provider’s ToS',
    );
    expect(modalText(h)).toContain('Other subscription (paste a credential)');
  });
});

describe('regions', () => {
  it('a one-region preset shows no region choice and connects with that region id', async () => {
    const h = await mount({ presets: [KIMI_ONE_REGION] });
    await openConnect(h);
    await choosePlan(h, 'kimi-code');
    expect(field(h, 'f-kp-region')).toBeNull();
    await type(field<HTMLInputElement>(h, 'f-kp-key')!, 'sk-kimi-fixture');
    buttonNamed(h.host, 'Connect Kimi Code')!.click();
    await flush();
    expect(connects(h.fake)).toEqual([
      { preset: 'kimi-code', region: 'intl', credential: 'sk-kimi-fixture' },
    ]);
  });

  it('a several-region preset preselects the first, shows each host, and sends the chosen one', async () => {
    const h = await mount({ presets: SHIPPED_KEY_PRESETS.map((p) => ({ ...p })) });
    await openConnect(h);
    await choosePlan(h, 'kimi-code');
    const group = field(h, 'f-kp-region')!;
    expect(group.getAttribute('role')).toBe('group');
    expect(document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent).toBe(
      'Region',
    );
    expect(regionOption(h, 'International')?.getAttribute('aria-pressed')).toBe('true');
    expect(regionOption(h, 'China')?.getAttribute('aria-pressed')).toBe('false');
    expect(document.getElementById('f-kp-region-host')?.textContent).toContain('api.kimi.ai');
    regionOption(h, 'China')!.click();
    await flush();
    expect(regionOption(h, 'China')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.getElementById('f-kp-region-host')?.textContent).toContain('api.kimi.com');
    expect(field<HTMLInputElement>(h, 'f-kp-name')!.placeholder).toBe('Kimi Code (China)');
    await type(field<HTMLInputElement>(h, 'f-kp-key')!, 'sk-kimi-fixture');
    buttonNamed(h.host, 'Connect Kimi Code')!.click();
    await flush();
    expect(connects(h.fake)).toEqual([
      { preset: 'kimi-code', region: 'cn', credential: 'sk-kimi-fixture' },
    ]);
  });
});

describe('an imitation-required region says so before and after connecting', () => {
  it('shows the caution in the list and the detail, and the toast points to Edit', async () => {
    const h = await mount({ presets: [KIMI_IMITATION] });
    await openConnect(h);
    const kimi = entry(h, 'kimi-code')!;
    expect(kimi.textContent).toContain('refuses polyrouter’s own identity');
    expect(kimi.textContent).toContain('identity imitation in Edit');
    await choosePlan(h, 'kimi-code');
    expect(modalText(h)).toContain('Identity imitation required');
    expect(modalText(h)).toContain('turn on identity imitation in the provider’s Edit dialog');
    // add-dismissible-terms-risk 4.3: no notice in the connect dialog carries a dismiss.
    expect(h.host.querySelector('.sp-detail .notice-dismiss')).toBeNull();
    await type(field<HTMLInputElement>(h, 'f-kp-key')!, 'sk-kimi-fixture');
    await tick(field<HTMLInputElement>(h, 'f-kp-ack')!, true);
    buttonNamed(h.host, 'Connect Kimi Code')!.click();
    await flush();
    expect(connects(h.fake)[0]).toMatchObject({ acknowledgeTermsRisk: true });
    expect(h.store.state.toast?.text).toContain('turn on identity imitation in its Edit dialog');
    expect(h.store.state.toast?.text).not.toContain('sync models');
  });
});

describe('a declaring key preset offers identity imitation before connect (add-key-preset-identity-optin)', () => {
  const SWITCH = '#f-kp-imitate';
  const CONSENT = '[role="dialog"][aria-label^="Imitate "]';
  const box = (h: Harness): HTMLInputElement | null => h.host.querySelector(SWITCH);
  const consent = (): HTMLElement | null => document.querySelector<HTMLElement>(CONSENT);
  const sent = (h: Harness): Record<string, unknown>[] => connects(h.fake);

  it('shows the switch, off, for Kimi and Z.ai only, and names no header value', async () => {
    const h = await mount({ presets: SHIPPED_KEY_PRESETS.map((p) => ({ ...p })) });
    await openConnect(h);
    for (const id of ['kimi-code', 'zai-coding-plan']) {
      await choosePlan(h, id);
      expect(box(h), id).not.toBeNull();
      expect(box(h)!.checked).toBe(false);
      expect(labelText(h.host.querySelector(`label[for="f-kp-imitate"]`)!)).toContain(
        'Imitate Claude Code’s client identity',
      );
      const detail = h.host.querySelector('.sp-detail')?.textContent ?? '';
      expect(detail).toContain('polyrouter/<version>');
      expect(detail).toContain('Edit dialog');
      expect(detail).not.toMatch(/claude-c(li|ode)\//);
    }
    for (const id of ['opencode-go', 'minimax-m-plan']) {
      await choosePlan(h, id);
      expect(box(h), id).toBeNull();
      expect(h.host.querySelector('.sp-detail')?.textContent ?? '').not.toContain(
        'identity imitation',
      );
    }
  });

  it('asks first: Cancel leaves it off with focus back on the switch', async () => {
    const h = await mount({ presets: SHIPPED_KEY_PRESETS.map((p) => ({ ...p })) });
    await openConnect(h);
    await choosePlan(h, 'kimi-code');
    await tick(box(h)!, true);
    expect(consent(), 'the confirmation opens').not.toBeNull();
    expect(box(h)!.checked).toBe(false);
    expect(h.store.state.kp.imitate).toBe(false);
    buttonNamed(consent()!, 'Cancel')!.click();
    await flush();
    expect(consent()).toBeNull();
    expect(box(h)!.checked).toBe(false);
    expect(document.activeElement).toBe(box(h));
  });

  it('confirming turns it on, and Connect sends the opt-in; off sends no field', async () => {
    const h = await mount({ presets: SHIPPED_KEY_PRESETS.map((p) => ({ ...p })) });
    await openConnect(h);
    await choosePlan(h, 'kimi-code');
    await tick(box(h)!, true);
    buttonNamed(consent()!, 'Turn on imitation')!.click();
    await flush();
    expect(box(h)!.checked).toBe(true);
    // One primary action stays in the footer: the switch is a form control.
    expect(h.host.querySelectorAll('.modal-card .btn-primary')).toHaveLength(1);
    await type(field<HTMLInputElement>(h, 'f-kp-key')!, 'sk-kimi-fixture');
    buttonNamed(h.host, 'Connect Kimi Code')!.click();
    await flush();
    expect(sent(h)[0]).toMatchObject({ preset: 'kimi-code', imitateClientIdentity: true });
    expect(h.store.state.providers.at(-1)?.imitateClientIdentity).toBe(true);

    await openConnect(h);
    await choosePlan(h, 'kimi-code');
    expect(box(h)!.checked, 'a new connect starts off').toBe(false);
    await type(field<HTMLInputElement>(h, 'f-kp-key')!, 'sk-kimi-fixture-2');
    buttonNamed(h.host, 'Connect Kimi Code')!.click();
    await flush();
    expect(sent(h)[1]).not.toHaveProperty('imitateClientIdentity');
  });

  it('a plan swap clears the opt-in', async () => {
    const h = await mount({ presets: SHIPPED_KEY_PRESETS.map((p) => ({ ...p })) });
    await openConnect(h);
    await choosePlan(h, 'zai-coding-plan');
    await tick(box(h)!, true);
    buttonNamed(consent()!, 'Turn on imitation')!.click();
    await flush();
    expect(box(h)!.checked).toBe(true);
    await choosePlan(h, 'kimi-code');
    expect(box(h)!.checked).toBe(false);
    expect(h.store.state.kp.imitate).toBe(false);
  });
});

describe('the key hint warns but never blocks', () => {
  it('shows a caution for a mismatched prefix while Connect stays enabled', async () => {
    const h = await mount({ presets: [KIMI_ONE_REGION] });
    await openConnect(h);
    await choosePlan(h, 'kimi-code');
    expect(modalText(h)).not.toContain('pay-as-you-go');
    await type(field<HTMLInputElement>(h, 'f-kp-key')!, 'sk-other-fixture');
    const caution = document.getElementById('f-kp-key-caution')!;
    expect(caution.textContent).toContain('may be a pay-as-you-go key');
    expect(caution.textContent).toContain('bills your account balance');
    expect(field(h, 'f-kp-key')!.getAttribute('aria-describedby')).toContain('f-kp-key-caution');
    expect(buttonNamed(h.host, 'Connect Kimi Code')!.disabled).toBe(false);
    await type(field<HTMLInputElement>(h, 'f-kp-key')!, 'sk-kimi-fixture');
    expect(document.getElementById('f-kp-key-caution')).toBeNull();
  });
});

describe('the pasted key is never shown again', () => {
  it('is cleared and not echoed after a successful connect', async () => {
    const h = await mount({ presets: [OPENCODE] });
    await openConnect(h);
    await choosePlan(h, 'opencode-go');
    await type(field<HTMLInputElement>(h, 'f-kp-key')!, KEY);
    buttonNamed(h.host, 'Connect OpenCode Go')!.click();
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
    await choosePlan(h, 'opencode-go');
    await type(field<HTMLInputElement>(h, 'f-kp-key')!, KEY);
    buttonNamed(h.host, 'Connect OpenCode Go')!.click();
    await flush();
    expect(h.store.state.modal).toBe('newProvider');
    expect(field<HTMLInputElement>(h, 'f-kp-key')!.value).toBe('');
    expect(modalText(h)).toContain('the key was refused');
    expect(document.body.textContent).not.toContain(KEY);
    expect(h.store.state.kp.key).toBe('');
  });
});

describe('the connect path appears whenever any preset is listed', () => {
  it('shows the key plans with no OAuth preset, and keeps Other subscription', async () => {
    const h = await mount({ presets: [OPENCODE], oauth: false });
    await openConnect(h);
    expect(entry(h, 'opencode-go')).not.toBeNull();
    expect(h.host.querySelector('#sp-g-oauth')).toBeNull();
    expect(buttonNamed(h.host, 'Other subscription (paste a credential)')).toBeDefined();
    expect(field(h, 'f-np-baseurl')).toBeNull();
    buttonNamed(h.host, 'Other subscription (paste a credential)')!.click();
    await flush();
    expect(field(h, 'f-np-baseurl')).not.toBeNull();
    expect(h.host.querySelector('.modal-card--picker')).toBeNull();
  });

  it('shows the classic form with nothing listed at all', async () => {
    const h = await mount({ presets: [], oauth: false });
    await openConnect(h);
    expect(h.host.querySelector('.sp-entry')).toBeNull();
    expect(field(h, 'f-np-baseurl')).not.toBeNull();
  });
});

describe('leaving the picker discards a pasted key', () => {
  it('Other subscription opens the classic paste form, without the key', async () => {
    const h = await mount({ presets: [OPENCODE] });
    await openConnect(h);
    await choosePlan(h, 'opencode-go');
    await type(field<HTMLInputElement>(h, 'f-kp-key')!, KEY);
    buttonNamed(h.host, 'Other subscription (paste a credential)')!.click();
    await flush();
    expect(field(h, 'f-np-credential')).not.toBeNull();
    expect(h.store.state.kp.key).toBe('');
    expect(document.body.textContent).not.toContain(KEY);
    expect(modalText(h)).toContain('may violate the provider’s ToS');
  });

  it('Change kind shows the kind choice with Subscription selected; choosing it returns to the picker', async () => {
    const h = await mount({ presets: [OPENCODE] });
    await openConnect(h);
    await choosePlan(h, 'opencode-go');
    await type(field<HTMLInputElement>(h, 'f-kp-key')!, KEY);
    buttonNamed(h.host, 'Change kind')!.click();
    await flush();
    expect(h.host.querySelector('.modal-card--picker')).toBeNull();
    expect(h.store.state.kp.key).toBe('');
    const sub = [...h.host.querySelectorAll<HTMLButtonElement>('.kind-card')].find((b) =>
      (b.textContent ?? '').startsWith('Subscription'),
    )!;
    expect(sub.getAttribute('aria-pressed')).toBe('true');
    expect(field(h, 'f-np-name')).not.toBeNull();
    sub.click();
    await flush();
    expect(h.host.querySelector('.modal-card--picker')).not.toBeNull();
    expect(h.host.querySelector('#sp-detail-title')?.textContent).not.toBe('');
    expect(field<HTMLInputElement>(h, 'f-kp-key')?.value ?? '').toBe('');
  });

  it('drops a half-filled key form, and its key, when the kind changes', async () => {
    const h = await mount({ presets: [OPENCODE] });
    await openConnect(h);
    await choosePlan(h, 'opencode-go');
    await type(field<HTMLInputElement>(h, 'f-kp-key')!, KEY);
    h.store.setState('np', 'kind', 'api');
    await flush();
    expect(h.store.state.kp.key).toBe('');
    expect(h.store.state.kp.preset).toBeNull();
  });
});

describe('the picker is keyboard- and screen-reader-accessible', () => {
  it('labels every control with a real label, and the plan entries expose the choice', async () => {
    const h = await mount({ presets: [ZAI] });
    await openConnect(h);
    await choosePlan(h, 'zai-coding-plan');
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
    for (const e of h.host.querySelectorAll<HTMLButtonElement>('.sp-entry')) {
      expect(e.type).toBe('button');
      expect(labelText(e)).not.toBe('');
    }
    expect(h.host.querySelector('.sp-detail')?.getAttribute('aria-labelledby')).toBe(
      'sp-detail-title',
    );
  });

  it('at a wide width, choosing keeps focus on the entry and shows no Back to plans', async () => {
    const h = await mount({ presets: [ZAI, OPENCODE] });
    await openConnect(h);
    entry(h, 'opencode-go')!.focus();
    await choosePlan(h, 'opencode-go');
    expect(document.activeElement).toBe(entry(h, 'opencode-go'));
    expect(buttonNamed(h.host, 'Back to plans')).toBeUndefined();
  });

  it('announces a missing key on the field it concerns', async () => {
    const h = await mount({ presets: [OPENCODE] });
    await openConnect(h);
    await choosePlan(h, 'opencode-go');
    buttonNamed(h.host, 'Connect OpenCode Go')!.click();
    await flush();
    const key = field<HTMLInputElement>(h, 'f-kp-key')!;
    expect(key.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(key.getAttribute('aria-describedby')!)?.textContent).toMatch(
      /Paste your plan key/,
    );
    expect(document.activeElement).toBe(key);
    expect(connects(h.fake)).toHaveLength(0);
  });
});

describe('an OAuth plan signs in from its detail (design D9)', () => {
  it('runs the paste-back steps in the detail, with the list inert until Back', async () => {
    const h = await mount({ presets: [OPENCODE] });
    await openConnect(h);
    await choosePlan(h, 'chatgpt');
    expect(h.fake.callLog.filter((c) => c.method === 'oauthStart')).toHaveLength(0);
    buttonNamed(h.host, 'Sign in')!.click();
    await flush();
    expect(h.fake.callLog.filter((c) => c.method === 'oauthStart')).toHaveLength(1);
    expect(h.host.querySelector('.sp-detail #f-ow-paste')).not.toBeNull();
    // One primary: the paste step's Connect, not the footer's Sign in.
    expect(buttonNamed(h.host, 'Sign in')).toBeUndefined();
    expect(h.host.querySelectorAll('.modal-card .btn-primary')).toHaveLength(1);
    const og = entry(h, 'opencode-go')!;
    expect(og.getAttribute('aria-disabled')).toBe('true');
    expect(buttonNamed(h.host, 'Change kind')?.getAttribute('aria-disabled')).toBe('true');
    og.click();
    await flush();
    expect(h.store.state.sp.chosen).toBe('chatgpt');
    buttonNamed(h.host, 'Back')!.click();
    await flush();
    expect(og.getAttribute('aria-disabled')).toBeNull();
    await choosePlan(h, 'opencode-go');
    expect(h.store.state.sp.chosen).toBe('opencode-go');
  });
});

describe('on a narrow card the list and the detail are two steps (design D7)', () => {
  it('choosing moves focus to the detail heading; Back to plans returns it to the entry', async () => {
    // The picker reads its card's width against PICKER_FIT; happy-dom lays nothing out.
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 390,
      height: 700,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 390,
      bottom: 700,
      toJSON: () => ({}),
    });
    const h = await mount({ presets: [ZAI, OPENCODE] });
    await openConnect(h);
    const picker = h.host.querySelector<HTMLElement>('[data-subscription-picker]')!;
    expect(picker.dataset['step']).toBe('list');
    await choosePlan(h, 'opencode-go');
    expect(picker.dataset['step']).toBe('detail');
    expect(document.activeElement).toBe(h.host.querySelector('#sp-detail-title'));
    const back = buttonNamed(h.host, 'Back to plans')!;
    back.click();
    await flush();
    expect(picker.dataset['step']).toBe('list');
    expect(document.activeElement).toBe(entry(h, 'opencode-go'));
    rect.mockRestore();
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
