import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './data/api';
import type { AdminInviteDto, AdminUserDto, RegistrationSettingsDto } from './data/api';
import { App } from './App';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { DEFAULT_LOGIN_CONFIG, DEFAULT_SESSION, FakeApiClient } from './test/fakeClient';
import { labelText } from './test/labelText';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

const NOW = '2026-07-15T00:00:00.000Z';
const FUTURE = '2027-01-01T00:00:00.000Z';
const PAST = '2026-01-01T00:00:00.000Z';

function mkUser(over: Partial<AdminUserDto> & { id: string; email: string }): AdminUserDto {
  return {
    name: over.email.split('@')[0] ?? '',
    role: null,
    disabled: false,
    createdAt: NOW,
    ...over,
  };
}
function mkInvite(over: Partial<AdminInviteDto> & { id: string; email: string }): AdminInviteDto {
  return {
    tokenPrefix: 'abcdef123456',
    createdAt: NOW,
    expiresAt: FUTURE,
    consumedAt: null,
    ...over,
  };
}

function mount(client: FakeApiClient): {
  host: HTMLElement;
  store: AppStore;
  client: FakeApiClient;
  dispose: () => void;
} {
  const store = createAppStore(client);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const dispose = render(
    () => (
      <AppProvider store={store}>
        <App live={false} />
      </AppProvider>
    ),
    host,
  );
  return {
    host,
    store,
    client,
    dispose: () => {
      dispose();
      host.remove();
    },
  };
}

function clickByText(host: HTMLElement, selector: string, text: string): void {
  const el = [...host.querySelectorAll<HTMLElement>(selector)].find((e) => labelText(e) === text);
  if (!el) throw new Error(`No element ${selector} with text "${text}"`);
  el.click();
}

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset['theme'];
  globalThis.history.replaceState(null, '', '/');
});

describe('current-user menu (sidebar footer)', () => {
  it('shows the signed-in email and opens a menu with Settings / theme / Users / Log out', async () => {
    const { host, client, dispose } = mount(new FakeApiClient());
    try {
      await flush();
      const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
      expect(trigger).not.toBeNull();
      expect(trigger?.textContent).toContain(DEFAULT_SESSION.email);
      expect(trigger?.getAttribute('aria-expanded')).toBe('false');

      trigger?.click();
      await flush();
      const menu = host.querySelector('[role="menu"]');
      expect(menu).not.toBeNull();
      expect(trigger?.getAttribute('aria-expanded')).toBe('true');
      const items = [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])].map((i) =>
        labelText(i),
      );
      expect(items).toContain('Settings');
      expect(items).toContain('Users'); // admin session
      expect(items).toContain('Log out');

      clickByText(host, '[role="menuitem"]', 'Log out');
      await flush();
      expect(client.calls).toContain('signOut');
    } finally {
      dispose();
    }
  });

  it('closes on Escape and hides admin-only entries for members', async () => {
    const { host, dispose } = mount(
      new FakeApiClient({ session: { ...DEFAULT_SESSION, role: null } }),
    );
    try {
      await flush();
      // No Users nav item for a plain member…
      const navLabels = [...host.querySelectorAll('.nav-item span')].map((s) => s.textContent);
      expect(navLabels).not.toContain('Users');
      // …and no Users menu item.
      host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.click();
      await flush();
      const items = [...host.querySelectorAll('[role="menuitem"]')].map((i) => labelText(i));
      expect(items).toContain('Settings');
      expect(items).not.toContain('Users');

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await flush();
      expect(host.querySelector('[role="menu"]')).toBeNull();
    } finally {
      dispose();
    }
  });
});

