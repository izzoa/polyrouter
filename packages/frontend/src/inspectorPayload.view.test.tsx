/**
 * The inspector's payload Delete asks first (adopt-red-destructive-actions task 4.5, design.md
 * D6 / D7 / D8; dashboard-core "The inspector's payload Delete asks first" and "Focus survives
 * the removed trigger").
 *
 * Delete used to remove a request's stored bodies at once, from a red text link. It is now the
 * destructive ghost, and it opens the shared destructive confirmation above the inspector:
 * declining leaves the payload and the inspector as they were, Escape closes only the dialog,
 * and accepting deletes once, after which the Payload section is gone and focus is on the
 * inspector, never the document body. The trigger only opens the dialog, so it carries no busy
 * state of its own: the dialog's commit does.
 */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';
import { labelText } from './test/labelText';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
};

interface Harness {
  host: HTMLElement;
  store: AppStore;
  client: FakeApiClient;
}

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

/** The inspector open on a request with stored bodies, its payload shown. */
async function openPayload(): Promise<Harness> {
  const client = new FakeApiClient();
  const store = createAppStore(client);
  const host = document.createElement('div');
  document.body.appendChild(host);
  dispose = render(
    () => (
      <AppProvider store={store}>
        <App live={false} />
      </AppProvider>
    ),
    host,
  );
  await flush();
  store.go('requests');
  await flush();
  const row = store.state.requestList.find((r) => r.hasBodies);
  expect(row, 'the fixture has no request with stored bodies').toBeDefined();
  store.select(row!.id);
  await flush();
  const show = buttonIn(drawer(host)!, 'Show bodies');
  expect(show, 'the inspector offers no Show bodies').toBeDefined();
  show!.click();
  await flush();
  expect(drawer(host)!.textContent).toContain(`prompt for ${row!.id}`);
  return { host, store, client };
}

const drawer = (host: HTMLElement): HTMLElement | null =>
  host.querySelector<HTMLElement>('#inspector-drawer');
const dialogOf = (host: HTMLElement): HTMLElement | null =>
  host.querySelector<HTMLElement>('[role="dialog"].confirm-card');
const buttonIn = (scope: ParentNode, label: string): HTMLButtonElement | undefined =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => labelText(b) === label);
/** The Payload section's own Delete, inside the inspector. */
const payloadDelete = (host: HTMLElement): HTMLButtonElement | undefined =>
  buttonIn(drawer(host) ?? document.createDocumentFragment(), 'Delete');
const hasPayload = (host: HTMLElement): boolean =>
  [...(drawer(host)?.querySelectorAll('.upper-label') ?? [])].some(
    (l) => l.textContent === 'Payload',
  );

/** Press the payload Delete as a keyboard user would (focused, then activated). */
async function pressDelete(h: Harness): Promise<HTMLElement> {
  const trigger = payloadDelete(h.host);
  expect(trigger, 'the Payload section renders no Delete').toBeDefined();
  trigger!.focus();
  trigger!.click();
  await flush();
  const dialog = dialogOf(h.host);
  expect(dialog, 'Delete opened no confirmation').not.toBeNull();
  return dialog!;
}

const escape = (): void => {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
};

