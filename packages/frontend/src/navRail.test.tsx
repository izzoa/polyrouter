/** Narrow-width navigation rail (phase1-responsive-dashboard-layout).
 *
 * WHAT THESE TESTS ARE. `happy-dom` performs no layout and evaluates no media query, so
 * nothing here proves the rail is 56px wide or that labels are visually hidden — that is
 * the browser suite's job. These assert the BEHAVIOUR that is independent of layout: the
 * expanded state's dialog semantics, that every entitled destination stays reachable in
 * one of the two states, and — the part that actually had two live bugs — that a single
 * Escape resolves to exactly one surface when overlays stack.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { entitledGroups, NAV_GROUPS, type NavGroup } from './components/Sidebar';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';
import { labelText } from './test/labelText';

const labelOf = (e: Element): string => labelText(e);

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

/** The sidebar's three groups (dashboard-core "The sidebar groups its pages under three
 * labels"; adopt-design-tokens-v2 task 11.1): each group as `[label, item names…]`, read the
 * way assistive technology reads it — the `role="group"` is named through `aria-labelledby`. */
function navGroups(host: HTMLElement): { name: string; items: string[] }[] {
  return [...host.querySelectorAll<HTMLElement>('#sidebar-nav [role="group"]')].map((g) => {
    const labelId = g.getAttribute('aria-labelledby') ?? '';
    const label = labelId === '' ? null : g.querySelector<HTMLElement>(`[id="${labelId}"]`);
    return {
      name: label?.textContent?.trim() ?? `(unnamed: aria-labelledby="${labelId}")`,
      items: [...g.querySelectorAll<HTMLElement>('.nav-item .rs-nav-label')].map(
        (e) => e.textContent?.trim() ?? '',
      ),
    };
  });
}