describe('Users page (admin)', () => {
  const twoUsers = [
    mkUser({ id: 'u1', email: 'admin@localhost', name: 'Admin', role: 'admin' }),
    mkUser({ id: 'u2', email: 'bob@example.com', name: 'Bob' }),
  ];

  async function openUsers(client: FakeApiClient) {
    const m = mount(client);
    await flush();
    clickByText(m.host, '.nav-item span', 'Users');
    await flush();
    return m;
  }

  it('lists users with roles, marks the signed-in user, and mutates through the API', async () => {
    const { host, client, dispose } = await openUsers(new FakeApiClient({ adminUsers: twoUsers }));
    try {
      expect(client.calls).toContain('adminListUsers');
      expect(host.textContent).toContain('bob@example.com');
      expect(host.textContent).toContain('(you)'); // u1 === session.userId
      clickByText(host, 'button', 'Make admin');
      await flush();
      expect(client.calls).toContain('adminSetRole');
      // reloaded list reflects the fake's mutation: both rows are admins now
      const demotes = [...host.querySelectorAll('button')].filter((b) => labelText(b) === 'Demote');
      expect(demotes.length).toBe(2);
    } finally {
      dispose();
    }
  });

  it('issues an invite and shows the one-time link with email status', async () => {
    const { host, client, store, dispose } = await openUsers(
      new FakeApiClient({ adminUsers: twoUsers }),
    );
    try {
      store.setState('ua', 'inviteEmail', 'carol@example.com');
      clickByText(host, 'button', 'Invite');
      await flush();
      expect(client.calls).toContain('adminCreateInvite');
      expect(host.textContent).toContain('Invite for carol@example.com');
      // SMTP not configured in the fake default → manual-copy wording, no "emailed"
      expect(host.textContent).toContain('copy this link');
      expect(host.querySelector('code')?.textContent).toContain('/accept-invite#token=');
      // The new pending invite row appears with a revoke action
      clickByText(host, 'button', 'Revoke');
      await flush();
      expect(client.calls).toContain('adminRevokeInvite');
    } finally {
      dispose();
    }
  });

  it('labels expired invites and offers no revoke for them', async () => {
    const { host, dispose } = await openUsers(
      new FakeApiClient({
        adminUsers: twoUsers,
        adminInvites: [mkInvite({ id: 'i1', email: 'old@example.com', expiresAt: PAST })],
      }),
    );
    try {
      expect(host.textContent).toContain('expired');
      const revokes = [...host.querySelectorAll('button')].filter((b) => labelText(b) === 'Revoke');
      expect(revokes.length).toBe(0);
    } finally {
      dispose();
    }
  });

  it('switches registration mode through the toggle group', async () => {
    const { host, client, dispose } = await openUsers(new FakeApiClient({ adminUsers: twoUsers }));
    try {
      const invite = [
        ...host.querySelectorAll<HTMLButtonElement>('[role="group"] button[aria-pressed]'),
      ].find((b) => labelText(b) === 'Invite only');
      expect(invite?.getAttribute('aria-pressed')).toBe('false'); // fake default: open
      invite?.click();
      await flush();
      expect(client.calls).toContain('adminSetRegistration');
      expect(invite?.getAttribute('aria-pressed')).toBe('true');
    } finally {
      dispose();
    }
  });

  // adopt-design-tokens-v2 task 16.6: until the registration settings arrive, and after a
  // failed load, the card used to state "SMTP isn't configured" as if it knew.
  const registrationCard = (host: HTMLElement): HTMLElement =>
    [...host.querySelectorAll<HTMLElement>('.panel')].find(
      (p) => p.querySelector('.section-title')?.textContent?.trim() === 'Registration',
    )!;
  const modeButtons = (host: HTMLElement): HTMLButtonElement[] => [
    ...registrationCard(host).querySelectorAll<HTMLButtonElement>('[role="group"] button'),
  ];

  it('claims nothing about SMTP while registration loads, and no mode can be pressed', async () => {
    const client = new FakeApiClient({ adminUsers: twoUsers });
    vi.spyOn(client, 'adminGetRegistration').mockImplementation(
      () => new Promise<RegistrationSettingsDto>(() => {}),
    );
    const { host, dispose } = await openUsers(client);
    try {
      const card = registrationCard(host);
      // The hidden text names the state once, so the card drops `aria-busy`, which could
      // withhold it (adopt-figure-states 3.1, D5).
      expect(card.getAttribute('aria-busy')).toBeNull();
      const hidden = [...card.querySelectorAll('.sr-only')].map((e) => e.textContent);
      expect(hidden.filter((t) => t === 'Loading registration settings')).toHaveLength(1);
      expect(hidden.filter((t) => t?.startsWith('Loading'))).toHaveLength(1);
      expect(card.textContent).not.toContain('SMTP');
      const blocks = card.querySelectorAll('.fig-skel');
      expect(blocks).toHaveLength(1);
      for (const b of blocks) expect(b.getAttribute('aria-hidden')).toBe('true');
      const buttons = modeButtons(host);
      expect(buttons).toHaveLength(2);
      for (const b of buttons) {
        expect(b.disabled).toBe(true);
        expect(b.getAttribute('aria-pressed')).toBe('false');
      }
    } finally {
      dispose();
    }
  });

  it('claims nothing about SMTP after a failed load, and reports it in the text token', async () => {
    const client = new FakeApiClient({ adminUsers: twoUsers });
    vi.spyOn(client, 'adminGetRegistration').mockImplementation(() =>
      Promise.reject(new Error('registration unavailable')),
    );
    const { host, dispose } = await openUsers(client);
    try {
      const card = registrationCard(host);
      expect(card.getAttribute('aria-busy')).toBeNull();
      expect(card.textContent).not.toContain('SMTP');
      expect(card.querySelector('.fig-skel')).toBeNull();
      expect(card.textContent).not.toContain('Loading');
      const alert = host.querySelector<HTMLElement>('[role="alert"]');
      expect(alert?.textContent).toContain('registration unavailable');
      // The --red fill reads 3.75:1 as small text; status text takes the text variant.
      expect(alert?.getAttribute('style')).toContain('var(--red-text)');
    } finally {
      dispose();
    }
  });

  it('names role and status in neutral words: no Selected-state Admin chip, no red disabled', async () => {
    const { host, dispose } = await openUsers(
      new FakeApiClient({
        adminUsers: [
          ...twoUsers,
          mkUser({ id: 'u3', email: 'carol@example.com', name: 'Carol', disabled: true }),
        ],
      }),
    );
    try {
      const chips = [...host.querySelectorAll<HTMLElement>('td .chip')];
      expect(chips.map((c) => c.textContent)).toEqual(['Admin', 'Member', 'Member']);
      for (const c of chips) {
        const style = c.getAttribute('style') ?? '';
        expect(style).toContain('var(--text2)');
        expect(style).not.toMatch(/--accent/);
      }
      const status = [...host.querySelectorAll<HTMLElement>('td span')].find(
        (s) => s.textContent === 'disabled',
      );
      expect(status, 'the disabled status word').toBeDefined();
      expect(status!.getAttribute('style')).toContain('var(--text2)');
      expect(status!.getAttribute('style')).not.toMatch(/var\(--red\)/);
    } finally {
      dispose();
    }
  });

  it('surfaces a last-admin refusal from the API as an inline error', async () => {
    const client = new FakeApiClient({
      adminUsers: [mkUser({ id: 'u1', email: 'admin@localhost', name: 'Admin', role: 'admin' })],
    });
    client.adminSetRoleFailure = 'refused: this would leave the instance without an enabled admin';
    const { host, dispose } = await openUsers(client);
    try {
      clickByText(host, 'button', 'Demote');
      await flush();
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        'without an enabled admin',
      );
    } finally {
      dispose();
    }
  });
});

