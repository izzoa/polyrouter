/** Overlay layer arbitration (centralize-overlay-layering).
 *
 * One registry answers "which layer is topmost", and one two-phase listener turns that into
 * keyboard behaviour. Everything that used to be decided per surface — a `suspended`
 * predicate here, a hand-written ordering there, a z-index somewhere else — derives from it.
 *
 * WHY TWO PHASES. The predecessor gave each surface its own `document` listener gated on a
 * predicate over shared state, and that cannot work: a predicate cannot arbitrate an event
 * that mutates the state it reads. One keypress dismissed two surfaces because the first
 * handler cleared the flag the second one read.
 *
 * A single listener is necessary but NOT sufficient — a handler inside a layer still runs
 * first, in the target phase. `ModelPicker` handles Escape on its own input, so a bubbling
 * arbiter would read the registry after the picker had already closed and removed itself,
 * and dispatch to the layer beneath. So:
 *
 *   capture   snapshot the recipient; mutate nothing
 *   target    the layer's own handler may run, and may consume the event
 *   bubble    consumed? do nothing. snapshot gone? do nothing — NEVER fall through
 *             to the layer beneath. otherwise dispatch to the snapshot.
 *
 * The decision is taken before anything can mutate; the dispatch happens late enough that a
 * layer can keep nuanced local handling (the picker's two-stage Escape) that cannot survive
 * being moved into a callback.
 */

import { createEffect, createSignal, onCleanup } from 'solid-js';

/** Focusable-descendant query for the dialog Tab loop. Evaluated at keydown time so
 * dynamically revealed controls are always included. */
const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** What kind of layer this is — which decides its keyboard and focus policy, NOT its
 * position. Registering does not make a surface modal: only `dialog` owes the trapping
 * contract, and only a surface claiming `aria-modal` may be a `dialog`. */
export type LayerKind = 'dialog' | 'menu' | 'popover';

/** Opaque handle for a registration. Removal takes the token, never an index — a layer
 * beneath an open one can be removed, and popping would take the wrong entry. */
export type LayerToken = number;

export interface LayerEntry {
  readonly token: LayerToken;
  readonly kind: LayerKind;
  readonly root: () => HTMLElement | undefined;
  /** Called when this layer is the resolved recipient of a dismissal. It MUST NOT remove
   * its own registration directly — a busy dialog may refuse, and must stay in the
   * ordering when it does. */
  readonly onDismiss: () => void;
}

/** The topmost layer is simply the most recently registered one.
 *
 * Ownership does not enter here, and deliberately so: a transient is always registered
 * AFTER the layer it was opened from (you open the combobox from inside the dialog), so
 * open order already ranks it above its owner. The reverse case — a page-level menu open
 * when an unrelated dialog opens — is handled at registration time by superseding, not by
 * ranking. A kind-based ranking would get that case backwards. */
export function topLayer(layers: readonly LayerEntry[]): LayerEntry | undefined {
  return layers[layers.length - 1];
}

/** Transients a newly-opened dialog supersedes: every menu and popover currently open.
 * Leaving one registered would keep a page-level menu above a modal, which is exactly the
 * isolation the dialog is asserting.
 *
 * All of them, with no ownership exception. A transient opened from INSIDE a dialog cannot
 * be affected, because it registers after that dialog and no dialog opens between them; and
 * a menu that launches a dialog closes itself first, as menus do. An ownership parameter
 * existed here briefly, was supplied by no call site, and only created a rule that could
 * disagree with open order. */
export function supersededByDialog(layers: readonly LayerEntry[]): readonly LayerEntry[] {
  return layers.filter((l) => l.kind !== 'dialog');
}

/** Paint order, derived from the same ordering the keyboard uses — so the layer that takes
 * Escape is the layer that renders above, and the two cannot disagree.
 *
 * Two slots per layer, because a layer is a BACKDROP plus a SURFACE and the element
 * carrying z-index is usually not the registered root: the modal's is its parent
 * `.modal-backdrop`, the drawer's is a sibling `.overlay`. Setting z-index on the focus
 * root alone would move nothing.
 *
 * BOUNDED: the band tops out below the toast, which is not a dismissible layer and must
 * stay above everything. With two slots per layer that leaves room for nine simultaneous
 * layers, against a realistic maximum of about three. */
export const LAYER_Z_BASE = 40;
export const LAYER_Z_CEILING = 58; // toast sits at 60 and is never a layer

