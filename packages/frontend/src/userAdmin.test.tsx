import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import type { AdminInviteDto, AdminUserDto } from './data/api';
import { App } from './App';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { DEFAULT_LOGIN_CONFIG, DEFAULT_SESSION, FakeApiClient } from './test/fakeClient';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

const NOW = '2026-07-15T00:00:00.000Z';
const FUTURE = '2027-01-01T00:00:00.000Z';
const PAST = '2026-01-01T00:00:00.000Z';

function mkUser(over: Partial<AdminUserDto> & { id: string; email: string }): AdminUserDto {
  return { name: over.email.split('@')[0] ?? '', role: null, disabled: false, createdAt: NOW, ...over };
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
  const el = [...host.querySelectorAll<HTMLElement>(selector)].find(
    (e) => e.textContent?.trim() === text,
  );
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
        i.textContent?.trim(),
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
      const items = [...host.querySelectorAll('[role="menuitem"]')].map((i) =>
        i.textContent?.trim(),
      );
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
      const demotes = [...host.querySelectorAll('button')].filter(
        (b) => b.textContent?.trim() === 'Demote',
      );
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
      const revokes = [...host.querySelectorAll('button')].filter(
        (b) => b.textContent?.trim() === 'Revoke',
      );
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
      ].find((b) => b.textContent?.trim() === 'Invite only');
      expect(invite?.getAttribute('aria-pressed')).toBe('false'); // fake default: open
      invite?.click();
      await flush();
      expect(client.calls).toContain('adminSetRegistration');
      expect(invite?.getAttribute('aria-pressed')).toBe('true');
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
      const tabs = [...host.querySelectorAll('button')].filter(
        (b) => b.textContent?.trim() === 'Sign up',
      );
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
