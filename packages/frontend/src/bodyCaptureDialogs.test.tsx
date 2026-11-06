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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ApiError, type BodyCaptureStatus } from './data/api';
import { createAppStore, TOAST_MS, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient, type FakeOptions } from './test/fakeClient';
import { labelText } from './test/labelText';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

async function openSettings(opts: FakeOptions = {}): Promise<{
  host: HTMLElement;
  store: AppStore;
  client: FakeApiClient;
  dispose: () => void;
}> {
  const client = new FakeApiClient(opts);
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
  store.go('settings');
  await flush();
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

// ── adopt-red-destructive-actions task 4.4 (D3 / D6 / D7) ─────────────────────────────────────
//
// Purge all bodies and keep-or-purge are destructive: they ask in the shared destructive
// confirmation, with the red commit. Enabling capture asks for consent, which is not loss: that
// dialog keeps its own markup and its primary commit. Keep-forever retention stays a native
// prompt (consent), so `confirm` is stubbed here only to prove the destructive paths never call it.

const CAPTURING: BodyCaptureStatus = {
  mode: 'all',
  retentionDays: 30,
  droppedCount: 0,
  lastPurgeAt: null,
  lastPurgeCount: 0,
  available: true,
  agents: [],
};

/** A gate the test opens: a held request waits on it, then runs the real fake. */
function gate(): { wait: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  return { wait, release };
}
/** Hold the capture-mode write until released. */
function holdUpdate(client: FakeApiClient) {
  const g = gate();
  const real = client.bodyCaptureUpdate.bind(client);
  const spy = vi
    .spyOn(client, 'bodyCaptureUpdate')
    .mockImplementation((patch) => g.wait.then(() => real(patch)));
  return { spy, release: g.release };
}
/** Hold the purge until released. */
function holdPurge(client: FakeApiClient) {
  const g = gate();
  const real = client.bodyCapturePurge.bind(client);
  const spy = vi
    .spyOn(client, 'bodyCapturePurge')
    .mockImplementation(() => g.wait.then(() => real()));
  return { spy, release: g.release };
}

const keepOrPurge = (host: HTMLElement): HTMLElement | null =>
  host.querySelector<HTMLElement>('[aria-label="Disable body capture"]');
const buttonIn = (scope: ParentNode, label: string): HTMLButtonElement =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => labelText(b) === label)!;

/** Choose "Off" on the mode radio, focused first as a keyboard user's would be. */
async function turnOff(
  host: HTMLElement,
): Promise<{ dialog: HTMLElement; radio: HTMLInputElement }> {
  const radio = captureCard(host).querySelectorAll<HTMLInputElement>('input[type=radio]')[0]!;
  radio.focus();
  radio.click();
  await flush();
  const dialog = keepOrPurge(host);
  if (!dialog) throw new Error('the keep-or-purge dialog did not open');
  return { dialog, radio };
}

