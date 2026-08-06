/** The two body-capture confirmation dialogs (centralize-overlay-layering, group 3).
 *
 * These shipped carrying `role="dialog" aria-modal="true"` and implementing none of it — no
 * focus trap, no Escape, no focus restore. A keyboard user could Tab straight out into the
 * page behind while `aria-modal` told assistive technology the rest of the page was hidden.
 * That violated an already-shipped `dashboard-core` requirement; the contract forbidding it
 * lived in a comment and was enforced by nothing.
 *
 * This is the user-visible half of the change, so it gets behavioural coverage rather than
 * a declaration check.
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

async function openSettings(): Promise<{
  host: HTMLElement;
  store: AppStore;
  dispose: () => void;
}> {
  const store = createAppStore(new FakeApiClient());
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
  store.go('settings');
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

const captureCard = (host: HTMLElement): HTMLElement =>
  [...host.querySelectorAll<HTMLElement>('.panel')].find((p) =>
    p.textContent?.includes('Prompt & response bodies'),
  )!;

/** Open the consent dialog by choosing a capture mode, as a user would. */
async function openConfirm(host: HTMLElement): Promise<HTMLElement> {
  const radios = [...captureCard(host).querySelectorAll<HTMLInputElement>('input[type=radio]')];
  radios[2]?.click(); // "All requests"
  await flush();
  const el = host.querySelector<HTMLElement>('[aria-label="Confirm body capture"]');
  if (!el) throw new Error('confirm dialog did not open');
  return el;
}

const escape = (): void => {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('body-capture confirmation dialogs are real dialogs', () => {
  it('registers as a layer while open, and gives up the registration on close', async () => {
    const h = await openSettings();
    try {
      expect(h.store.state.layers).toHaveLength(0);
      await openConfirm(h.host);
      expect(h.store.state.layers.map((l) => l.kind)).toEqual(['dialog']);

      escape();
      await flush();
      expect(h.store.state.layers, 'the layer outlived the dialog').toHaveLength(0);
    } finally {
      h.dispose();
    }
  });

  it('is dismissed by Escape — it was not, before this change', async () => {
    const h = await openSettings();
    try {
      await openConfirm(h.host);
      escape();
      await flush();
      expect(h.host.querySelector('[aria-label="Confirm body capture"]')).toBeNull();
      // Dismissing consent must NOT enable capture.
      expect(captureCard(h.host).textContent).toContain('Metadata-only');
    } finally {
      h.dispose();
    }
  });

  it('can take focus, so the trap has somewhere to put it', async () => {
    // `aria-modal` without a focusable root is the specific lie this change removes: the
    // Tab loop falls back to focusing the root, which silently does nothing without this.
    const h = await openSettings();
    try {
      const dialog = await openConfirm(h.host);
      expect(dialog.getAttribute('tabindex')).toBe('-1');
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(dialog.getAttribute('role')).toBe('dialog');
    } finally {
      h.dispose();
    }
  });

  it('keeps Tab inside the dialog rather than letting it reach the page behind', async () => {
    const h = await openSettings();
    try {
      const dialog = await openConfirm(h.host);
      const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')];
      expect(buttons.length).toBeGreaterThan(1);
      buttons[buttons.length - 1]?.focus();

      const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      document.activeElement?.dispatchEvent(e);
      await flush();

      expect(e.defaultPrevented, 'Tab escaped the dialog into the page behind').toBe(true);
      expect(dialog.contains(document.activeElement)).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it('is superseded correctly rather than stacking under a later dialog', async () => {
    // A dialog opening supersedes unowned transients; two dialogs stack, and Escape takes
    // the topmost. This pins that the confirm dialog participates in that ordering at all
    // — before, it participated in nothing.
    const h = await openSettings();
    try {
      await openConfirm(h.host);
      expect(h.store.state.layers).toHaveLength(1);
      h.store.setNavExpanded(true);
      await flush();
      expect(h.store.state.layers.map((l) => l.kind)).toEqual(['dialog', 'dialog']);

      escape();
      await flush();
      // The nav registered last, so it is topmost and goes first.
      expect(h.store.state.navExpanded).toBe(false);
      expect(h.host.querySelector('[aria-label="Confirm body capture"]')).not.toBeNull();
    } finally {
      h.dispose();
    }
  });
});
