/** Overlay layer arbiter (centralize-overlay-layering, group 1).
 *
 * These drive the arbiter directly rather than through components, so the mechanism is
 * pinned independently of any surface that uses it. The component-level behaviour lives in
 * `a11y.test.tsx` and `navRail.test.tsx`.
 */
import { createRoot, createSignal } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installLayerArbiter,
  layerEntry,
  layerFocus,
  supersededByDialog,
  topLayer,
  useLayer,
  type LayerEntry,
  type LayerKind,
  type LayerKindSource,
  type LayerToken,
} from './a11y';
import { createAppStore, type AppStore } from './state/appState';
import { FakeApiClient } from './test/fakeClient';

let disposes: (() => void)[] = [];
afterEach(() => {
  for (const d of disposes) d();
  disposes = [];
  document.body.innerHTML = '';
});

/** A registry the tests mutate directly, standing in for the store. */
function registry() {
  const layers: LayerEntry[] = [];
  let next = 1;
  const add = (kind: LayerKind, onDismiss = vi.fn()): LayerEntry => {
    const root = document.createElement('div');
    root.tabIndex = -1;
    document.body.appendChild(root);
    const entry: LayerEntry = layerEntry(next++, kind, () => root, onDismiss);
    if (kind === 'dialog') {
      for (const s of supersededByDialog(layers)) s.onDismiss();
    }
    layers.push(entry);
    return entry;
  };
  const remove = (token: number): void => {
    const i = layers.findIndex((l) => l.token === token);
    if (i >= 0) layers.splice(i, 1);
  };
  const install = (): void => {
    disposes.push(installLayerArbiter({ layers: () => layers }));
  };
  return { layers, add, remove, install };
}

const press = (target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};

