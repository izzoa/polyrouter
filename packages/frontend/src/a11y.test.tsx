import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { Toggle } from './components/Toggle';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

function mountApp(store: AppStore): { host: HTMLElement; dispose: () => void } {
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
    dispose: () => {
      dispose();
      host.remove();
    },
  };
}

const pressEscape = (): void => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
};

describe('Toggle switch semantics', () => {
  it('is a real switch: role, aria-checked, keyboard-activatable, locked no-op', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const [on, setOn] = createSignal(false);
    const [locked, setLocked] = createSignal(false);
    const dispose = render(
      () => (
        <Toggle on={on()} locked={locked()} label="Toggle demo" onToggle={() => setOn(!on())} />
      ),
      host,
    );
    try {
      const sw = host.querySelector<HTMLButtonElement>('[role="switch"]');
      expect(sw).not.toBeNull();
      if (!sw) return;
      expect(sw.tagName).toBe('BUTTON');
      expect(sw.getAttribute('aria-checked')).toBe('false');
      expect(sw.getAttribute('aria-label')).toBe('Toggle demo');

      sw.click(); // native button: Space/Enter dispatch click
      expect(on()).toBe(true);
      expect(sw.getAttribute('aria-checked')).toBe('true');

      setLocked(true);
      expect(sw.getAttribute('aria-disabled')).toBe('true');
      sw.click();
      expect(on()).toBe(true); // locked activation is a no-op
    } finally {
      dispose();
      host.remove();
    }
  });
});

describe('Dashboard a11y semantics', () => {
  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset['theme'];
  });

  it('toast is a polite status live region', async () => {
    const store = createAppStore(new FakeApiClient());
    const { host, dispose } = mountApp(store);
    try {
      await flush();
      store.setState('toast', 'Key copied');
      await flush();
      const status = host.querySelector('[role="status"]');
      expect(status).not.toBeNull();
      expect(status?.textContent).toContain('Key copied');
    } finally {
      dispose();
    }
  });

  it('form fields are named by real labels (modal + label association)', async () => {
    const store = createAppStore(new FakeApiClient());
    const { host, dispose } = mountApp(store);
    try {
      await flush();
      store.openModal('newAgent');
      await flush();
      const input = host.querySelector<HTMLInputElement>('#f-na-name');
      expect(input).not.toBeNull();
      const label = host.querySelector<HTMLLabelElement>('label[for="f-na-name"]');
      expect(label?.textContent?.trim()).toBe('Name');
      expect(label?.getAttribute('for')).toBe(input?.id);
    } finally {
      dispose();
    }
  });

  it('a busy modal action is natively disabled, blocking keyboard activation', async () => {
    const store = createAppStore(new FakeApiClient());
    const { host, dispose } = mountApp(store);
    try {
      await flush();
      store.openModal('newLimit');
      await flush();
      store.setState('bf', 'busy', true);
      await flush();
      const save = [...host.querySelectorAll<HTMLButtonElement>('.modal-card button')].find(
        (b) => b.textContent?.includes('Saving…') === true,
      );
      expect(save).not.toBeNull();
      expect(save?.disabled).toBe(true);
    } finally {
      dispose();
    }
  });

  it('dialogs are real dialogs and Escape closes topmost-first (modal, then drawer)', async () => {
    const store = createAppStore(new FakeApiClient());
    const { host, dispose } = mountApp(store);
    try {
      await flush();
      // Open the inspector drawer from a recent-request row.
      const row = host.querySelector<HTMLButtonElement>('button.req-row');
      expect(row).not.toBeNull();
      row?.click();
      await flush();
      const drawer = host.querySelector('#inspector-drawer');
      expect(drawer).not.toBeNull();
      expect(drawer?.getAttribute('role')).toBe('dialog');
      expect(drawer?.getAttribute('aria-modal')).toBe('true');
      // Focus moved into the drawer on open.
      expect(drawer?.contains(document.activeElement)).toBe(true);
      expect(row?.getAttribute('aria-expanded')).toBe('true');

      // Open a modal above it.
      store.openModal('newAgent');
      await flush();
      expect(host.querySelector('.modal-card')?.getAttribute('role')).toBe('dialog');

      // First Escape closes only the modal…
      pressEscape();
      await flush();
      expect(host.querySelector('.modal-card')).toBeNull();
      expect(host.querySelector('#inspector-drawer')).not.toBeNull();

      // …second Escape closes the drawer.
      pressEscape();
      await flush();
      expect(host.querySelector('#inspector-drawer')).toBeNull();
    } finally {
      dispose();
    }
  });

  it('a modal above the drawer owns Tab — the suspended drawer never steals focus', async () => {
    const store = createAppStore(new FakeApiClient());
    const { host, dispose } = mountApp(store);
    try {
      await flush();
      host.querySelector<HTMLButtonElement>('button.req-row')?.click();
      await flush();
      store.openModal('newAgent');
      await flush();
      const card = host.querySelector<HTMLElement>('.modal-card');
      expect(card).not.toBeNull();
      // Synthetic Tab never triggers UA focus traversal, so the observable handler
      // behavior is (a) containment and (b) the edge wrap. Without suspension the
      // drawer's loop would preventDefault and yank focus into the drawer.
      for (let i = 0; i < 6; i++) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        await flush();
        expect(card?.contains(document.activeElement)).toBe(true);
      }
      // Edge wrap: from the modal's LAST focusable, Tab wraps to its FIRST — the modal's
      // own loop is live while the drawer's is suspended.
      const focusables = card
        ? [...card.querySelectorAll<HTMLElement>('button:not(:disabled), input, select')]
        : [];
      expect(focusables.length).toBeGreaterThan(1);
      focusables[focusables.length - 1]?.focus();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      await flush();
      expect(document.activeElement).toBe(focusables[0]);
    } finally {
      dispose();
    }
  });

  it('replacing modal content in place (create → key reveal) refocuses the dialog', async () => {
    const store = createAppStore(new FakeApiClient());
    const { host, dispose } = mountApp(store);
    try {
      await flush();
      store.openModal('newAgent');
      await flush();
      store.setState('na', 'name', 'sr-agent');
      const create = [...host.querySelectorAll<HTMLButtonElement>('.modal-card button')].find(
        (b) => b.textContent?.includes('Create & mint key') === true,
      );
      create?.focus();
      create?.click(); // FakeApiClient resolves → modal becomes keyReveal, button unmounts
      await flush();
      const card = host.querySelector<HTMLElement>('.modal-card');
      expect(card?.textContent).toContain('Shown once');
      expect(card?.contains(document.activeElement)).toBe(true); // not dropped on <body>
    } finally {
      dispose();
    }
  });

  it('primary nav is buttons with aria-current on the active page', async () => {
    const store = createAppStore(new FakeApiClient());
    const { host, dispose } = mountApp(store);
    try {
      await flush();
      const current = host.querySelector<HTMLButtonElement>('button.nav-item[aria-current="page"]');
      expect(current).not.toBeNull();
      expect(current?.textContent).toContain('Overview');
    } finally {
      dispose();
    }
  });
});
