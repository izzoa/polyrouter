/** The modal contract, enforced (centralize-overlay-layering, group 5).
 *
 * `a11y.ts` used to carry the contract as a COMMENT — "aria-modal must only be claimed on
 * roots wired through this helper" — and two `BodyCaptureCard` dialogs violated it from the
 * day they shipped. A comment two surfaces can break unnoticed is not a contract.
 *
 * The check compares by element IDENTITY, not by count and not by id: either of those is
 * satisfied by a bogus registration. And it runs against surfaces that have actually been
 * OPENED, because walking the pages never renders a conditional dialog — which is precisely
 * how the two body-capture dialogs stayed invisible.
 */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { unregisteredModalSurfaces } from './a11y';
import { App } from './App';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

async function mount(): Promise<{ host: HTMLElement; store: AppStore; dispose: () => void }> {
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
  return {
    host,
    store,
    dispose: () => {
      dispose();
      host.remove();
    },
  };
}

/** The assertion itself, so every fixture below states the same thing. */
function expectEveryModalRegistered(host: HTMLElement, store: AppStore, where: string): void {
  const rogue = unregisteredModalSurfaces(host, store.state.layers);
  expect(
    rogue.map((el) => el.getAttribute('aria-label') ?? el.getAttribute('aria-labelledby') ?? '?'),
    `${where}: claims aria-modal without being a registered layer`,
  ).toEqual([]);
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('every surface claiming aria-modal is a registered layer', () => {
  it('holds with no overlay open', async () => {
    const h = await mount();
    try {
      expectEveryModalRegistered(h.host, h.store, 'no overlay');
    } finally {
      h.dispose();
    }
  });

  it('holds for the inspector drawer', async () => {
    const h = await mount();
    try {
      h.store.go('requests');
      await flush();
      h.host.querySelector<HTMLButtonElement>('button.req-row')?.click();
      await flush();
      expect(h.host.querySelector('.drawer'), 'drawer did not open').not.toBeNull();
      expectEveryModalRegistered(h.host, h.store, 'inspector drawer');
    } finally {
      h.dispose();
    }
  });

  it('holds for a modal', async () => {
    const h = await mount();
    try {
      h.store.openModal('newAgent');
      await flush();
      expect(h.host.querySelector('.modal-card'), 'modal did not open').not.toBeNull();
      expectEveryModalRegistered(h.host, h.store, 'modal');
    } finally {
      h.dispose();
    }
  });

  it('holds for the expanded narrow-width navigation', async () => {
    const h = await mount();
    try {
      h.store.setNavExpanded(true);
      await flush();
      expectEveryModalRegistered(h.host, h.store, 'expanded nav');
    } finally {
      h.dispose();
    }
  });

  it('holds for the body-capture confirm dialog — a CONDITIONAL surface', async () => {
    // Walking the pages never renders this one. It is reachable only mid-flow, which is
    // exactly why it shipped unregistered and nothing noticed for two releases.
    const h = await mount();
    try {
      h.store.go('settings');
      await flush();
      const card = [...h.host.querySelectorAll<HTMLElement>('.panel')].find((p) =>
        p.textContent?.includes('Prompt & response bodies'),
      );
      [...(card?.querySelectorAll<HTMLInputElement>('input[type=radio]') ?? [])][2]?.click();
      await flush();
      expect(
        h.host.querySelector('[aria-label="Confirm body capture"]'),
        'confirm dialog did not open',
      ).not.toBeNull();
      expectEveryModalRegistered(h.host, h.store, 'body-capture confirm');
    } finally {
      h.dispose();
    }
  });

  it('holds for the body-capture DISABLE dialog — the other conditional surface', async () => {
    // The confirm dialog alone is not enough coverage: this one is reached by a different
    // flow, and a check that never opens it cannot see it.
    const h = await mount();
    try {
      h.store.go('settings');
      await flush();
      const card = (): HTMLElement | undefined =>
        [...h.host.querySelectorAll<HTMLElement>('.panel')].find((p) =>
          p.textContent?.includes('Prompt & response bodies'),
        );
      const radios = (): HTMLInputElement[] => [
        ...(card()?.querySelectorAll<HTMLInputElement>('input[type=radio]') ?? []),
      ];

      // Drive the real flow: enabling requires consent, and only once capture is ON does
      // choosing "off" offer the keep-or-purge choice this dialog belongs to.
      radios()[2]?.click();
      await flush();
      const confirm = h.host.querySelector('[aria-label="Confirm body capture"]');
      [...(confirm?.querySelectorAll<HTMLButtonElement>('button.btn-primary') ?? [])][0]?.click();
      await flush();

      radios()[0]?.click();
      await flush();
      expect(
        h.host.querySelector('[aria-label="Disable body capture"]'),
        'disable dialog did not open — a conditional assertion here would be vacuous',
      ).not.toBeNull();
      expectEveryModalRegistered(h.host, h.store, 'body-capture disable');
    } finally {
      h.dispose();
    }
  });

  it('holds with two layers stacked', async () => {
    const h = await mount();
    try {
      h.store.openModal('newAgent');
      h.store.setNavExpanded(true);
      await flush();
      expect(h.store.state.layers.length).toBeGreaterThan(1);
      expectEveryModalRegistered(h.host, h.store, 'stacked');
    } finally {
      h.dispose();
    }
  });
});

describe('the check itself', () => {
  it('FAILS on a surface that claims aria-modal without registering', () => {
    // A check never seen failing is not a check. This is the shape the two body-capture
    // dialogs had: the attributes, and nothing behind them.
    const host = document.createElement('div');
    host.innerHTML = '<div role="dialog" aria-modal="true" aria-label="Rogue"></div>';
    document.body.appendChild(host);
    const rogue = unregisteredModalSurfaces(host, []);
    expect(rogue).toHaveLength(1);
    expect(rogue[0]?.getAttribute('aria-label')).toBe('Rogue');
  });

  it('is not satisfied by a registration pointing at a DIFFERENT element', () => {
    // Identity, not count. Comparing lengths — or ids — would pass here, and this is
    // exactly the bogus-registration case that would make the check decorative.
    const host = document.createElement('div');
    host.innerHTML =
      '<div role="dialog" aria-modal="true" aria-label="Real"></div><div id="other"></div>';
    document.body.appendChild(host);
    const other = host.querySelector<HTMLElement>('#other');
    const rogue = unregisteredModalSurfaces(host, [
      { token: 1, kind: 'dialog', root: () => other ?? undefined, onDismiss: () => {} },
    ]);
    expect(rogue, 'a registration for a different element satisfied the check').toHaveLength(1);
  });
});
