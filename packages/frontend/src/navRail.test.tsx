/** Narrow-width navigation rail (phase1-responsive-dashboard-layout).
 *
 * WHAT THESE TESTS ARE. `happy-dom` performs no layout and evaluates no media query, so
 * nothing here proves the rail is 56px wide or that labels are visually hidden — that is
 * the browser suite's job. These assert the BEHAVIOUR that is independent of layout: the
 * expanded state's dialog semantics, that every entitled destination stays reachable in
 * one of the two states, and — the part that actually had two live bugs — that a single
 * Escape resolves to exactly one surface when overlays stack.
 */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

async function mount(role: 'admin' | 'member' = 'admin'): Promise<{
  host: HTMLElement;
  store: AppStore;
  dispose: () => void;
}> {
  const client = new FakeApiClient();
  // `session` is nullable on the fake; narrow before spreading so the role override
  // cannot silently produce a partial SessionInfo.
  if (client.session) client.session = { ...client.session, role };
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
  await flush();
  return {
    host,
    store,
    dispose: () => {
      dispose();
      host.remove();
    },
  };
}

const sidebar = (host: HTMLElement): HTMLElement => {
  const el = host.querySelector<HTMLElement>('[data-pane="sidebar"]');
  if (!el) throw new Error('sidebar not found');
  return el;
};
const toggle = (host: HTMLElement): HTMLButtonElement => {
  const el = host.querySelector<HTMLButtonElement>('.rs-nav-toggle');
  if (!el) throw new Error('nav toggle not found');
  return el;
};
const escape = (): void => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('narrow-width nav rail', () => {
  it('starts collapsed and toggles open and shut', async () => {
    const h = await mount();
    try {
      expect(h.store.state.navExpanded).toBe(false);
      expect(toggle(h.host).getAttribute('aria-expanded')).toBe('false');

      toggle(h.host).click();
      await flush();
      expect(h.store.state.navExpanded).toBe(true);
      expect(toggle(h.host).getAttribute('aria-expanded')).toBe('true');

      toggle(h.host).click();
      await flush();
      expect(h.store.state.navExpanded).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it('claims dialog semantics only while expanded', async () => {
    const h = await mount();
    try {
      // Collapsed it is an ordinary in-flow pane — claiming aria-modal there would lie.
      expect(sidebar(h.host).getAttribute('role')).toBeNull();
      expect(sidebar(h.host).getAttribute('aria-modal')).toBeNull();

      h.store.setNavExpanded(true);
      await flush();
      const el = sidebar(h.host);
      expect(el.getAttribute('role')).toBe('dialog');
      expect(el.getAttribute('aria-modal')).toBe('true');
      expect(el.getAttribute('aria-label')).toBe('Navigation');
      // dialogKeyboard's contract: the root must be able to take focus.
      expect(el.getAttribute('tabindex')).toBe('-1');
      expect(toggle(h.host).getAttribute('aria-controls')).toBe('sidebar-nav');
    } finally {
      h.dispose();
    }
  });

  it('makes the content pane inert while the overlay owns the screen', async () => {
    const h = await mount();
    try {
      const content = (): HTMLElement | null =>
        h.host.querySelector<HTMLElement>('[data-pane="content"]');
      expect(content()?.hasAttribute('inert')).toBe(false);
      h.store.setNavExpanded(true);
      await flush();
      // aria-modal and the focus trap cover keyboard and AT; inert covers pointer.
      expect(content()?.hasAttribute('inert')).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it('keeps every nav label in the accessibility tree when collapsed', async () => {
    // Collapsed the rail shows icons only, but the names must survive — hiding them with
    // display:none would strip the accessible name off every destination.
    const h = await mount();
    try {
      const labels = [...h.host.querySelectorAll('#sidebar-nav .rs-nav-label')].map((e) =>
        e.textContent?.trim(),
      );
      expect(labels).toContain('Overview');
      expect(labels).toContain('Settings');
    } finally {
      h.dispose();
    }
  });

  it('keeps the account menu and setup guide reachable in the expanded state', async () => {
    // The canonical shell contract requires the lower items to stay reachable; the rail
    // is too narrow for them, so the expanded state is where they live.
    const h = await mount();
    try {
      h.store.setNavExpanded(true);
      await flush();
      expect(h.host.querySelector('.rs-sidebar-footer')).not.toBeNull();
      expect(h.host.querySelector('.setup-card')).not.toBeNull();
    } finally {
      h.dispose();
    }
  });

  it('collapses when a destination is chosen', async () => {
    const h = await mount();
    try {
      h.store.setNavExpanded(true);
      await flush();
      const costs = [...h.host.querySelectorAll<HTMLButtonElement>('#sidebar-nav .nav-item')].find(
        (b) => b.textContent?.includes('Costs'),
      );
      costs?.click();
      await flush();
      expect(h.store.state.page).toBe('costs');
      // Otherwise the overlay would sit on top of the page it just opened.
      expect(h.store.state.navExpanded).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it('admits an admin to Users at narrow width and still refuses a non-admin', async () => {
    const admin = await mount('admin');
    try {
      const names = [...admin.host.querySelectorAll('#sidebar-nav .nav-item')].map((e) =>
        e.textContent?.trim(),
      );
      expect(names.some((n) => n?.includes('Users'))).toBe(true);
    } finally {
      admin.dispose();
    }
    const member = await mount('member');
    try {
      const names = [...member.host.querySelectorAll('#sidebar-nav .nav-item')].map((e) =>
        e.textContent?.trim(),
      );
      expect(names.some((n) => n?.includes('Users'))).toBe(false);
    } finally {
      member.dispose();
    }
  });
});

describe('stacked overlays dismiss one surface per Escape', () => {
  it('closes the account menu first, then the nav on a second Escape', async () => {
    // Both handlers live on `document`. Before this change one keypress closed both,
    // because neither knew about the other.
    const h = await mount();
    try {
      h.store.setNavExpanded(true);
      h.store.setAccountMenuOpen(true);
      await flush();

      escape();
      await flush();
      expect(h.store.state.accountMenuOpen).toBe(false);
      expect(h.store.state.navExpanded, 'nav must survive the menu closing').toBe(true);

      escape();
      await flush();
      expect(h.store.state.navExpanded).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it('does not close the inspector drawer when Escape closes the nav', async () => {
    const h = await mount();
    try {
      h.store.select('r1');
      h.store.setNavExpanded(true);
      await flush();
      expect(h.store.state.selId).toBe('r1');

      escape();
      await flush();
      expect(h.store.state.navExpanded).toBe(false);
      expect(h.store.state.selId, 'the drawer must survive the nav closing').toBe('r1');
    } finally {
      h.dispose();
    }
  });

  it('collapsing the nav takes the account menu with it', async () => {
    const h = await mount();
    try {
      h.store.setNavExpanded(true);
      h.store.setAccountMenuOpen(true);
      await flush();
      h.store.setNavExpanded(false);
      await flush();
      // Otherwise a dismissible surface is stranded behind a collapsed rail.
      expect(h.store.state.accountMenuOpen).toBe(false);
    } finally {
      h.dispose();
    }
  });
});
