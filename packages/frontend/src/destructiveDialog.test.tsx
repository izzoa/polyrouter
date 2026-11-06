/**
 * The shared destructive confirmation (adopt-red-destructive-actions tasks 3.1 and 3.3,
 * design.md D6 / D8; dashboard-core "Destructive actions are consistent and confirmed" and
 * "A destructive confirmation holds while busy and reports failure in place").
 *
 * The real App is mounted on a fake client, so the dialog is the one the shell mounts and the
 * keyboard reaches it through the real layer arbiter. Requests are opened through the store,
 * from a fixture trigger outside the app's pages, so each contract below is held on a request
 * the test controls: its copy, its fallback, and a `run` the test settles, so the busy state is
 * observed while the request is genuinely in flight. The call sites themselves open the same
 * dialog, and are driven through their real triggers elsewhere: `destructiveTriggers.view.test.tsx`
 * (every trigger), the page and card suites (`coherence`, `userAdmin`, `unlistedModels`,
 * `batchesPage`, `bodyCaptureDialogs`, `inspectorPayload.view`), and the browser sweeps of the
 * `confirm:*` surfaces.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { App } from './App';
import { STRAY_PRESS_MS } from './components/ConfirmDialog';
import { createAppStore, type AppStore, type DestructiveRequest } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';

const css = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8');

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
};

interface Harness {
  store: AppStore;
  /** Where the fixture triggers live: outside the app's own tree, in the document. */
  fixture: HTMLElement;
}

let dispose: (() => void) | undefined;
let sheet: HTMLStyleElement;
/** The clock the dialog reads its presses against (`performance.now`), moved by the test. */
let now = 0;
/** When the latest dialog opened, on that clock. */
let openedAt = 0;

beforeEach(() => {
  sheet = document.createElement('style');
  sheet.textContent = css;
  document.head.appendChild(sheet);
  now = 1_000_000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  sheet.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function mount(): Promise<Harness> {
  const store = createAppStore(new FakeApiClient());
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
  expect(store.state.authView, 'the shell did not mount').toBe('ready');
  const fixture = document.createElement('section');
  document.body.appendChild(fixture);
  return { store, fixture };
}

/** A `run` the test settles: pending until `resolve` or `reject`. */
interface Pending {
  run: Mock<() => Promise<void>>;
  resolve: () => Promise<void>;
  reject: (reason: unknown) => Promise<void>;
}
function pending(): Pending {
  let settle: { ok: () => void; fail: (e: unknown) => void } | undefined;
  const run = vi.fn(
    () =>
      new Promise<void>((ok, fail) => {
        settle = { ok, fail };
      }),
  );
  return {
    run,
    resolve: async () => {
      settle?.ok();
      await flush();
    },
    reject: async (reason) => {
      settle?.fail(reason);
      await flush();
    },
  };
}

const AGENT: Omit<DestructiveRequest, 'run' | 'fallbackFocus'> = {
  title: 'Delete agent "ci-bot"?',
  body: 'New requests with its key will be refused.',
  commitLabel: 'Delete agent',
  busyLabel: 'Deleting…',
};

/** A fixture trigger that opens `request` the way a page's click handler will: focused, then
 * activated, then the store asked. */
async function open(
  h: Harness,
  request: Partial<DestructiveRequest> = {},
  parent: HTMLElement = h.fixture,
): Promise<{ trigger: HTMLButtonElement; run: Pending; fallback: Mock<() => HTMLElement | null> }> {
  const run = pending();
  const fallback = vi.fn((): HTMLElement | null => null);
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.textContent = 'Delete';
  trigger.addEventListener('click', () =>
    h.store.confirmDestructive({ ...AGENT, run: run.run, fallbackFocus: fallback, ...request }),
  );
  parent.appendChild(trigger);
  trigger.focus();
  openedAt = now;
  trigger.click();
  await flush();
  return { trigger, run, fallback };
}

const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"]');
const dialogs = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
const actions = (): HTMLButtonElement[] => [
  ...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? []),
];

/** The label a button shows: the showing item of its stacked label, or its own text. */
function shown(b: HTMLElement): string {
  const cell = b.querySelector(':scope .stacked-label');
  if (!cell) return (b.textContent ?? '').trim();
  const items = [...cell.querySelectorAll<HTMLElement>(':scope > .stacked-label-item')];
  return items.find((i) => getComputedStyle(i).visibility !== 'hidden')?.textContent?.trim() ?? '';
}
const action = (label: string): HTMLButtonElement => {
  const b = actions().find((x) => shown(x) === label);
  if (!b) throw new Error(`no "${label}" in the dialog: ${actions().map(shown).join(', ')}`);
  return b;
};
const commit = (): HTMLButtonElement => {
  const b = dialog()?.querySelector<HTMLButtonElement>('button.btn-destructive');
  if (!b) throw new Error('the dialog has no destructive commit');
  return b;
};

const press = (key: string): void => {
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  );
};
/** One press and release, as a pointer makes it: `pointerdown` and `mousedown` where the press
 * began, then the click where it was released, both carrying the sequence's click count
 * (`detail`: 1 for a single click, 2 for the second click of a double-click). A press the user
 * aims at the dialog begins once STRAY_PRESS_MS has passed; with `soon`, it begins 100ms after
 * the dialog opened, as the second press of a double activation on its trigger does. */