// adopt-red-destructive-actions task 4.1 (D6 / D7 / D8): Delete and Disable ask in the shared
// dashboard dialog, never the browser's prompt, with copy that states what will happen rather
// than promising it "immediately" or "now". Invitation Revoke and Enable are recoverable, so
// they stay neutral ghosts.
describe('Users page: Delete and Disable ask in the shared destructive dialog', () => {
  const users = [
    mkUser({ id: 'u1', email: 'admin@localhost', name: 'Admin', role: 'admin' }),
    mkUser({ id: 'u2', email: 'bob@example.com', name: 'Bob' }),
    mkUser({ id: 'u3', email: 'carol@example.com', name: 'Carol', disabled: true }),
  ];
  const OVERPROMISE = /\b(immediately|now)\b/i;

  let nativeConfirm: ReturnType<typeof vi.fn<(message?: string) => boolean>>;
  afterEach(() => {
    expect(nativeConfirm, 'the native confirm prompt was shown').not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function openUsers(client: FakeApiClient) {
    nativeConfirm = vi.fn<(message?: string) => boolean>(() => true);
    vi.stubGlobal('confirm', nativeConfirm);
    const m = mount(client);
    await flush();
    clickByText(m.host, '.nav-item span', 'Users');
    await flush();
    return m;
  }

  const rowOf = (host: HTMLElement, email: string): HTMLElement =>
    [...host.querySelectorAll<HTMLElement>('main tbody tr')].find((r) =>
      r.textContent?.includes(email),
    )!;
  const buttonIn = (scope: ParentNode, label: string): HTMLButtonElement =>
    [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => labelText(b) === label)!;
  const dialogOf = (host: HTMLElement): HTMLElement | null =>
    host.querySelector<HTMLElement>('[role="dialog"].confirm-card');
  /** Activate a row's trigger as a keyboard user would (focused, then pressed). */
  async function open(host: HTMLElement, email: string, label: string): Promise<HTMLElement> {
    const trigger = buttonIn(rowOf(host, email), label);
    trigger.focus();
    trigger.click();
    await flush();
    const dialog = dialogOf(host);
    expect(dialog, `${label} opened no dashboard dialog`).not.toBeNull();
    return dialog!;
  }
  const bodyOf = (dialog: HTMLElement): string =>
    dialog.querySelector('.t-dense')?.textContent ?? '';
  const commitOf = (dialog: HTMLElement): HTMLButtonElement =>
    dialog.querySelector<HTMLButtonElement>('button.btn-destructive')!;

  it('marks Delete and Disable destructive, and leaves Enable and Revoke neutral', async () => {
    const { host, dispose } = await openUsers(
      new FakeApiClient({
        adminUsers: users,
        adminInvites: [mkInvite({ id: 'i1', email: 'new@example.com' })],
      }),
    );
    try {
      const bob = rowOf(host, 'bob@example.com');
      for (const label of ['Delete', 'Disable']) {
        expect(buttonIn(bob, label).className, label).toBe('btn-ghost btn-ghost--destructive');
      }
      expect(buttonIn(rowOf(host, 'carol@example.com'), 'Enable').className).toBe('btn-ghost');
      expect(buttonIn(host, 'Revoke').className).toBe('btn-ghost');
      expect(host.querySelector('.btn-ghost--amber'), 'a button still carries amber').toBeNull();
    } finally {
      dispose();
    }
  });

  it('Delete names the user and the loss; declining sends nothing, accepting deletes once', async () => {
    const { host, client, dispose } = await openUsers(new FakeApiClient({ adminUsers: users }));
    try {
      let dialog = await open(host, 'bob@example.com', 'Delete');
      expect(dialog.getAttribute('aria-label')).toBe('Delete bob@example.com?');
      expect(bodyOf(dialog)).toBe(
        'Their agents, providers and request history go with them. This cannot be undone.',
      );
      expect(labelText(commitOf(dialog))).toBe('Delete user');
      expect(labelText(dialog.querySelector('button')!)).toBe('Cancel');
      expect(document.activeElement).toBe(dialog.querySelector('button'));

      buttonIn(dialog, 'Cancel').click();
      await flush();
      expect(dialogOf(host)).toBeNull();
      expect(client.countOf('adminDeleteUser')).toBe(0);

      dialog = await open(host, 'bob@example.com', 'Delete');
      commitOf(dialog).click();
      commitOf(dialog).click();
      await flush();
      expect(client.countOf('adminDeleteUser')).toBe(1);
      expect(dialogOf(host)).toBeNull();
      expect(host.querySelector('main')?.textContent).not.toContain('bob@example.com');
      // The row went with its trigger: focus lands on the page title, never the body (D8).
      expect(document.activeElement?.id).toBe('page-title');
    } finally {
      dispose();
    }
  });

  it('Disable on another user states the forward-looking guarantee, and a failure stays in the dialog', async () => {
    const client = new FakeApiClient({ adminUsers: users });
    const { host, store, dispose } = await openUsers(client);
    const disable = vi
      .spyOn(client, 'adminSetDisabled')
      .mockRejectedValueOnce(new ApiError(409, 'Conflict', 'bob owns the last admin key'));
    try {
      const dialog = await open(host, 'bob@example.com', 'Disable');
      expect(dialog.getAttribute('aria-label')).toBe('Disable bob@example.com?');
      expect(bodyOf(dialog)).toBe(
        'They will be signed out, and new requests with their agent keys will be refused.',
      );
      expect(dialog.textContent).not.toMatch(OVERPROMISE);
      expect(labelText(commitOf(dialog))).toBe('Disable user');

      commitOf(dialog).click();
      await flush();
      // Failed: reported inside the dialog, not on the page's alert line and not as a toast.
      expect(dialogOf(host)).toBe(dialog);
      expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(
        'bob owns the last admin key',
      );
      expect(store.state.ua.error).toBeNull();
      expect(store.state.toast).toBeNull();

      commitOf(dialog).click(); // retry: the fake now answers
      await flush();
      expect(disable).toHaveBeenCalledTimes(2);
      expect(disable).toHaveBeenLastCalledWith('u2', true);
      expect(dialogOf(host)).toBeNull();
      // Disabled now: the same button reads Enable, which is recoverable and neutral.
      expect(buttonIn(rowOf(host, 'bob@example.com'), 'Enable').className).toBe('btn-ghost');
    } finally {
      dispose();
    }
  });

  it('Disable on your own account says you will be signed out, and hands focus to the sign-in gate', async () => {
    const client = new FakeApiClient({ adminUsers: users });
    const { host, store, dispose } = await openUsers(client);
    // The reboot to the sign-in gate is a navigation: observe the state at that moment.
    const atReboot: { dialogOpen: boolean; focusId: string }[] = [];
    const assign = vi.spyOn(globalThis.location, 'assign').mockImplementation(() => {
      atReboot.push({
        dialogOpen: store.state.destructive !== null || dialogOf(host) !== null,
        focusId: document.activeElement?.id ?? '',
      });
    });
    try {
      const dialog = await open(host, 'admin@localhost', 'Disable');
      expect(dialog.getAttribute('aria-label')).toBe('Disable your own account?');
      expect(bodyOf(dialog)).toBe('You will be signed out.');
      expect(dialog.textContent).not.toMatch(OVERPROMISE);
      expect(labelText(commitOf(dialog))).toBe('Disable my account');

      commitOf(dialog).click();
      await flush();
      expect(client.countOf('adminSetDisabled')).toBe(1);
      expect(assign).toHaveBeenCalledTimes(1);
      expect(assign).toHaveBeenCalledWith('/');
      // The dialog closed BEFORE the session ended, and no Users-page fallback took focus.
      expect(atReboot).toHaveLength(1);
      expect(atReboot[0]!.dialogOpen, 'the dialog outlived the session').toBe(false);
      expect(atReboot[0]!.focusId, 'a Users-page fallback took focus').not.toBe('page-title');

      // What the navigation does: the session is gone, and the gate takes over.
      client.session = null;
      await store.bootstrap();
      await flush();
      expect(host.textContent).toContain('Sign in');
      expect(host.querySelector('#page-title'), 'the Users page outlived the session').toBeNull();
      expect(dialogOf(host)).toBeNull();
      expect(document.activeElement?.id ?? '').not.toBe('page-title');
    } finally {
      dispose();
    }
  });
});

describe('login gate under invite_only', () => {
  it('hides the sign-up tab and explains invites', async () => {
    const { host, dispose } = mount(
      new FakeApiClient({
        session: null,
        loginConfig: { ...DEFAULT_LOGIN_CONFIG, registration: 'invite_only' },
      }),
    );
    try {
      await flush();
      expect(host.textContent).toContain('Sign in');
      expect(host.textContent).toContain('invite-only');
      const tabs = [...host.querySelectorAll('button')].filter((b) => labelText(b) === 'Sign up');
      expect(tabs.length).toBe(0);
    } finally {
      dispose();
    }
  });
});

describe('accept-invite page', () => {
  it('captures the fragment token from /accept-invite, scrubs the URL, and submits the form', async () => {
    globalThis.history.replaceState(null, '', '/accept-invite#token=tok_abc123');
    const { host, store, client, dispose } = mount(new FakeApiClient({ session: null }));
    try {
      await flush();
      expect(store.state.inviteToken).toBe('tok_abc123');
      expect(globalThis.location.hash).toBe(''); // token scrubbed from the URL
      expect(host.textContent).toContain('You’ve been invited');

      store.setState('ai', { name: 'Carol', password: 'hunter2hunter2' });
      clickByText(host, 'button', 'Create account');
      await flush();
      expect(client.calls).toContain('acceptInvite');
    } finally {
      dispose();
    }
  });

  it('shows the uniform error for a bad token', async () => {
    globalThis.history.replaceState(null, '', '/accept-invite#token=expired-or-bad');
    const { host, store, dispose } = mount(new FakeApiClient({ session: null }));
    try {
      await flush();
      store.setState('ai', { name: 'Mallory', password: 'hunter2hunter2' });
      clickByText(host, 'button', 'Create account');
      await flush();
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        'invalid or expired invite',
      );
    } finally {
      dispose();
    }
  });
});