export function layerZ(index: number): { backdrop: number; surface: number } {
  const backdrop = Math.min(LAYER_Z_BASE + index * 2, LAYER_Z_CEILING - 1);
  return { backdrop, surface: backdrop + 1 };
}

export interface LayerArbiterOptions {
  /** Current registry, most-recently-registered last. */
  layers: () => readonly LayerEntry[];
}

/** Installs the two-phase keydown arbiter. Returns a dispose function.
 *
 * Installed from the mounted app, NOT from store construction — the test suites build many
 * stores and would otherwise accumulate listeners. */
export function installLayerArbiter(opts: LayerArbiterOptions): () => void {
  let snapshot: LayerToken | null = null;

  /** An IME composition owns the keyboard entirely. An Escape that ends a composition must
   * reach the input method, not dismiss a layer — so the arbiter returns before resolving,
   * preventing, stopping or dispatching, in BOTH phases. `isComposing` is an attribute of
   * the event itself, so a document-level listener can read it. */
  const composing = (e: KeyboardEvent): boolean => e.isComposing;

  const onCapture = (e: KeyboardEvent): void => {
    snapshot = null;
    if (composing(e)) return;
    if (e.key !== 'Escape' && e.key !== 'Tab') return;
    snapshot = topLayer(opts.layers())?.token ?? null;
  };

  const onBubble = (e: KeyboardEvent): void => {
    const token = snapshot;
    snapshot = null;
    if (token === null || composing(e)) return;
    // A handler inside the layer already dealt with it — the picker's two-stage Escape is
    // the case this exists for. Dispatching as well is how two layers close on one key.
    if (e.defaultPrevented) return;
    // The snapshot layer left during this event. Do NOT fall through to the one beneath:
    // that is the original bug.
    const entry = opts.layers().find((l) => l.token === token);
    if (!entry) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      entry.onDismiss();
      return;
    }
    if (e.key !== 'Tab') return;
    applyTabPolicy(e, entry);
  };

  document.addEventListener('keydown', onCapture, true);
  document.addEventListener('keydown', onBubble);
  return () => {
    document.removeEventListener('keydown', onCapture, true);
    document.removeEventListener('keydown', onBubble);
  };
}

/** Tab, per kind. The browser's own traversal runs AFTER dispatch, so whether
 * `preventDefault` is called is what decides the outcome — a menu that prevented default
 * would trap focus exactly like the dialog it is not. */
function applyTabPolicy(e: KeyboardEvent, entry: LayerEntry): void {
  if (entry.kind !== 'dialog') {
    // menu: dismiss and let focus travel on. popover: dismiss without committing, leaving
    // focus where it is (on the owning input). Neither preventsDefault.
    entry.onDismiss();
    return;
  }
  const root = entry.root();
  if (!root) return;
  const focusables = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (first === undefined || last === undefined) {
    e.preventDefault();
    root.focus();
    return;
  }
  const active = document.activeElement;
  const inside = active instanceof HTMLElement && root.contains(active);
  if (e.shiftKey) {
    if (!inside || active === first || active === root) {
      e.preventDefault();
      last.focus();
    }
  } else if (!inside || active === last) {
    e.preventDefault();
    first.focus();
  }
}

/** Focus entry and restore for a layer, by kind. Separate from the arbiter because it runs
 * on open/close rather than per keypress.
 *
 * `restore` is deliberately conditional: a layer BENEATH an open one can be removed (a route
 * change unmounting the drawer while a modal is open above it), and restoring its trigger
 * would yank focus out of the layer still open. So focus returns only when the layer being
 * removed is the one that actually holds it, and never to a detached element. */
export function layerFocus(kind: LayerKind, root: () => HTMLElement | undefined): () => void {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (kind === 'dialog') root()?.focus();
  return () => {
    const el = root();
    const active = document.activeElement;
    const holdsFocus =
      el instanceof HTMLElement && active instanceof HTMLElement && el.contains(active);
    // Focus having fallen to the body means this layer's focused child was removed before
    // cleanup ran — still ours to restore. A layer open ABOVE this one holds focus inside
    // itself, never on the body, so this cannot steal from it.
    const focusOrphaned = active === null || active === document.body;
    if (!holdsFocus && !focusOrphaned) return;
    if (previous && previous.isConnected) previous.focus();
  };
}

/** Solid binding: register a layer while `when()` is true, with focus entry/restore by kind.
 *
 * Deliberately thin. It exists so the seven call sites do not each hand-roll
 * register/focus/cleanup — the kind of duplication that let two `BodyCaptureCard` dialogs
 * claim `aria-modal` while implementing none of it. */
