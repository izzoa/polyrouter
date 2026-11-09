/**
 * The identity-imitation switch, its consent confirmation, and the connect wizard's identity
 * step (allow-preset-client-identity, tasks 8.2-8.4; dashboard-config).
 *
 * The switch lives where the provider's safe view names a client identity, and only there. It
 * never turns itself on: checking it opens a confirmation, Cancel and Escape leave it off, and
 * the PATCH (or the connect start) carries the choice only after the user has confirmed. The
 * warning is the dialog's accessible description, because initial focus lands on the commit
 * button and the risk must be announced before it can be accepted.
 */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { DEFAULT_SESSION, FakeApiClient, UNRECORDED_HEALTH } from './test/fakeClient';
import type { ProviderDto } from './data/api';
import { labelText } from './test/labelText';

const NOW = '2026-11-06T12:00:00.000Z';

const mkProvider = (over: Partial<ProviderDto> = {}): ProviderDto => ({
  id: 'p1',
  name: 'Fixture Plan',
  kind: 'subscription',
  protocol: 'openai_compatible',
  baseUrl: 'https://1.1.1.1/v1',
  status: 'ok',
  maxTokensSpelling: 'auto',
  hasCredential: true,
  oauthPreset: 'stub-identity',
  credentialExpiresAt: NOW,
  credentialError: null,
  firstByteTimeoutMs: null,
  idleTimeoutMs: null,
  autoPruneUnlisted: true,
  imitateClientIdentity: false,
  clientIdentity: { label: 'Fixture Client' },
  createdAt: NOW,
  ...UNRECORDED_HEALTH,
  ...over,
});

// Each mounted App installs its own document-level key arbiter; one left mounted would swallow
// a later test's Escape, so every harness is disposed in afterEach.
const disposers: (() => void)[] = [];

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
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

const SWITCH = '#f-np-imitate';
const WIZARD_SWITCH = '#f-ow-imitate';
const CONSENT = '[role="dialog"][aria-label^="Imitate "]';

const box = (host: HTMLElement, sel = SWITCH): HTMLInputElement | null =>
  host.querySelector<HTMLInputElement>(sel);
const consent = (host: HTMLElement): HTMLElement | null => host.querySelector<HTMLElement>(CONSENT);

const openEdit = async (h: Harness): Promise<void> => {
  h.store.openEditProvider(h.store.state.providers[0]!);
  await flush();
};

const buttonNamed = (root: ParentNode, name: string): HTMLButtonElement | undefined =>
  [...root.querySelectorAll('button')].find((b) => labelText(b) === name);

const saveEdit = async (h: Harness): Promise<void> => {
  buttonNamed(h.host, 'Save changes')?.click();
  await flush();
};

const check = async (el: HTMLInputElement, on: boolean): Promise<void> => {
  el.checked = on;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
};

const escape = (): void => {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
};

const patches = (fake: FakeApiClient): Record<string, unknown>[] =>
  fake.callLog
    .filter((c) => c.method === 'updateProvider')
    .map((c) => c.args[1] as Record<string, unknown>);

