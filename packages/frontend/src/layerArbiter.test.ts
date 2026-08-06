/** Overlay layer arbiter (centralize-overlay-layering, group 1).
 *
 * These drive the arbiter directly rather than through components, so the mechanism is
 * pinned independently of any surface that uses it. The component-level behaviour lives in
 * `a11y.test.tsx` and `navRail.test.tsx`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installLayerArbiter,
  supersededByDialog,
  topLayer,
  type LayerEntry,
  type LayerKind,
} from './a11y';

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
    const entry: LayerEntry = { token: next++, kind, root: () => root, onDismiss };
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
      if ((e).key === 'Escape') r.remove(top.token);
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