export function useLayer(
  app: {
    registerLayer: (o: {
      kind: LayerKind;
      root: () => HTMLElement | undefined;
      onDismiss: () => void;
    }) => LayerToken;
    removeLayer: (t: LayerToken) => void;
    layerZ: (t: LayerToken) => { backdrop: number; surface: number };
  },
  opts: {
    when: () => boolean;
    kind: LayerKind;
    root: () => HTMLElement | undefined;
    onDismiss: () => void;
  },
): () => { backdrop: number; surface: number } {
  const [token, setToken] = createSignal<LayerToken | null>(null);
  createEffect(() => {
    if (!opts.when()) return;
    // Register FIRST. Registration synchronously supersedes any open transient, and a
    // dismissed menu restores focus to its trigger — doing that after focusing the dialog
    // would steal focus straight back out of the layer just opened. Registering first also
    // means `layerFocus` captures the post-supersession element as the restore target,
    // which is the one the user will expect to return to.
    const registered = app.registerLayer({
      kind: opts.kind,
      root: opts.root,
      onDismiss: opts.onDismiss,
    });
    const restore = layerFocus(opts.kind, opts.root);
    setToken(registered);
    onCleanup(() => {
      app.removeLayer(registered);
      setToken(null);
      restore();
    });
  });
  // Paint order for this layer, from the same ordering the keyboard uses. Applied inline
  // BY DESIGN — the value is per-instance and positional, which no class can express.
  return () => {
    const t = token();
    return app.layerZ(t ?? 0);
  };
}

/** A modal surface: the ARIA attributes and the layer registration, supplied TOGETHER.
 *
 * This is the structural half of the contract. `a11y.ts` used to carry a comment saying
 * "aria-modal must only be claimed on roots wired through this helper", and two
 * `BodyCaptureCard` dialogs claimed it while implementing none of it — because a comment
 * cannot be violated loudly. Here the attributes and the registration are one call: you
 * cannot spread `role`/`aria-modal`/`tabindex` onto an element without also registering it,
 * and the lint rule forbids writing them by hand.
 *
 * A props helper rather than a wrapper component, deliberately: a wrapper would insert a
 * DOM node into layouts that are load-bearing (the drawer is a flex column, the modal card
 * a grid child), and this change is not allowed to move anything.
 */
export function useModalSurface(
  app: Parameters<typeof useLayer>[0],
  opts: {
    when: () => boolean;
    /** Exactly one naming route — a dialog must have an accessible name, and which one is
     * the call site's choice, not something this helper should guess. */
    label?: string;
    labelledBy?: string;
    onDismiss: () => void;
  },
): {
  z: () => { backdrop: number; surface: number };
  props: Record<string, unknown>;
} {
  let el: HTMLElement | undefined;
  const z = useLayer(app, {
    when: opts.when,
    kind: 'dialog',
    root: () => el,
    onDismiss: opts.onDismiss,
  });
  // GETTERS, not a static object. The attributes track `when()` exactly, so a surface that
  // is only conditionally modal — the nav is an ordinary in-flow pane above the narrow
  // threshold — claims `aria-modal` precisely while it is registered, and never otherwise.
  // That IS the invariant: the attributes and the registration cannot come apart.
  return {
    z,
    props: {
      get role() {
        return opts.when() ? 'dialog' : undefined;
      },
      get 'aria-modal'() {
        return opts.when() ? 'true' : undefined;
      },
      get 'aria-label'() {
        return opts.when() ? opts.label : undefined;
      },
      get 'aria-labelledby'() {
        return opts.when() ? opts.labelledBy : undefined;
      },
      get tabindex() {
        return opts.when() ? -1 : undefined;
      },
      ref: (node: HTMLElement) => {
        el = node;
      },
    },
  };
}

/** Every rendered element claiming `aria-modal`, paired with whether it IS a registered
 * layer root — compared by element IDENTITY.
 *
 * Not by count and not by id: a bogus registration satisfies either. The check this backs
 * has to fail when a surface claims modal semantics it did not register, which is exactly
 * what shipped twice. */
export function unregisteredModalSurfaces(
  scope: ParentNode,
  layers: readonly LayerEntry[],
): HTMLElement[] {
  const roots = new Set(layers.map((l) => l.root()).filter((r): r is HTMLElement => !!r));
  return [...scope.querySelectorAll<HTMLElement>('[aria-modal="true"]')].filter(
    (el) => !roots.has(el),
  );
}