describe('Purge all bodies and keep-or-purge ask in the shared destructive dialog', () => {
  it('marks only the destructive controls: Purge all bodies, Purge now; not the radio or Keep until retention', async () => {
    const h = await openSettings({ bodyCaptureStatus: CAPTURING });
    try {
      const card = captureCard(h.host);
      expect(buttonIn(card, 'Purge all bodies').className).toBe('btn-ghost btn-ghost--destructive');
      const { dialog, radio } = await turnOff(h.host);
      expect(radio.className, 'the mode radio carries a class').toBe('');
      expect(
        card.querySelector('label .btn-ghost--destructive, input.btn-ghost--destructive'),
      ).toBeNull();
      expect(buttonIn(dialog, 'Purge now').className).toBe('btn-destructive');
      expect(buttonIn(dialog, 'Keep until retention').className).toBe('btn-cancel');
      expect(dialog.querySelector('.btn-primary'), 'an indigo primary in keep-or-purge').toBeNull();
    } finally {
      h.dispose();
    }
  });

  it('keep-or-purge keeps its name, names turning capture off, and states each choice without overpromising', async () => {
    const h = await openSettings({ bodyCaptureStatus: CAPTURING });
    try {
      const { dialog } = await turnOff(h.host);
      expect(dialog.getAttribute('aria-label')).toBe('Disable body capture');
      expect(dialog.querySelector('.section-title')?.textContent).toBe('Turn body capture off?');
      const body = dialog.querySelector('.t-dense')?.textContent ?? '';
      expect(body).toContain('Purge now deletes every stored body');
      expect(body).toContain('Keep until retention leaves them until they expire');
      expect(body).not.toMatch(/immediately/i);
      const order = [...dialog.querySelectorAll<HTMLButtonElement>('button')].map((b) =>
        labelText(b),
      );
      expect(order).toEqual(['Cancel', 'Keep until retention', 'Purge now']);
      expect(document.activeElement, 'Cancel holds the initial focus').toBe(
        buttonIn(dialog, 'Cancel'),
      );
    } finally {
      h.dispose();
    }
  });

  it('Purge now stays busy until capture is off AND the bodies are purged', async () => {
    const h = await openSettings({ bodyCaptureStatus: CAPTURING });
    const update = holdUpdate(h.client);
    const purge = holdPurge(h.client);
    try {
      const { dialog } = await turnOff(h.host);
      const commit = buttonIn(dialog, 'Purge now');
      commit.click();
      await flush();
      expect(keepOrPurge(h.host)).toBe(dialog);
      expect(commit.disabled).toBe(true);
      expect(commit.getAttribute('aria-busy')).toBe('true');
      expect(update.spy).toHaveBeenCalledTimes(1);
      expect(purge.spy, 'the purge started before capture was off').not.toHaveBeenCalled();

      update.release();
      await flush();
      expect(purge.spy).toHaveBeenCalledTimes(1);
      expect(keepOrPurge(h.host), 'closed before the purge settled').toBe(dialog);
      expect(commit.disabled).toBe(true);

      purge.release();
      await flush();
      expect(keepOrPurge(h.host)).toBeNull();
      expect(captureCard(h.host).textContent).toContain('Metadata-only');
    } finally {
      h.dispose();
    }
  });

  it('Purge now stays open with an alert when turning capture off fails, and purges nothing', async () => {
    const h = await openSettings({ bodyCaptureStatus: CAPTURING });
    vi.spyOn(h.client, 'bodyCaptureUpdate').mockRejectedValueOnce(
      new ApiError(503, 'Unavailable', 'capture settings are read-only'),
    );
    try {
      const { dialog } = await turnOff(h.host);
      buttonIn(dialog, 'Purge now').click();
      await flush();
      expect(keepOrPurge(h.host)).toBe(dialog);
      expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(
        'capture settings are read-only',
      );
      expect(h.client.countOf('bodyCapturePurge')).toBe(0);
      expect(h.store.state.toast).toBeNull();
      expect(h.store.state.bc.error).toBeNull();
    } finally {
      h.dispose();
    }
  });

  it('Purge now stays open with an alert when the purge fails', async () => {
    // A fake clock that also moves with real time: the helpers' flushes still run, and the test
    // can then reach the end of the showing toast's time, when a toast of the other kind raised
    // meanwhile (a failure) would take its turn (dashboard-core "A toast gives its reader time").
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = await openSettings({ bodyCaptureStatus: CAPTURING });
    vi.spyOn(h.client, 'bodyCapturePurge').mockRejectedValueOnce(
      new ApiError(409, 'Conflict', 'a purge is already running'),
    );
    try {
      const { dialog } = await turnOff(h.host);
      buttonIn(dialog, 'Purge now').click();
      await flush();
      expect(keepOrPurge(h.host)).toBe(dialog);
      expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(
        'a purge is already running',
      );
      for (const b of dialog.querySelectorAll<HTMLButtonElement>('button')) {
        expect(b.disabled, labelText(b)).toBe(false);
      }
      // The failure is reported in the dialog and nowhere else: no failure toast, no card error.
      // Turning capture off did succeed before the purge failed, and its own confirmation says
      // so (task 3.2 keeps each method's success toast), as the card behind now does.
      expect(h.store.state.toast, 'the purge failure was reported outside the dialog').toEqual({
        kind: 'confirm',
        text: 'Body capture off',
      });
      expect(h.store.state.bc.error).toBeNull();
      expect(captureCard(h.host).textContent).toContain('Metadata-only');
      // Nothing was queued behind it either: when its time is up, no failure takes its place.
      await vi.advanceTimersByTimeAsync(TOAST_MS.confirm);
      expect(h.store.state.toast, 'a failure toast was waiting its turn').toBeNull();
      expect(keepOrPurge(h.host), 'the dialog closed meanwhile').toBe(dialog);
    } finally {
      h.dispose();
      vi.useRealTimers();
    }
  });

  it('Keep until retention turns capture off, sends no purge, and closes', async () => {
    const h = await openSettings({ bodyCaptureStatus: CAPTURING });
    const update = holdUpdate(h.client);
    try {
      const { dialog } = await turnOff(h.host);
      const keep = buttonIn(dialog, 'Keep until retention');
      keep.click();
      await flush();
      // Busy on its own progressive label, every action disabled, the commit at rest.
      expect(keep.querySelector('[data-shown="true"]')?.textContent).toBe('Turning off…');
      for (const b of dialog.querySelectorAll<HTMLButtonElement>('button')) {
        expect(b.disabled, labelText(b)).toBe(true);
      }
      expect(labelText(dialog.querySelector('button.btn-destructive')!)).toBe('Purge now');
      expect(keepOrPurge(h.host)).toBe(dialog);
      update.release();
      await flush();
      const updates = h.client.callLog.filter((c) => c.method === 'bodyCaptureUpdate');
      expect(updates.map((c) => c.args[0])).toEqual([{ mode: 'off' }]);
      expect(h.client.callLog.some((c) => c.method === 'bodyCapturePurge')).toBe(false);
      expect(keepOrPurge(h.host)).toBeNull();
      expect(captureCard(h.host).textContent).toContain('Metadata-only');
    } finally {
      h.dispose();
    }
  });

  it('Keep until retention, rejected: stays open with an alert, actions enabled again, no toast, no purge', async () => {
    const h = await openSettings({ bodyCaptureStatus: CAPTURING });
    vi.spyOn(h.client, 'bodyCaptureUpdate').mockRejectedValueOnce(
      new ApiError(503, 'Unavailable', 'capture settings are read-only'),
    );
    try {
      const { dialog } = await turnOff(h.host);
      buttonIn(dialog, 'Keep until retention').click();
      await flush();
      expect(keepOrPurge(h.host)).toBe(dialog);
      const alert = dialog.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain('capture settings are read-only');
      expect(alert?.textContent).toContain('Keep until retention failed');
      for (const b of dialog.querySelectorAll<HTMLButtonElement>('button')) {
        expect(b.disabled, labelText(b)).toBe(false);
      }
      expect(h.store.state.toast).toBeNull();
      expect(h.client.callLog.some((c) => c.method === 'bodyCapturePurge')).toBe(false);
      expect(captureCard(h.host).textContent).toContain('Bodies captured');
    } finally {
      h.dispose();
    }
  });

  it('Purge all bodies asks first: declining sends nothing, accepting purges once', async () => {
    const nativeConfirm = vi.fn(() => true);
    vi.stubGlobal('confirm', nativeConfirm);
    const h = await openSettings({ bodyCaptureStatus: CAPTURING });
    try {
      const open = async (): Promise<HTMLElement> => {
        const trigger = buttonIn(captureCard(h.host), 'Purge all bodies');
        trigger.focus();
        trigger.click();
        await flush();
        const dialog = h.host.querySelector<HTMLElement>('[role="dialog"].confirm-card');
        expect(dialog, 'Purge all bodies opened no dialog').not.toBeNull();
        return dialog!;
      };
      let dialog = await open();
      expect(dialog.getAttribute('aria-label')).toBe('Delete all stored bodies?');
      expect(dialog.querySelector('.t-dense')?.textContent).toBe(
        'Every stored request and response body is deleted. The request log keeps its metadata.',
      );
      buttonIn(dialog, 'Cancel').click();
      await flush();
      expect(h.client.countOf('bodyCapturePurge')).toBe(0);

      dialog = await open();
      const commit = buttonIn(dialog, 'Purge all bodies');
      expect(commit.className).toBe('btn-destructive');
      commit.click();
      commit.click();
      await flush();
      expect(h.client.countOf('bodyCapturePurge')).toBe(1);
      expect(h.host.querySelector('[role="dialog"].confirm-card')).toBeNull();
      // The status reload re-created the card's controls: focus lands on its heading (D8).
      expect(document.activeElement?.textContent?.trim()).toBe('Prompt & response bodies');
      expect(document.activeElement?.getAttribute('tabindex')).toBe('-1');
      expect(nativeConfirm, 'the native confirm prompt was shown').not.toHaveBeenCalled();
    } finally {
      h.dispose();
    }
  });

  it('the consent dialog commits with the primary button and carries no destructive treatment', async () => {
    const h = await openSettings();
    try {
      const dialog = await openConfirm(h.host);
      expect(buttonIn(dialog, 'Capture bodies').className).toBe('btn-primary');
      expect(dialog.querySelector('.btn-destructive, .btn-ghost--destructive')).toBeNull();
    } finally {
      h.dispose();
    }
  });

  it('keep-or-purge traps focus, closes on Escape, and restores focus, as the consent dialog does', async () => {
    const h = await openSettings({ bodyCaptureStatus: CAPTURING });
    try {
      const { dialog, radio } = await turnOff(h.host);
      expect(h.store.state.layers.map((l) => l.kind)).toEqual(['dialog']);
      const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')];
      buttons[buttons.length - 1]!.focus();
      const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      document.activeElement?.dispatchEvent(tab);
      await flush();
      expect(tab.defaultPrevented, 'Tab escaped the dialog into the page behind').toBe(true);
      expect(dialog.contains(document.activeElement)).toBe(true);

      escape();
      await flush();
      expect(keepOrPurge(h.host)).toBeNull();
      expect(h.store.state.layers).toHaveLength(0);
      expect(document.activeElement, 'focus did not return to the radio').toBe(radio);
      // Dismissed: nothing was sent, and capture is still on.
      expect(h.client.countOf('bodyCaptureUpdate')).toBe(0);
      expect(captureCard(h.host).textContent).toContain('Bodies captured');
    } finally {
      h.dispose();
    }
  });

  it('the consent dialog restores focus to the radio that opened it', async () => {
    const h = await openSettings();
    try {
      const radio = captureCard(h.host).querySelectorAll<HTMLInputElement>('input[type=radio]')[2]!;
      radio.focus();
      radio.click();
      await flush();
      expect(h.host.querySelector('[aria-label="Confirm body capture"]')).not.toBeNull();
      escape();
      await flush();
      expect(document.activeElement).toBe(radio);
    } finally {
      h.dispose();
    }
  });
});