describe('topmost resolution', () => {
  it('is the most recently registered layer', () => {
    const r = registry();
    const a = r.add('dialog');
    const b = r.add('dialog');
    expect(topLayer(r.layers)?.token).toBe(b.token);
    r.remove(b.token);
    expect(topLayer(r.layers)?.token).toBe(a.token);
  });

  it('ranks a transient above the layer it was opened from', () => {
    // Open order already does this: you open the combobox from inside the dialog, so it
    // registers later. No kind-based ranking is needed, and one would get the next case wrong.
    const r = registry();
    r.add('dialog');
    const popover = r.add('popover');
    expect(topLayer(r.layers)?.token).toBe(popover.token);
  });

  it('supersedes an unrelated transient when a dialog opens', () => {
    // The case a global `popover > dialog` ranking gets backwards: a page-level menu that
    // was already open must not stay above a modal opened afterwards.
    const r = registry();
    const menuDismiss = vi.fn();
    r.add('menu', menuDismiss);
    const dialog = r.add('dialog');
    expect(menuDismiss).toHaveBeenCalledTimes(1);
    expect(topLayer(r.layers)?.token).toBe(dialog.token);
  });

  it('supersedes EVERY open transient when a dialog opens, with no exception', () => {
    // There is no ownership carve-out. A transient opened from inside a dialog cannot be
    // caught by this, because it registers after that dialog and no dialog opens between
    // them; and a menu that launches a dialog closes itself first, as menus do.
    const r = registry();
    const menu = r.add('menu');
    const popover = r.add('popover');
    r.add('dialog');
    expect(menu.onDismiss).toHaveBeenCalledTimes(1);
    expect(popover.onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('removal is by token', () => {
  it('removes a layer from beneath an open one without touching it', () => {
    // A route change can unmount the drawer while a modal is open above it. A pop() would
    // take the modal.
    const r = registry();
    const under = r.add('dialog');
    const over = r.add('dialog');
    r.remove(under.token);
    expect(r.layers.map((l) => l.token)).toEqual([over.token]);
    expect(topLayer(r.layers)?.token).toBe(over.token);
  });

  it('is idempotent', () => {
    const r = registry();
    const a = r.add('dialog');
    r.remove(a.token);
    r.remove(a.token);
    expect(r.layers).toEqual([]);
  });
});

describe('two-phase dispatch', () => {
  it('dismisses only the topmost layer', () => {
    const r = registry();
    const lower = vi.fn();
    const upper = vi.fn();
    r.add('dialog', lower);
    r.add('dialog', upper);
    r.install();
    press(document.body, 'Escape');
    expect(upper).toHaveBeenCalledTimes(1);
    expect(lower).not.toHaveBeenCalled();
  });

  it('does NOT fall through when the top layer closes itself during the event', () => {
    // THE regression this change exists for. `ModelPicker` handles Escape on its own input,
    // so a handler inside the layer runs in the TARGET phase — before a bubbling document
    // listener. A bubbling arbiter would then read the registry after the picker had
    // already unregistered, see the layer beneath, and dismiss it too.
    const r = registry();
    const lower = vi.fn();
    r.add('dialog', lower);
    const top = r.add('popover');
    r.install();

    // A control inside the top layer, closing its own layer on Escape and NOT calling
    // preventDefault — which is exactly what `UserMenu` does today, and exactly the shape
    // of the original double-dismiss. Preventing would let the `defaultPrevented` guard
    // save a naive arbiter too, so this test would pass for the wrong reason and prove
    // nothing about the capture snapshot.
    const inner = document.createElement('input');
    (top.root() as HTMLElement).appendChild(inner);
    inner.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') r.remove(top.token);
    });

    press(inner, 'Escape');
    expect(lower, 'the layer beneath was dismissed by the same keypress').not.toHaveBeenCalled();
  });

  it('does not dispatch when a handler inside the layer consumed the event', () => {
    // This is what lets ModelPicker keep its two-stage Escape: first press closes the popup
    // locally and consumes; the arbiter stays out of it.
    const r = registry();
    const dismiss = vi.fn();
    const top = r.add('popover', dismiss);
    r.install();
    const inner = document.createElement('input');
    (top.root() as HTMLElement).appendChild(inner);
    inner.addEventListener('keydown', (e) => {
      e.preventDefault();
    });
    press(inner, 'Escape');
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('ignores every keypress while an IME composition is active', () => {
    // An Escape ending a composition belongs to the input method. The pre-existing IME
    // fixture covers ArrowDown and Enter only, so Escape and Tab need their own.
    const r = registry();
    const dismiss = vi.fn();
    r.add('dialog', dismiss);
    r.install();
    for (const key of ['Escape', 'Tab']) {
      const e = press(document.body, key, { isComposing: true });
      expect(dismiss, `${key} dismissed a layer while composing`).not.toHaveBeenCalled();
      expect(e.defaultPrevented).toBe(false);
    }
  });

  it('leaves keys other than Escape and Tab alone', () => {
    const r = registry();
    const dismiss = vi.fn();
    r.add('dialog', dismiss);
    r.install();
    const e = press(document.body, 'ArrowDown');
    expect(dismiss).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('Tab policy by kind', () => {
  it('traps Tab for a dialog', () => {
    const r = registry();
    const entry = r.add('dialog');
    const root = entry.root() as HTMLElement;
    const a = document.createElement('button');
    const b = document.createElement('button');
    root.append(a, b);
    r.install();
    b.focus();
    const e = press(b, 'Tab');
    expect(e.defaultPrevented, 'a dialog must wrap Tab rather than let focus leave').toBe(true);
  });

  it('dismisses a menu on Tab and lets focus travel on', () => {
    const r = registry();
    const dismiss = vi.fn();
    r.add('menu', dismiss);
    r.install();
    const e = press(document.body, 'Tab');
    expect(dismiss).toHaveBeenCalledTimes(1);
    // NOT prevented — a menu that trapped Tab would be a dialog, which it is not.
    expect(e.defaultPrevented).toBe(false);
  });

  it('dismisses a popover on Tab without preventing traversal', () => {
    const r = registry();
    const dismiss = vi.fn();
    r.add('popover', dismiss);
    r.install();
    const e = press(document.body, 'Tab');
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('a layer may refuse dismissal and stay in the ordering', () => {
  it('keeps a busy layer registered when its onDismiss declines', () => {
    // A dialog with a mutation in flight refuses Escape. `onDismiss` must not remove its
    // own entry — the arbiter offers, the layer decides — or a refusing dialog would fall
    // out of the ordering and the next Escape would reach the layer beneath it.
    const r = registry();
    const lower = vi.fn();
    r.add('dialog', lower);
    let busy = true;
    const top: LayerEntry = r.add(
      'dialog',
      vi.fn(() => {
        if (busy) return; // refuse
        r.remove(top.token);
      }),
    );
    r.install();

    press(document.body, 'Escape');
    expect(r.layers).toHaveLength(2);
    expect(lower, 'a refused dismissal leaked to the layer beneath').not.toHaveBeenCalled();

    press(document.body, 'Escape');
    expect(r.layers, 'still refusing after the mutation settled').toHaveLength(2);

    busy = false;
    press(document.body, 'Escape');
    expect(r.layers).toHaveLength(1);
    expect(lower).not.toHaveBeenCalled();
  });
});

describe('the docked kind (add-docked-inspector D2)', () => {
  it('Tab on a topmost docked layer is neither prevented nor a dismissal', () => {
    // The panel sits beside a live page: Tab travels on in document order. Preventing it
    // would trap focus like the dialog the panel is not; dismissing would close the panel
    // the user is tabbing through — what every other non-dialog kind does on Tab.
    const r = registry();
    const dismiss = vi.fn();
    const docked = r.add('docked', dismiss);
    const last = document.createElement('button');
    (docked.root() as HTMLElement).appendChild(last);
    r.install();
    last.focus();
    for (const shiftKey of [false, true]) {
      const e = press(last, 'Tab', { shiftKey });
      expect(e.defaultPrevented, 'Tab was trapped inside the docked panel').toBe(false);
    }
    const fromPage = press(document.body, 'Tab');
    expect(fromPage.defaultPrevented).toBe(false);
    expect(dismiss, 'Tab closed the docked panel').not.toHaveBeenCalled();
  });

  it('Escape dismisses a topmost docked layer', () => {
    const r = registry();
    const dismiss = vi.fn();
    r.add('docked', dismiss);
    r.install();
    const e = press(document.body, 'Escape');
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it('registering a dialog leaves a docked layer registered beneath it', () => {
    // Not superseded the way an unrelated menu or popup is: the panel stays open beneath the
    // dialog and resumes when it closes. First Escape the modal, second the panel.
    const r = registry();
    const panelDismiss = vi.fn();
    const panel = r.add('docked', panelDismiss);
    const menu: LayerEntry = r.add(
      'menu',
      vi.fn(() => r.remove(menu.token)),
    );
    expect(supersededByDialog(r.layers).map((l) => l.kind)).toEqual(['menu']);
    const dialog: LayerEntry = r.add(
      'dialog',
      vi.fn(() => r.remove(dialog.token)),
    );
    expect(panelDismiss, 'opening a dialog superseded the docked panel').not.toHaveBeenCalled();
    expect(menu.onDismiss).toHaveBeenCalledTimes(1);
    expect(r.layers.map((l) => l.token)).toEqual([panel.token, dialog.token]);

    r.install();
    press(document.body, 'Escape');
    expect(dialog.onDismiss).toHaveBeenCalledTimes(1);
    expect(panelDismiss, 'one Escape reached two layers').not.toHaveBeenCalled();
    press(document.body, 'Escape');
    expect(panelDismiss).toHaveBeenCalledTimes(1);
  });

  it('a popover registered above a docked layer takes Escape first', () => {
    const r = registry();
    const panelDismiss = vi.fn();
    r.add('docked', panelDismiss);
    const popDismiss = vi.fn();
    r.add('popover', popDismiss);
    r.install();
    press(document.body, 'Escape');
    expect(popDismiss).toHaveBeenCalledTimes(1);
    expect(panelDismiss).not.toHaveBeenCalled();
  });

  it('a docked layer moves no focus when it opens', () => {
    const row = document.createElement('button');
    const root = document.createElement('div');
    root.tabIndex = -1;
    document.body.append(row, root);
    row.focus();
    layerFocus('docked', () => root);
    expect(document.activeElement, 'opening the docked panel took focus').toBe(row);
    // The dialog kind, for contrast: the same call moves focus into the root.
    layerFocus('dialog', () => root);
    expect(document.activeElement).toBe(root);
  });

  it("an entry's kind is a getter over its accessor, read as a value", () => {
    // `state.layers.map((l) => l.kind)` (bodyCaptureDialogs, navRail) and the browser's
    // `page.evaluate` read `kind` as a VALUE; a kind changed in place must reach them.
    const [kind, setKind] = createSignal<LayerKind>('docked');
    const entry = layerEntry(
      7,
      kind,
      () => undefined,
      () => {},
    );
    expect(entry.kind).toBe('docked');
    setKind('dialog');
    expect(entry.kind).toBe('dialog');
    expect(typeof entry.kind).toBe('string');

    const store = createAppStore(new FakeApiClient());
    const token = store.registerLayer({ kind, root: () => undefined, onDismiss: () => {} });
    expect(store.state.layers.map((l) => l.kind)).toEqual(['dialog']);
    setKind('docked');
    expect(store.state.layers.map((l) => l.kind)).toEqual(['docked']);
    expect(store.state.layers.map((l) => l.token)).toEqual([token]);
    expect(JSON.parse(JSON.stringify(store.state.layers.map((l) => ({ kind: l.kind }))))).toEqual([
      { kind: 'docked' },
    ]);
  });
});

/** A layer mounted through the real `useLayer` and the real store registry, opened and
 * closed by a signal — the inspector's crossing is driven by flipping its kind accessor. */
interface Mounted {
  root: HTMLElement;
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
  token: () => LayerToken | undefined;
  index: () => number;
  dismiss: ReturnType<typeof vi.fn>;
}

function mounted(
  store: AppStore,
  kind: LayerKindSource,
  opts: { restoreTo?: () => HTMLElement | null; root?: HTMLElement } = {},
): Mounted {
  const root = opts.root ?? document.createElement('div');
  root.tabIndex = -1;
  if (!root.isConnected) document.body.appendChild(root);
  const [isOpen, setOpen] = createSignal(false);
  const dismiss = vi.fn(() => setOpen(false));
  createRoot((dispose) => {
    disposes.push(dispose);
    useLayer(store, {
      when: isOpen,
      kind,
      root: () => root,
      onDismiss: dismiss,
      ...(opts.restoreTo ? { restoreTo: opts.restoreTo } : {}),
    });
  });
  const token = (): LayerToken | undefined =>
    store.state.layers.find((l) => l.root() === root)?.token;
  return {
    root,
    open: () => setOpen(true),
    close: () => setOpen(false),
    isOpen,
    token,
    index: () => store.state.layers.findIndex((l) => l.root() === root),
    dismiss,
  };
}

function button(parent: HTMLElement = document.body, label = 'b'): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  parent.appendChild(b);
  return b;
}

describe('a kind change in place (add-docked-inspector D2)', () => {
  const setup = () => {
    const store = createAppStore(new FakeApiClient());
    disposes.push(installLayerArbiter({ layers: () => store.state.layers }));
    const [docked, setDocked] = createSignal(true);
    const inspector = mounted(store, () => (docked() ? 'docked' : 'dialog'));
    const inside = button(inspector.root, 'inside the inspector');
    const page = button(document.body, 'page control');
    return { store, setDocked, inspector, inside, page };
  };

  it('a popover above the docked layer is dismissed on the change to dialog', () => {
    const { store, setDocked, inspector, page } = setup();
    page.focus();
    inspector.open();
    expect(document.activeElement, 'the docked panel took focus on open').toBe(page);
    const popRoot = document.createElement('div');
    const popInput = document.createElement('input');
    popRoot.appendChild(popInput);
    const popover = mounted(store, 'popover', { root: popRoot });
    popover.open();
    popInput.focus();
    const before = { token: inspector.token(), index: inspector.index() };

    setDocked(false);

    expect(popover.dismiss, 'the transient above was not superseded').toHaveBeenCalledTimes(1);
    expect(popover.isOpen()).toBe(false);
    expect(store.state.layers.map((l) => l.kind)).toEqual(['dialog']);
    expect(topLayer(store.state.layers)?.token).toBe(before.token);
    expect(document.activeElement, 'focus outside the now-modal inspector was not moved in').toBe(
      inspector.root,
    );
    expect({ token: inspector.token(), index: inspector.index() }).toEqual(before);

    // It is now the topmost layer for the keyboard: Escape closes it.
    press(document.activeElement ?? document.body, 'Escape');
    expect(inspector.dismiss).toHaveBeenCalledTimes(1);
  });

  it('focus already inside the inspector stays where it is on the change to dialog', () => {
    const { setDocked, inspector, inside } = setup();
    inspector.open();
    inside.focus();
    setDocked(false);
    expect(document.activeElement).toBe(inside);
  });

  it('a dialog above the docked layer keeps focus and topmost status across the change, and its own popover survives it', () => {
    const { store, setDocked, inspector, inside } = setup();
    inspector.open();
    inside.focus();
    const dialog = mounted(store, 'dialog');
    const confirm = button(dialog.root, 'confirm');
    dialog.open();
    expect(document.activeElement).toBe(dialog.root);
    const popRoot = document.createElement('div');
    dialog.root.appendChild(popRoot);
    const popInput = document.createElement('input');
    popRoot.appendChild(popInput);
    const popover = mounted(store, 'popover', { root: popRoot });
    popover.open();
    popInput.focus();
    const tokens = store.state.layers.map((l) => l.token);
    const before = { token: inspector.token(), index: inspector.index() };

    setDocked(false);

    expect(store.state.layers.map((l) => l.kind)).toEqual(['dialog', 'dialog', 'popover']);
    expect(
      store.state.layers.map((l) => l.token),
      'something above was superseded',
    ).toEqual(tokens);
    expect(popover.dismiss).not.toHaveBeenCalled();
    expect(dialog.dismiss).not.toHaveBeenCalled();
    expect(document.activeElement, 'focus moved out of the topmost dialog').toBe(popInput);
    expect({ token: inspector.token(), index: inspector.index() }).toEqual(before);

    // The layers above keep Escape: first the popover, then the dialog — never the inspector.
    press(popInput, 'Escape');
    expect(popover.dismiss).toHaveBeenCalledTimes(1);
    confirm.focus();
    press(confirm, 'Escape');
    expect(dialog.dismiss).toHaveBeenCalledTimes(1);
    expect(inspector.dismiss).not.toHaveBeenCalled();
  });

  it('closing that dialog restores to its opener when the opener is inside the inspector', () => {
    const { store, setDocked, inspector, inside } = setup();
    inspector.open();
    inside.focus(); // the Delete control, say
    const dialog = mounted(store, 'dialog');
    dialog.open();
    setDocked(false);
    expect(document.activeElement).toBe(dialog.root);
    dialog.close();
    expect(document.activeElement).toBe(inside);
  });

  it('closing that dialog focuses the inspector root when the opener is outside it', () => {
    // The opener is on the page, now inert behind the modal inspector: focus must not go
    // back there.
    const { store, setDocked, inspector, page } = setup();
    inspector.open();
    page.focus();
    const dialog = mounted(store, 'dialog');
    dialog.open();
    setDocked(false);
    dialog.close();
    expect(document.activeElement, 'focus was returned into inert content').toBe(inspector.root);
  });

  it('without the crossing, the same close restores to the page opener', () => {
    // A docked panel makes nothing inert, so the rule changes nothing while it stays docked.
    const { store, inspector, page } = setup();
    inspector.open();
    page.focus();
    const dialog = mounted(store, 'dialog');
    dialog.open();
    dialog.close();
    expect(document.activeElement).toBe(page);
  });

  it('dialog → docked moves nothing and supersedes nothing', () => {
    const store = createAppStore(new FakeApiClient());
    const [docked, setDocked] = createSignal(false);
    const page = button(document.body, 'page control');
    page.focus();
    const inspector = mounted(store, () => (docked() ? 'docked' : 'dialog'));
    const inside = button(inspector.root, 'inside');
    inspector.open();
    expect(document.activeElement, 'the modal inspector did not take focus on open').toBe(
      inspector.root,
    );
    inside.focus();
    const popRoot = document.createElement('div');
    inspector.root.appendChild(popRoot);
    const popover = mounted(store, 'popover', { root: popRoot });
    popover.open();
    const before = store.state.layers.map((l) => l.token);
    const index = inspector.index();

    setDocked(true);

    expect(store.state.layers.map((l) => l.kind)).toEqual(['docked', 'popover']);
    expect(store.state.layers.map((l) => l.token)).toEqual(before);
    expect(inspector.index()).toBe(index);
    expect(popover.dismiss).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(inside);
  });

  it("the restore target stays the layer's own across a crossing, never the control that held focus before it", () => {
    const store = createAppStore(new FakeApiClient());
    const [docked, setDocked] = createSignal(true);
    const row = button(document.body, 'row of the shown request');
    const other = button(document.body, 'another page control');
    const inspector = mounted(store, () => (docked() ? 'docked' : 'dialog'), {
      restoreTo: () => row,
    });
    other.focus();
    inspector.open();
    expect(document.activeElement).toBe(other);
    setDocked(false);
    expect(document.activeElement).toBe(inspector.root);
    inspector.close();
    expect(document.activeElement, 'restored to the control focused before the crossing').toBe(row);
  });

  it('without restoreTo, the element captured on open stays the target across a crossing', () => {
    const store = createAppStore(new FakeApiClient());
    const [docked, setDocked] = createSignal(true);
    const opener = button(document.body, 'opener');
    const other = button(document.body, 'another page control');
    const inspector = mounted(store, () => (docked() ? 'docked' : 'dialog'));
    opener.focus();
    inspector.open();
    other.focus();
    setDocked(false);
    inspector.close();
    expect(document.activeElement).toBe(opener);
  });
});