describe('the inspector payload Delete asks first (task 4.5)', () => {
  it('is the destructive ghost, and only opens its confirmation: no busy state of its own', async () => {
    const h = await openPayload();
    const trigger = payloadDelete(h.host)!;
    expect(trigger.className).toBe('btn-ghost btn-ghost--destructive');
    expect(trigger.querySelector('.stacked-label'), 'the trigger kept a busy label').toBeNull();
    const dialog = await pressDelete(h);
    expect(trigger.disabled, 'the trigger went busy').toBe(false);
    expect(trigger.getAttribute('aria-busy')).toBeNull();
    expect(dialog.getAttribute('aria-label')).toBe('Delete this request’s payload?');
    expect(dialog.querySelector('.t-dense')?.textContent).toBe(
      'Its stored request and response bodies are deleted. The request stays in the log.',
    );
    const commit = dialog.querySelector<HTMLButtonElement>('button.btn-destructive')!;
    expect(labelText(commit)).toBe('Delete payload');
    expect(document.activeElement, 'Cancel holds the initial focus').toBe(
      buttonIn(dialog, 'Cancel'),
    );
  });

  it('declining sends no delete, and the inspector stays open with the payload', async () => {
    const nativeConfirm = vi.fn(() => true);
    vi.stubGlobal('confirm', nativeConfirm);
    const h = await openPayload();
    const selected = h.store.state.selId;
    const dialog = await pressDelete(h);
    buttonIn(dialog, 'Cancel')!.click();
    await flush();
    expect(dialogOf(h.host)).toBeNull();
    expect(h.client.countOf('deleteRequestBodies')).toBe(0);
    expect(drawer(h.host), 'declining closed the inspector').not.toBeNull();
    expect(h.store.state.selId).toBe(selected);
    expect(hasPayload(h.host)).toBe(true);
    expect(document.activeElement, 'focus returns to Delete').toBe(payloadDelete(h.host));
    expect(nativeConfirm, 'the native confirm prompt was shown').not.toHaveBeenCalled();
  });

  it('Escape closes only the dialog, not the inspector beneath it', async () => {
    const h = await openPayload();
    const before = h.store.state.layers.length;
    await pressDelete(h);
    expect(h.store.state.layers).toHaveLength(before + 1);
    escape();
    await flush();
    expect(dialogOf(h.host)).toBeNull();
    expect(drawer(h.host), 'Escape closed the inspector too').not.toBeNull();
    expect(h.store.state.layers).toHaveLength(before);
    expect(h.client.countOf('deleteRequestBodies')).toBe(0);
    expect(hasPayload(h.host)).toBe(true);
  });

  it('accepting sends exactly one delete; the Payload section is gone and focus is in the inspector', async () => {
    const nativeConfirm = vi.fn(() => true);
    vi.stubGlobal('confirm', nativeConfirm);
    const h = await openPayload();
    const dialog = await pressDelete(h);
    const commit = dialog.querySelector<HTMLButtonElement>('button.btn-destructive')!;
    commit.click();
    commit.click();
    await flush();
    expect(h.client.countOf('deleteRequestBodies')).toBe(1);
    expect(dialogOf(h.host)).toBeNull();
    expect(hasPayload(h.host), 'the Payload section outlived its bodies').toBe(false);
    expect(drawer(h.host)).not.toBeNull();
    // The trigger went with the section: focus lands on the inspector root (D8), not the body.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(drawer(h.host));
    expect(h.store.state.toast).toEqual({ kind: 'confirm', text: 'Payloads deleted' });
    expect(nativeConfirm, 'the native confirm prompt was shown').not.toHaveBeenCalled();
  });
});

// The confirmation lives at the shell root, above the page that opened it. The page can still
// change beneath it: browser Back is not a click on the inert page. What it would remove is then
// no longer on screen, so an idle confirmation closes with its surface. A busy one has already
// sent its request, so it stays, settles and reports in the dialog (ADDED "holds while busy").
describe('the payload confirmation does not outlive the inspector it was opened from', () => {
  it('closes, sending nothing, when the page changes beneath it (browser Back)', async () => {
    const h = await openPayload();
    await pressDelete(h);
    h.store.go('overview'); // what a Back traversal does: the page changes, the inspector closes
    await flush();
    expect(drawer(h.host)).toBeNull();
    expect(dialogOf(h.host), 'the confirmation outlived its page').toBeNull();
    expect(h.client.countOf('deleteRequestBodies')).toBe(0);
    expect(document.activeElement, 'focus fell to the document body').not.toBe(document.body);
    expect(document.activeElement?.id, 'focus is not on the new page’s title').toBe('page-title');
  });

  it('closes, sending nothing, when a different request is inspected', async () => {
    const h = await openPayload();
    const other = h.store.state.requestList.find((r) => r.id !== h.store.state.selId);
    expect(other, 'the fixture has a second request').toBeDefined();
    await pressDelete(h);
    h.store.select(other!.id);
    await flush();
    expect(dialogOf(h.host), 'the confirmation outlived the request it named').toBeNull();
    expect(h.client.countOf('deleteRequestBodies')).toBe(0);
  });

  it('a busy one stays, settles in place, and leaves focus on the new page, never the body', async () => {
    const h = await openPayload();
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const real = h.client.deleteRequestBodies.bind(h.client);
    const spy = vi
      .spyOn(h.client, 'deleteRequestBodies')
      .mockImplementation((id) => held.then(() => real(id)));
    const dialog = await pressDelete(h);
    dialog.querySelector<HTMLButtonElement>('button.btn-destructive')!.click();
    await flush();
    h.store.go('overview');
    await flush();
    expect(dialogOf(h.host), 'a busy confirmation was dismissed').toBe(dialog);
    release();
    await flush();
    expect(dialogOf(h.host)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(document.activeElement, 'focus fell to the document body').not.toBe(document.body);
    expect(document.activeElement?.id).toBe('page-title');
  });
});