describe('the sidebar groups its pages under three labels (task 11.1)', () => {
  it('an admin sees Observe, Configure and Admin in order, each label over its pages', async () => {
    const h = await mount('admin');
    try {
      expect(navGroups(h.host)).toEqual([
        { name: 'Observe', items: ['Overview', 'Requests', 'Costs', 'Batches'] },
        { name: 'Configure', items: ['Routing', 'Providers', 'Agents', 'Limits'] },
        { name: 'Admin', items: ['Settings', 'Users'] },
      ]);
      // The label is an Overline that names its group, and every item sits in a group.
      for (const label of h.host.querySelectorAll('#sidebar-nav .nav-group-label')) {
        expect(label.classList.contains('t-overline'), label.textContent ?? '').toBe(true);
        // …hidden visually only in the collapsed rail, like every item label (never removed).
        expect(label.classList.contains('rs-nav-label'), label.textContent ?? '').toBe(true);
        expect(label.closest('[role="group"]')?.getAttribute('aria-labelledby')).toBe(label.id);
      }
      const items = h.host.querySelectorAll('#sidebar-nav .nav-item');
      expect(items).toHaveLength(10);
      for (const item of items)
        expect(item.closest('[role="group"]'), labelOf(item)).not.toBeNull();
      // The setup card sits below the groups until setup is complete.
      const nav = h.host.querySelector('#sidebar-nav');
      const card = h.host.querySelector('.setup-card');
      expect(card).not.toBeNull();
      expect(
        nav!.compareDocumentPosition(card!) & Node.DOCUMENT_POSITION_FOLLOWING,
        'the setup card renders above the groups',
      ).toBeTruthy();
    } finally {
      h.dispose();
    }
  });

  it("a non-admin's Admin group holds Settings only, with no empty slot", async () => {
    const h = await mount('member');
    try {
      expect(navGroups(h.host)).toEqual([
        { name: 'Observe', items: ['Overview', 'Requests', 'Costs', 'Batches'] },
        { name: 'Configure', items: ['Routing', 'Providers', 'Agents', 'Limits'] },
        { name: 'Admin', items: ['Settings'] },
      ]);
    } finally {
      h.dispose();
    }
  });

  it('a group with no page the session may open renders no label at all', () => {
    // No shipped group can empty for any session (Admin always holds Settings), so the rule is
    // held on the function the sidebar renders through, over a table where one can.
    const table: NavGroup[] = [
      { id: 'observe', label: 'Observe', pages: [{ page: 'overview', label: 'Overview' }] },
      { id: 'admin', label: 'Admin', pages: [{ page: 'users', label: 'Users', adminOnly: true }] },
    ];
    expect(entitledGroups(table, false).map((g) => g.label)).toEqual(['Observe']);
    expect(entitledGroups(table, true).map((g) => g.label)).toEqual(['Observe', 'Admin']);
    // The sidebar renders this table, not a copy of it.
    expect(entitledGroups(NAV_GROUPS, false).map((g) => g.label)).toEqual([
      'Observe',
      'Configure',
      'Admin',
    ]);
  });

  it('grouping changes no navigation semantics: aria-current, icons and names', async () => {
    const h = await mount('admin');
    try {
      for (const page of ['costs', 'routing', 'users'] as const) {
        h.store.go(page);
        await flush();
        const current = [...h.host.querySelectorAll<HTMLElement>('#sidebar-nav .nav-item')].filter(
          (b) => b.getAttribute('aria-current') !== null,
        );
        expect(current, `one current item on ${page}`).toHaveLength(1);
        expect(current[0]?.getAttribute('aria-current')).toBe('page');
        expect(current[0]?.querySelector('[data-page-icon]')?.getAttribute('data-page-icon')).toBe(
          page,
        );
      }
      // Each item's accessible name is its label alone: the group label is outside the
      // button, and the icon is decorative.
      for (const b of h.host.querySelectorAll<HTMLElement>('#sidebar-nav .nav-item')) {
        expect(b.querySelector('.nav-group-label'), labelOf(b)).toBeNull();
        expect(b.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      }
    } finally {
      h.dispose();
    }
  });

  it('the group label is hidden visually only in the collapsed rail, where a Soft Hairline separates the groups', () => {
    // happy-dom evaluates no media query, so this holds the stylesheet; `responsive.spec.ts`
    // measures the rail itself. The label is an `.rs-nav-label`, which the collapsed rail
    // clips (never `display:none`, which would drop the group's name).
    const css = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    const narrow = css.slice(css.indexOf('@media (max-width: 768px)'));
    expect(narrow).toMatch(
      /\.rs-sidebar:not\(\.rs-nav-open\) \.rs-nav-label \{[^}]*clip: rect\(0 0 0 0\)/,
    );
    expect(narrow).toMatch(
      /\.rs-sidebar:not\(\.rs-nav-open\) \.nav-group \+ \.nav-group \{[^}]*border-top: 1px solid var\(--border2\)/,
    );
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

describe('layer arbitration replaces the per-pair workarounds', () => {
  it('closes the account menu on Tab and lets focus travel on', async () => {
    // BEHAVIOUR CHANGE, deliberate (task 2.4). The menu had no Tab handling at all, so Tab
    // moved focus through the page behind it while it stayed open. Registering it as a
    // `menu` adopts the WAI-ARIA menu pattern: Tab dismisses and focus continues. It must
    // NOT trap Tab — that is a dialog's behaviour, and this is not a dialog.
    const h = await mount();
    try {
      h.store.setAccountMenuOpen(true);
      await flush();
      const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      document.body.dispatchEvent(e);
      await flush();
      expect(h.store.state.accountMenuOpen).toBe(false);
      expect(e.defaultPrevented, 'a menu must not trap Tab the way a dialog does').toBe(false);
    } finally {
      h.dispose();
    }
  });

  it('no longer needs UserMenu to stand down when the nav is expanded', async () => {
    // Phase 1 patched the double-dismiss by making UserMenu skip Escape while the nav was
    // open. That guard is gone; the ordering now does the work, so the outcome must be
    // unchanged — menu first, nav second.
    const h = await mount();
    try {
      h.store.setNavExpanded(true);
      h.store.setAccountMenuOpen(true);
      await flush();
      escape();
      await flush();
      expect(h.store.state.accountMenuOpen).toBe(false);
      expect(h.store.state.navExpanded).toBe(true);
      escape();
      await flush();
      expect(h.store.state.navExpanded).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it('registers the expanded nav as a layer and removes it on collapse', async () => {
    const h = await mount();
    try {
      expect(h.store.state.layers).toHaveLength(0);
      h.store.setNavExpanded(true);
      await flush();
      expect(h.store.state.layers.map((l) => l.kind)).toEqual(['dialog']);
      h.store.setNavExpanded(false);
      await flush();
      expect(h.store.state.layers, 'the layer outlived its surface').toHaveLength(0);
    } finally {
      h.dispose();
    }
  });
});

describe('opening a dialog over a transient does not strand focus outside it', () => {
  it('leaves focus INSIDE the dialog when it supersedes the account menu', async () => {
    // The ordering bug the round-3 review found: `useLayer` focused the new dialog BEFORE
    // registering it, and registration synchronously supersedes open transients — whose
    // dismissal restores focus to their own trigger. So the dialog was focused and then
    // immediately had focus yanked back out to the account-menu button behind it.
    //
    // Registration now happens first, so the supersession has already settled by the time
    // the dialog takes focus.
    const h = await mount();
    try {
      h.store.setAccountMenuOpen(true);
      await flush();
      const trigger = h.host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
      trigger?.focus();
      expect(document.activeElement, 'fixture precondition: focus starts on the menu').toBe(
        trigger,
      );

      h.store.openModal('newAgent');
      await flush();

      const card = h.host.querySelector<HTMLElement>('.modal-card');
      expect(card, 'modal did not open').not.toBeNull();
      // The menu is superseded…
      expect(h.store.state.accountMenuOpen).toBe(false);
      // …and focus is in the dialog, NOT back on the trigger it restored to.
      expect(
        card?.contains(document.activeElement) || document.activeElement === card,
        'focus was stranded outside the dialog by the superseded menu restoring its trigger',
      ).toBe(true);
    } finally {
      h.dispose();
    }
  });
});
