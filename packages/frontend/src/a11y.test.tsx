import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { FigureSkeleton } from './components/FigureSkeleton';
import { Toggle } from './components/Toggle';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { buildRequestRows, FakeApiClient } from './test/fakeClient';

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

describe('Toggle presentations (split-auto-routing-readout-setup D7)', () => {
  it('on, off, locked and unavailable are distinct classes; unavailable is disabled and inert', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const [on, setOn] = createSignal(false);
    const [locked, setLocked] = createSignal(false);
    const [unavailable, setUnavailable] = createSignal(false);
    let flips = 0;
    const dispose = render(
      () => (
        <Toggle
          on={on()}
          locked={locked()}
          unavailable={unavailable()}
          label="Toggle demo"
          onToggle={() => {
            flips += 1;
          }}
        />
      ),
      host,
    );
    try {
      const sw = host.querySelector<HTMLButtonElement>('[role="switch"]');
      if (!sw) throw new Error('no switch');
      // The track colour is a class, never an inline style the unavailable rule could lose to.
      expect(sw.style.background).toBe('');
      expect(sw.classList.contains('toggle--off')).toBe(true);
      setOn(true);
      expect(sw.classList.contains('toggle--on')).toBe(true);
      expect(sw.classList.contains('toggle--off')).toBe(false);

      // Locked (busy) keeps its on/off look and meaning — Settings channels depend on it.
      setLocked(true);
      expect(sw.classList.contains('toggle--on')).toBe(true);
      expect(sw.classList.contains('toggle--unavailable')).toBe(false);
      expect(sw.getAttribute('aria-disabled')).toBe('true');
      sw.click();
      expect(flips).toBe(0);
      setLocked(false);
      expect(sw.getAttribute('aria-disabled')).toBeNull();

      setUnavailable(true);
      expect(sw.classList.contains('toggle--unavailable')).toBe(true);
      expect(sw.classList.contains('toggle--on')).toBe(false);
      expect(sw.classList.contains('toggle--off')).toBe(false);
      expect(sw.getAttribute('aria-disabled')).toBe('true');
      sw.click();
      expect(flips).toBe(0);

      setUnavailable(false);
      sw.click();
      expect(flips).toBe(1);
    } finally {
      dispose();
      host.remove();
    }
  });
});

/** DESIGN.md Figures and their states → Loading (adopt-figure-states 3.1, D5): a loading
 * figure is a decorative block plus visually hidden `Loading <what>`, so a screen reader hears
 * what is loading, and never a dash, a zero or nothing. */
describe('FigureSkeleton names what it loads', () => {
  it('pairs one decorative block with visually hidden "Loading <what>" text', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const dispose = render(
      () => (
        <span data-testid="slot">
          <FigureSkeleton what="requests" size="count" />
        </span>
      ),
      host,
    );
    try {
      const slot = host.querySelector<HTMLElement>('[data-testid="slot"]')!;
      const block = slot.querySelector<HTMLElement>('.fig-skel');
      expect(block?.getAttribute('aria-hidden')).toBe('true');
      expect(block?.classList.contains('fig-skel-count')).toBe(true);
      expect(block?.textContent).toBe('');
      const hidden = [...slot.querySelectorAll<HTMLElement>('.sr-only')];
      expect(hidden.map((e) => e.textContent)).toEqual(['Loading requests']);
      // What an assistive technology reads: the hidden words, and nothing from the block.
      const spoken = [...slot.childNodes]
        .filter((n) => !(n instanceof HTMLElement && n.getAttribute('aria-hidden') === 'true'))
        .map((n) => n.textContent)
        .join('');
      expect(spoken).toBe('Loading requests');
      expect(slot.textContent).not.toMatch(/—|\b0\b/);
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
      store.say('Key copied');
      await flush();
      const status = host.querySelector('[data-toast-region="confirm"]');
      expect(status?.getAttribute('role')).toBe('status');
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

  it("the inspector's route trace is one ordered list of text, its decoration hidden (add-route-trace-inspector 4.5)", async () => {
    // A recovered request with one failed and one skipped member (dashboard-analytics "The
    // trace reads as an ordered list"). The project has no axe dependency, so the checks are
    // the suite's own: one list, text in walk order, decoration hidden, no control added.
    const base = buildRequestRows(1)[0]!;
    const row = {
      ...base,
      status: 'fallback' as const,
      agentLabel: 'billing-bot',
      decisionLayer: 'explicit',
      providerLabel: 'Provider C',
      modelLabel: 'model-c',
      durationMs: 1_240,
      errorKind: null,
      errorStatus: null,
      errorMessage: null,
      errorRequestId: null,
      errorMarkers: null,
      attemptFailures: [
        {
          index: 0,
          providerId: 'p1',
          model: 'gpt-a',
          kind: 'rate_limit',
          status: 429,
          dispatched: true,
        },
        { index: 1, providerId: 'p2', model: 'gpt-b', kind: 'unavailable', dispatched: false },
      ],
    };
    const store = createAppStore(new FakeApiClient({ requestRows: [row] }));
    const { host, dispose } = mountApp(store);
    try {
      await flush();
      store.go('requests');
      await flush();
      store.select(row.id);
      await flush();
      const drawer = host.querySelector<HTMLElement>('#inspector-drawer');
      expect(drawer).not.toBeNull();
      // The dialog keeps its accessible name.
      expect(drawer!.getAttribute('role')).toBe('dialog');
      expect(drawer!.getAttribute('aria-label')).toBe('Request inspector');
      // One ordered list, whose items read in walk order.
      const lists = drawer!.querySelectorAll('ol');
      expect(lists).toHaveLength(1);
      const ol = lists[0]!;
      // Its markers are removed, and WebKit drops list semantics from a marker-less list, so
      // the role is explicit (the `pages/Routing.tsx` `ar-stages` precedent).
      expect(ol.getAttribute('role')).toBe('list');
      expect(ol.getAttribute('aria-label')).toBe('Route trace');
      const lis = [...ol.querySelectorAll<HTMLElement>(':scope > li')];
      expect(lis.map((li) => li.textContent)).toEqual([
        'billing-bot',
        'router · explicit',
        'gpt-a · rate_limit · HTTP 429',
        'gpt-b · skipped — circuit open (provider not contacted)',
        'Provider C · model-c · served · 1.24s',
      ]);
      // Every stroke, branch and node mark is hidden; no item is, so each outcome is announced.
      for (const li of lis) {
        expect(li.getAttribute('aria-hidden')).toBeNull();
        expect(li.closest('[aria-hidden="true"]')).toBeNull();
        const marks = li.querySelectorAll<HTMLElement>('.rt-spine, .rt-branch, .rt-dot');
        expect(marks.length).toBeGreaterThan(1);
        for (const m of marks) expect(m.getAttribute('aria-hidden')).toBe('true');
        // What is announced is exactly the item's text: the hidden marks hold none.
        const shown = [...li.childNodes]
          .filter((n) => !(n instanceof HTMLElement && n.getAttribute('aria-hidden') === 'true'))
          .map((n) => n.textContent ?? '')
          .join('');
        expect(shown).toBe(li.textContent);
      }
      // The trace adds no control: nothing in it is focusable or operable.
      expect(
        ol.querySelectorAll('button, a, input, select, textarea, [tabindex], [role="button"]'),
      ).toHaveLength(0);
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