const starts = (fake: FakeApiClient): unknown[][] =>
  fake.callLog.filter((c) => c.method === 'oauthStart').map((c) => c.args);

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('the switch is shown only where an identity is declared', () => {
  it.each([
    ['a Claude-preset provider', { oauthPreset: 'claude', clientIdentity: null }],
    [
      'a ChatGPT-preset provider',
      { oauthPreset: 'chatgpt', protocol: 'openai_responses', clientIdentity: null },
    ],
    ['a pasted-credential subscription provider', { oauthPreset: null, clientIdentity: null }],
    ['an api_key provider', { kind: 'api_key', oauthPreset: null, clientIdentity: null }],
    ['a provider the server sent without the field', { oauthPreset: null }],
  ] as const)('is hidden for %s', async (_name, over) => {
    const dto = mkProvider({ ...over });
    if (!('clientIdentity' in over) || over.clientIdentity === undefined) {
      delete (dto as { clientIdentity?: unknown }).clientIdentity;
    }
    const h = await mount(dto);
    await openEdit(h);
    expect(h.host.querySelector('#f-np-name')).not.toBeNull(); // the modal is open
    expect(box(h.host)).toBeNull();
    expect(h.host.textContent).not.toMatch(/client identity/);
  });

  it('keeps the subscription ToS caution where it already showed', async () => {
    const h = await mount(mkProvider({ oauthPreset: null, clientIdentity: null }));
    await openEdit(h);
    expect(h.host.textContent).toMatch(/may violate the provider’s ToS/);
    expect(box(h.host)).toBeNull();
  });

  it('is shown, off, with its label and caption, for a declaring preset', async () => {
    const h = await mount(mkProvider());
    await openEdit(h);
    expect(box(h.host)).not.toBeNull();
    expect(box(h.host)!.checked).toBe(false);
    expect(h.host.textContent).toContain('Imitate Fixture Client’s client identity');
    expect(h.host.textContent).toContain(
      'Sends Fixture Client’s identity headers on this provider’s requests.',
    );
  });

  it('reflects a stored on', async () => {
    const h = await mount(mkProvider({ imitateClientIdentity: true }));
    await openEdit(h);
    expect(box(h.host)!.checked).toBe(true);
  });
});

describe('turning it on asks first', () => {
  it('opens a confirmation naming the client; the box stays off meanwhile', async () => {
    const h = await mount(mkProvider());
    await openEdit(h);
    await check(box(h.host)!, true);
    const dialog = consent(h.host);
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute('aria-label')).toBe('Imitate Fixture Client’s client identity?');
    expect(dialog!.textContent).toContain('Imitate Fixture Client’s client identity?');
    expect(box(h.host)!.checked).toBe(false);
    // Nothing is sent by asking.
    expect(patches(h.fake)).toHaveLength(0);
  });

  it('states the instance, terms, suspension and blocking risks; Cancel first, a verb Primary', async () => {
    const h = await mount(mkProvider());
    await openEdit(h);
    await check(box(h.host)!, true);
    const dialog = consent(h.host)!;
    const text = dialog.textContent ?? '';
    expect(text).toMatch(/provider sees these requests coming from this polyrouter instance/);
    expect(text).toMatch(/likely violates the provider’s terms/);
    expect(text).toMatch(/can be suspended/);
    expect(text).toMatch(/block it at any time/);
    const buttons = [...dialog.querySelectorAll('button')];
    expect(buttons.map((b) => labelText(b))).toEqual(['Cancel', 'Turn on imitation']);
    expect(buttons[0]!.className).toContain('btn-cancel');
    expect(buttons[1]!.className).toContain('btn-primary');
    // One Primary in the dialog, and no amber (or red) button.
    expect(dialog.querySelectorAll('.btn-primary')).toHaveLength(1);
    expect(dialog.querySelector('.btn-destructive, [class*="amber"]')).toBeNull();
  });

  it('describes itself with the warning, and focus lands on the commit', async () => {
    const h = await mount(mkProvider());
    await openEdit(h);
    await check(box(h.host)!, true);
    const dialog = consent(h.host)!;
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy, 'the dialog has no accessible description').toBeTruthy();
    const body = document.getElementById(describedBy!);
    expect(body).not.toBeNull();
    expect(dialog.contains(body)).toBe(true);
    expect(body!.textContent).toMatch(/^polyrouter will send Fixture Client’s identity headers/);
    expect(body!.textContent).toMatch(/block it at any time\.$/);
    expect(document.activeElement).toBe(buttonNamed(dialog, 'Turn on imitation'));
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('Cancel closes it with the switch off, focus back on the switch, and nothing sent', async () => {
    const h = await mount(mkProvider());
    await openEdit(h);
    await check(box(h.host)!, true);
    buttonNamed(consent(h.host)!, 'Cancel')!.click();
    await flush();
    expect(consent(h.host)).toBeNull();
    expect(box(h.host)!.checked).toBe(false);
    expect(document.activeElement).toBe(box(h.host));
    await saveEdit(h);
    expect('imitateClientIdentity' in patches(h.fake)[0]!).toBe(false);
  });

  it('Escape closes only the confirmation, with the switch off and focus back on it', async () => {
    const h = await mount(mkProvider());
    await openEdit(h);
    await check(box(h.host)!, true);
    escape();
    await flush();
    expect(consent(h.host)).toBeNull();
    // The provider modal beneath is still open.
    expect(h.host.querySelector('#f-np-name')).not.toBeNull();
    expect(box(h.host)!.checked).toBe(false);
    expect(document.activeElement).toBe(box(h.host));
  });

  it('confirming turns it on, Save sends true, and reopening shows it on', async () => {
    const h = await mount(mkProvider());
    await openEdit(h);
    await check(box(h.host)!, true);
    buttonNamed(consent(h.host)!, 'Turn on imitation')!.click();
    await flush();
    expect(consent(h.host)).toBeNull();
    expect(box(h.host)!.checked).toBe(true);
    expect(patches(h.fake)).toHaveLength(0); // confirming only sets form state
    await saveEdit(h);
    expect(patches(h.fake)).toHaveLength(1);
    expect(patches(h.fake)[0]).toMatchObject({ imitateClientIdentity: true });
    await openEdit(h);
    expect(box(h.host)!.checked).toBe(true);
  });

  it('turning it off does not ask, and Save sends false', async () => {
    const h = await mount(mkProvider({ imitateClientIdentity: true }));
    await openEdit(h);
    await check(box(h.host)!, false);
    expect(consent(h.host)).toBeNull();
    expect(box(h.host)!.checked).toBe(false);
    await saveEdit(h);
    expect(patches(h.fake)[0]).toMatchObject({ imitateClientIdentity: false });
  });

  it('a modal closed with the confirmation open leaves none behind for the next one', async () => {
    const h = await mount(mkProvider());
    await openEdit(h);
    await check(box(h.host)!, true);
    h.store.closeModal();
    await flush();
    await openEdit(h);
    expect(consent(h.host)).toBeNull();
  });
});