function pointerClick(
  target: Element,
  {
    detail = 1,
    pressedOn = target,
    soon = false,
  }: Partial<{
    detail: number;
    pressedOn: Element;
    soon: boolean;
  }> = {},
): void {
  now = soon ? openedAt + 100 : now + STRAY_PRESS_MS + 1;
  pressedOn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  pressedOn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, detail }));
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
}
const scrimOf = (): HTMLElement => {
  const scrim = dialog()?.parentElement;
  expect(scrim?.classList.contains('overlay'), 'the dialog sits on its scrim').toBe(true);
  return scrim!;
};
const clickScrim = (): void => {
  pointerClick(scrimOf());
};
const registered = (store: AppStore): boolean => {
  const root = dialog();
  return root !== null && store.state.layers.some((l) => l.root() === root);
};

describe('the shared destructive confirmation names itself (3.1, D6)', () => {
  it('is named by its title when the request passes no label', async () => {
    const h = await mount();
    await open(h);
    expect(dialog()?.getAttribute('aria-modal')).toBe('true');
    expect(dialog()?.getAttribute('aria-label')).toBe('Delete agent "ci-bot"?');
    expect(dialog()?.textContent).toContain('New requests with its key will be refused.');
  });

  it('is named by the label a request passes, keeping the name selectors key on', async () => {
    const h = await mount();
    await open(h, {
      title: 'Cancel this batch?',
      label: 'Cancel batch',
      commitLabel: 'Cancel batch',
      busyLabel: 'Cancelling…',
      dismissLabel: 'Keep running',
    });
    expect(dialog()?.getAttribute('aria-label')).toBe('Cancel batch');
    expect(dialog()?.textContent).toContain('Cancel this batch?');
  });

  it('is a registered layer, so no surface claims aria-modal unregistered', async () => {
    const h = await mount();
    await open(h);
    expect(registered(h.store), 'the dialog is not a registered layer').toBe(true);
  });

  it('is described by its body, so the consequence is announced with the title on open', async () => {
    const h = await mount();
    await open(h);
    const ids = (dialog()?.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    expect(ids, 'the dialog has no accessible description').toHaveLength(1);
    const described = document.getElementById(ids[0]!);
    expect(described, 'aria-describedby names no element').not.toBeNull();
    expect(dialog()?.contains(described), 'the description is outside the dialog').toBe(true);
    expect(described?.textContent?.trim()).toBe('New requests with its key will be refused.');
  });
});

describe('the dismissing action comes first and holds focus (3.1)', () => {
  it('orders Cancel, then the commit as the red fill, with no indigo primary', async () => {
    const h = await mount();
    await open(h);
    expect(actions().map(shown)).toEqual(['Cancel', 'Delete agent']);
    expect(actions()[0]!.classList.contains('btn-cancel')).toBe(true);
    expect(commit().classList.contains('btn-destructive')).toBe(true);
    expect(dialog()?.querySelector('.btn-primary'), 'an indigo primary in the dialog').toBeNull();
    expect(document.activeElement, 'Cancel takes initial focus').toBe(actions()[0]);
  });

  it('names the dismissing action as the request asks', async () => {
    const h = await mount();
    await open(h, { dismissLabel: 'Keep running' });
    expect(shown(actions()[0]!)).toBe('Keep running');
    expect(document.activeElement).toBe(actions()[0]);
  });

  it('dismisses on Enter at open, sends nothing, and returns focus to the trigger', async () => {
    const h = await mount();
    const { trigger, run } = await open(h);
    const focused = document.activeElement;
    expect(focused).toBe(action('Cancel'));
    // A synthetic keydown has no default action in a browser or here, so the activation Enter
    // performs on the focused button is the click that follows it. The keydown still runs,
    // so a document-level shortcut that committed on Enter would be caught.
    press('Enter');
    (focused as HTMLButtonElement).click();
    await flush();
    expect(run.run).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('dismisses on Escape and on a scrim click while idle', async () => {
    const h = await mount();
    const first = await open(h);
    press('Escape');
    await flush();
    expect(dialog(), 'Escape left the idle dialog open').toBeNull();
    expect(document.activeElement).toBe(first.trigger);

    const second = await open(h);
    clickScrim();
    await flush();
    expect(dialog(), 'a scrim click left the idle dialog open').toBeNull();
    expect(second.run.run).not.toHaveBeenCalled();
    expect(h.store.state.layers).toHaveLength(0);
  });

  it('a click inside the card is not a scrim click', async () => {
    const h = await mount();
    await open(h);
    dialog()!.click();
    await flush();
    expect(dialog()).not.toBeNull();
  });
});

describe('one request, one dialog, one run (3.1)', () => {
  it('ignores a second request while one is open', async () => {
    const h = await mount();
    const first = await open(h);
    const second = pending();
    h.store.confirmDestructive({
      ...AGENT,
      title: 'Delete provider "homelab"?',
      body: 'Its models and routing entries go too.',
      commitLabel: 'Delete provider',
      run: second.run,
      fallbackFocus: () => null,
    });
    await flush();
    expect(dialogs()).toHaveLength(1);
    expect(h.store.state.layers).toHaveLength(1);
    // The first request, whole: its name, its words and its run, not a blend of the two.
    expect(dialog()?.getAttribute('aria-label')).toBe('Delete agent "ci-bot"?');
    expect(dialog()?.querySelector('.section-title')?.textContent).toBe('Delete agent "ci-bot"?');
    expect(dialog()?.textContent).toContain('New requests with its key will be refused.');
    expect(shown(commit())).toBe('Delete agent');
    commit().click();
    await flush();
    expect(first.run.run).toHaveBeenCalledTimes(1);
    expect(second.run).not.toHaveBeenCalled();
  });

  it('runs the commit once for a double activation, and ignores a request while busy', async () => {
    const h = await mount();
    const { run } = await open(h);
    commit().click();
    commit().click();
    await flush();
    expect(run.run).toHaveBeenCalledTimes(1);

    h.store.confirmDestructive({
      ...AGENT,
      title: 'Delete provider "homelab"?',
      run: vi.fn(() => Promise.resolve()),
      fallbackFocus: () => null,
    });
    await flush();
    expect(dialogs()).toHaveLength(1);
    expect(dialog()?.getAttribute('aria-label')).toBe('Delete agent "ci-bot"?');
    await run.resolve();
    expect(run.run).toHaveBeenCalledTimes(1);
  });

  it('opens a new request once the first has closed', async () => {
    const h = await mount();
    await open(h);
    action('Cancel').click();
    await flush();
    await open(h, { title: 'Delete budget "Monthly cap"?' });
    expect(dialog()?.getAttribute('aria-label')).toBe('Delete budget "Monthly cap"?');
  });
});

// Every trigger opens the dialog in the same task as its click, so the second press of a
// double-click (or the second tap of a double-tap) on it lands on whatever the dialog now puts
// under the pointer: the commit, on a bottom sheet, or the scrim. It is not a choice made in the
// dialog (ADDED "A double activation sends one request"). Two signs mark it, held apart below
// because engines differ (measured with Playwright): it begins within STRAY_PRESS_MS of the
// dialog opening, and Chromium also counts it 2 while WebKit and Firefox count a second tap 1.
// The rendered regression, at a phone size where a row's Delete sits under the sheet's commit,
// is in `browser/destructiveButtons.spec.ts`.
describe('a press that belongs to the activation that opened the dialog is not a choice made in it', () => {
  it('ignores a press that begins as the dialog opens, whatever its click count', async () => {
    const h = await mount();
    const { run } = await open(h);
    // The second tap of a double-tap, counted afresh (WebKit, Firefox), and a double-click's
    // second click (Chromium), on every action and the scrim.
    pointerClick(commit(), { soon: true });
    pointerClick(commit(), { detail: 2, soon: true });
    pointerClick(action('Cancel'), { soon: true });
    pointerClick(scrimOf(), { soon: true });
    await flush();
    expect(run.run, 'a stray press ran the commit').not.toHaveBeenCalled();
    expect(dialogs(), 'a stray press dismissed the dialog').toHaveLength(1);

    // A press the user aims at the dialog, later, commits.
    pointerClick(commit());
    await flush();
    expect(run.run).toHaveBeenCalledTimes(1);
  });

  it('ignores a later click that continues a sequence begun before the dialog opened', async () => {
    // A slow double-click, under a long system double-click time: past the window, but the
    // engine still counts it 2, and no sequence has begun inside the dialog.
    const h = await mount();
    const { run } = await open(h);
    pointerClick(commit(), { detail: 2 });
    pointerClick(action('Cancel'), { detail: 2 });
    pointerClick(scrimOf(), { detail: 2 });
    pointerClick(commit(), { detail: 3 });
    await flush();
    expect(run.run, 'a continued sequence ran the commit').not.toHaveBeenCalled();
    expect(dialogs(), 'a continued sequence dismissed the dialog').toHaveLength(1);
  });

  it('ignores them on a secondary action too', async () => {
    const h = await mount();
    const keep = pending();
    const { run } = await open(h, {
      secondary: { label: 'Keep until retention', busyLabel: 'Turning off…', run: keep.run },
    });
    pointerClick(action('Keep until retention'), { soon: true });
    pointerClick(action('Keep until retention'), { detail: 2 });
    await flush();
    expect(keep.run).not.toHaveBeenCalled();
    expect(run.run).not.toHaveBeenCalled();
    expect(dialogs()).toHaveLength(1);
  });

  it('counts a quick second click of the dialog’s own sequence: a retry after a failure', async () => {
    const h = await mount();
    const { run } = await open(h);
    pointerClick(commit());
    await flush();
    await run.reject(new Error('the agent is still referenced by a budget'));
    expect(dialog()?.querySelector('[role="alert"]')).not.toBeNull();
    pointerClick(commit(), { detail: 2 });
    await flush();
    expect(run.run, 'the retry was taken for a stray click').toHaveBeenCalledTimes(2);
  });

  it('always takes the keyboard: an activation with no click count', async () => {
    const h = await mount();
    const { run } = await open(h);
    // Enter or Space on a focused button clicks it with a count of 0, whenever it comes.
    commit().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    await flush();
    expect(run.run).toHaveBeenCalledTimes(1);
  });

  it('is not dismissed by a press that began in the card and was released over the scrim', async () => {
    const h = await mount();
    const { run } = await open(h);
    const body = dialog()!.querySelector('.t-dense')!;
    pointerClick(scrimOf(), { pressedOn: body });
    await flush();
    expect(dialog(), 'a selection dragged out of the card dismissed it').not.toBeNull();
    // The same click, pressed on the scrim, dismisses.
    clickScrim();
    await flush();
    expect(dialog()).toBeNull();
    expect(run.run).not.toHaveBeenCalled();
  });
});

describe('a busy confirmation holds (ADDED "holds while busy and reports failure in place")', () => {
  it('shows the busy label, disables every action and refuses Escape and the scrim', async () => {
    const h = await mount();
    const { run } = await open(h);
    commit().click();
    await flush();

    expect(run.run).toHaveBeenCalledTimes(1);
    expect(shown(commit()), 'the commit reads its progressive label').toBe('Deleting…');
    expect(commit().getAttribute('aria-busy')).toBe('true');
    // Both labels stay in the one cell, so the commit keeps its width.
    expect(
      [...commit().querySelectorAll('.stacked-label > .stacked-label-item')].map((i) =>
        i.textContent?.trim(),
      ),
    ).toEqual(['Delete agent', 'Deleting…']);
    for (const b of actions()) expect(b.disabled, `${shown(b)} is not disabled`).toBe(true);

    press('Escape');
    await flush();
    expect(dialog(), 'Escape dismissed a busy dialog').not.toBeNull();
    expect(registered(h.store), 'a refusing layer left the ordering').toBe(true);
    clickScrim();
    await flush();
    expect(dialog(), 'a scrim click dismissed a busy dialog').not.toBeNull();
    action('Cancel').click(); // natively disabled: no click handler runs
    await flush();
    expect(dialog(), 'the dismissing action dismissed a busy dialog').not.toBeNull();
    expect(dialog()?.contains(document.activeElement), 'focus left the busy dialog').toBe(true);

    await run.resolve();
    expect(dialog(), 'the dialog did not close on success').toBeNull();
    expect(h.store.state.layers).toHaveLength(0);
  });

  it('reports a failure inside itself, re-enables, and raises no toast', async () => {
    const h = await mount();
    const say = vi.spyOn(h.store, 'say');
    const sayFailure = vi.spyOn(h.store, 'sayFailure');
    const { run } = await open(h);
    // Activated from the keyboard: focus is on the commit when it is pressed.
    commit().focus();
    commit().click();
    await flush();
    expect(dialog()?.contains(document.activeElement), 'focus left the busy dialog').toBe(true);
    await run.reject(new Error('the agent is still referenced by a budget'));

    expect(dialog(), 'a failed commit closed the dialog').not.toBeNull();
    const alert = dialog()?.querySelector('[role="alert"]');
    expect(alert, 'no alert inside the dialog').not.toBeNull();
    expect(alert?.textContent).toContain('the agent is still referenced by a budget');
    expect(alert?.textContent).toContain('Delete agent failed');
    for (const b of actions()) expect(b.disabled, `${shown(b)} stayed disabled`).toBe(false);
    expect(commit().getAttribute('aria-busy')).toBeNull();
    expect(shown(commit())).toBe('Delete agent');
    expect(document.activeElement, 'focus did not return to the commit').toBe(commit());
    expect(say).not.toHaveBeenCalled();
    expect(sayFailure).not.toHaveBeenCalled();
    expect(h.store.state.toast).toBeNull();
    // The toast's alert region is always mounted; it must stay empty.
    const elsewhere = [...document.querySelectorAll('[role="alert"]')].filter(
      (a) => !dialog()!.contains(a) && (a.textContent ?? '').trim() !== '',
    );
    expect(elsewhere.map((a) => a.textContent)).toEqual([]);

    // A retry runs again, clears the stale alert while it works, and closes on success.
    commit().click();
    await flush();
    expect(run.run).toHaveBeenCalledTimes(2);
    expect(dialog()?.querySelector('[role="alert"]'), 'the stale alert stayed').toBeNull();
    await run.resolve();
    expect(dialog()).toBeNull();
  });

  it('names an unexplained rejection rather than showing an empty alert', async () => {
    const h = await mount();
    const { run } = await open(h);
    commit().click();
    await flush();
    await run.reject('nope');
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain('Unexpected error');
  });
});

describe('a secondary action takes the same busy and failure path (3.1)', () => {
  const KEEP = {
    title: 'Turn body capture off?',
    label: 'Disable body capture',
    body: 'New requests will no longer be captured.',
    commitLabel: 'Purge now',
    busyLabel: 'Purging…',
  };

  async function openWithSecondary(h: Harness) {
    const keep = pending();
    const opened = await open(h, {
      ...KEEP,
      secondary: { label: 'Keep until retention', busyLabel: 'Turning off…', run: keep.run },
    });
    return { ...opened, keep };
  }

  it('sits between the dismissing action and the commit, as a 32px Secondary button', async () => {
    const h = await mount();
    await openWithSecondary(h);
    expect(actions().map(shown)).toEqual(['Cancel', 'Keep until retention', 'Purge now']);
    expect(action('Keep until retention').classList.contains('btn-cancel')).toBe(true);
    expect(action('Keep until retention').classList.contains('btn-ghost')).toBe(false);
    expect(document.activeElement).toBe(action('Cancel'));
  });

  it('holds while its run is pending, and the commit cannot start meanwhile', async () => {
    const h = await mount();
    const { run, keep } = await openWithSecondary(h);
    action('Keep until retention').click();
    await flush();
    const secondary = actions()[1]!;
    expect(keep.run).toHaveBeenCalledTimes(1);
    expect(shown(secondary)).toBe('Turning off…');
    expect(secondary.getAttribute('aria-busy')).toBe('true');
    expect(shown(commit()), 'the commit keeps its rest label').toBe('Purge now');
    expect(commit().getAttribute('aria-busy')).toBeNull();
    for (const b of actions()) expect(b.disabled, `${shown(b)} is not disabled`).toBe(true);

    commit().click();
    secondary.click();
    press('Escape');
    clickScrim();
    await flush();
    expect(dialog(), 'a busy secondary let the dialog be dismissed').not.toBeNull();
    expect(run.run, 'the commit started while the secondary was pending').not.toHaveBeenCalled();
    expect(keep.run).toHaveBeenCalledTimes(1);

    await keep.resolve();
    expect(dialog(), 'the dialog did not close on the secondary’s success').toBeNull();
    expect(run.run).not.toHaveBeenCalled();
  });

  it('reports its failure inside the dialog and re-enables the actions', async () => {
    const h = await mount();
    const say = vi.spyOn(h.store, 'say');
    const sayFailure = vi.spyOn(h.store, 'sayFailure');
    const { keep } = await openWithSecondary(h);
    action('Keep until retention').click();
    await flush();
    await keep.reject(new Error('the capture setting could not be saved'));

    expect(dialog()).not.toBeNull();
    const alert = dialog()?.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('the capture setting could not be saved');
    expect(alert?.textContent).toContain('Keep until retention failed');
    for (const b of actions()) expect(b.disabled).toBe(false);
    expect(shown(actions()[1]!)).toBe('Keep until retention');
    expect(say).not.toHaveBeenCalled();
    expect(sayFailure).not.toHaveBeenCalled();
    expect(h.store.state.toast).toBeNull();
  });
});

describe('focus after a commit (3.3, D8)', () => {
  it('lands on the fallback when the commit removed its trigger, never on the body', async () => {
    const h = await mount();
    const heading = document.createElement('h2');
    heading.tabIndex = -1;
    heading.textContent = 'Agents';
    const list = document.createElement('ul');
    const row = document.createElement('li');
    list.appendChild(row);
    h.fixture.append(heading, list);
    const fallback = vi.fn(() => heading);
    const { trigger } = await open(
      h,
      {
        // The delete removes the row, and the trigger with it, before the dialog closes.
        run: () => {
          row.remove();
          return Promise.resolve();
        },
        fallbackFocus: fallback,
      },
      row,
    );
    commit().click();
    await flush();

    expect(trigger.isConnected).toBe(false);
    expect(dialog()).toBeNull();
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(heading);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('returns to the trigger when the commit left it in place, without asking the fallback', async () => {
    const h = await mount();
    const { trigger, run, fallback } = await open(h);
    commit().click();
    await flush();
    await run.resolve();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('applies no fallback to a request the store closed first (a session teardown)', async () => {
    const h = await mount();
    const row = document.createElement('div');
    h.fixture.appendChild(row);
    const { run, fallback } = await open(h, {}, row);
    commit().click();
    await flush();
    // What leaving one's own account does: the store closes the dialog, then the session goes
    // and the page with it, the trigger included. The run settles after all that.
    h.store.closeDestructive();
    await flush();
    expect(dialog()).toBeNull();
    row.remove();
    await run.resolve();
    expect(fallback, 'a fallback took focus from the sign-in gate').not.toHaveBeenCalled();
  });

  it('clears an open request at a sign-out, so the next session never sees it', async () => {
    const h = await mount();
    await open(h);
    await h.store.signOut();
    await flush();
    expect(h.store.state.destructive).toBeNull();
    expect(dialog()).toBeNull();
  });
});