describe('an unchanged switch is not sent', () => {
  it('a rename sends the name and not the switch (on a full patch)', async () => {
    const h = await mount(mkProvider({ oauthPreset: null }));
    await openEdit(h);
    const name = h.host.querySelector<HTMLInputElement>('#f-np-name')!;
    name.value = 'Renamed';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    await saveEdit(h);
    expect(patches(h.fake)).toHaveLength(1);
    expect(patches(h.fake)[0]).toMatchObject({ name: 'Renamed' });
    expect('imitateClientIdentity' in patches(h.fake)[0]!).toBe(false);
  });

  it('a rename of an OAuth-connected row sends the name and not the switch', async () => {
    const h = await mount(mkProvider({ imitateClientIdentity: true }));
    await openEdit(h);
    const name = h.host.querySelector<HTMLInputElement>('#f-np-name')!;
    name.value = 'Renamed';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    await saveEdit(h);
    expect(patches(h.fake)[0]).toMatchObject({ name: 'Renamed' });
    expect('imitateClientIdentity' in patches(h.fake)[0]!).toBe(false);
  });

  it('a changed switch rides the OAuth name-only patch too', async () => {
    const h = await mount(mkProvider());
    await openEdit(h);
    await check(box(h.host)!, true);
    buttonNamed(consent(h.host)!, 'Turn on imitation')!.click();
    await flush();
    await saveEdit(h);
    const patch = patches(h.fake)[0]!;
    expect(patch).toMatchObject({ imitateClientIdentity: true });
    // Still the name-only shape: the pinned endpoint, kind and protocol are not sent.
    expect('baseUrl' in patch || 'kind' in patch || 'protocol' in patch).toBe(false);
  });
});

describe('the connect wizard offers the opt-in for a declaring preset', () => {
  // redesign-subscription-picker: a plan is chosen in the picker's list (which starts
  // nothing), and Sign in in its detail starts the connect — or opens the identity step for a
  // declaring preset.
  const openWizard = async (h: Harness): Promise<void> => {
    h.store.openModal('newProvider');
    h.store.setState('np', 'kind', 'sub');
    await flush();
  };
  const entry = (h: Harness, name: string): HTMLButtonElement | undefined =>
    [...h.host.querySelectorAll<HTMLButtonElement>('button.sp-entry')].find((b) =>
      labelText(b).startsWith(name),
    );
  const choose = async (h: Harness, name: string): Promise<void> => {
    entry(h, name)!.click();
    await flush();
  };
  const signIn = async (h: Harness): Promise<void> => {
    buttonNamed(h.host, 'Sign in')!.click();
    await flush();
  };

  it('a declaring preset opens the identity step instead of connecting on Sign in', async () => {
    const h = await mount(mkProvider());
    await openWizard(h);
    await choose(h, 'Fixture Plan');
    expect(starts(h.fake)).toHaveLength(0);
    await signIn(h);
    expect(starts(h.fake)).toHaveLength(0);
    expect(box(h.host, WIZARD_SWITCH)).not.toBeNull();
    expect(box(h.host, WIZARD_SWITCH)!.checked).toBe(false);
    expect(buttonNamed(h.host, 'Continue to sign-in')).toBeDefined();
    expect(h.host.querySelectorAll('.modal-card .btn-primary')).toHaveLength(1);
  });

  it('sends the opt-in only after consent', async () => {
    const h = await mount(mkProvider());
    await openWizard(h);
    await choose(h, 'Fixture Plan');
    await signIn(h);
    await check(box(h.host, WIZARD_SWITCH)!, true);
    expect(consent(h.host)).not.toBeNull();
    expect(box(h.host, WIZARD_SWITCH)!.checked).toBe(false);
    expect(starts(h.fake)).toHaveLength(0);
    buttonNamed(consent(h.host)!, 'Turn on imitation')!.click();
    await flush();
    expect(box(h.host, WIZARD_SWITCH)!.checked).toBe(true);
    expect(starts(h.fake)).toHaveLength(0);
    buttonNamed(h.host, 'Continue to sign-in')!.click();
    await flush();
    expect(starts(h.fake)).toEqual([['stub-identity', undefined, true]]);
    // The sign-in steps follow, in the same detail pane.
    expect(h.store.state.ow.active?.preset).toBe('stub-identity');
    expect(h.host.querySelector('.sp-detail #f-ow-paste')).not.toBeNull();
  });

  it('Cancel leaves the opt-in off, so continuing sends a start without it', async () => {
    const h = await mount(mkProvider());
    await openWizard(h);
    await choose(h, 'Fixture Plan');
    await signIn(h);
    await check(box(h.host, WIZARD_SWITCH)!, true);
    buttonNamed(consent(h.host)!, 'Cancel')!.click();
    await flush();
    expect(document.activeElement).toBe(box(h.host, WIZARD_SWITCH));
    buttonNamed(h.host, 'Continue to sign-in')!.click();
    await flush();
    expect(starts(h.fake)).toEqual([['stub-identity', undefined]]);
  });

  it('Back returns to the plan detail without connecting', async () => {
    const h = await mount(mkProvider());
    await openWizard(h);
    await choose(h, 'Fixture Plan');
    await signIn(h);
    buttonNamed(h.host, 'Back')!.click();
    await flush();
    expect(box(h.host, WIZARD_SWITCH)).toBeNull();
    expect(entry(h, 'Fixture Plan')?.getAttribute('aria-current')).toBe('true');
    expect(buttonNamed(h.host, 'Sign in')).toBeDefined();
    expect(starts(h.fake)).toHaveLength(0);
  });

  it.each(['Claude Pro / Max', 'ChatGPT Plus / Pro'])(
    '%s connects on Sign in in its detail, with no identity step and no opt-in field',
    async (name) => {
      const h = await mount(mkProvider());
      await openWizard(h);
      await choose(h, name);
      expect(starts(h.fake), 'choosing it in the list alone starts nothing').toHaveLength(0);
      await signIn(h);
      expect(box(h.host, WIZARD_SWITCH)).toBeNull();
      expect(starts(h.fake)).toHaveLength(1);
      expect(starts(h.fake)[0]).toHaveLength(2); // preset and name only
    },
  );
});
