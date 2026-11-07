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

import { createEffect, createMemo, createSignal, on, onCleanup, untrack } from 'solid-js';

/** Focusable-descendant query for the dialog Tab loop. Evaluated at keydown time so
 * dynamically revealed controls are always included. */
const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** What kind of layer this is — which decides its keyboard and focus policy, NOT its
 * position. Registering does not make a surface modal: only `dialog` owes the trapping
 * contract, and only a surface claiming `aria-modal` may be a `dialog`.
 *
 * `docked` is the non-modal panel that sits BESIDE the page (add-docked-inspector D2): it
 * takes Escape when topmost like every layer, but Tab travels on through it in document
 * order without wrapping or closing it, opening it moves no focus, and a dialog opening
 * above it does not supersede it. Only the Request Inspector presents as one. */
export type LayerKind = 'dialog' | 'menu' | 'popover' | 'docked';

/** A registration's kind: a constant, or an accessor for a layer whose kind changes in
 * place while it stays registered (the inspector crossing the dock threshold, D2). The
 * token — and with it the position in the ordering and the z-slot — never changes. */
export type LayerKindSource = LayerKind | (() => LayerKind);

/** Opaque handle for a registration. Removal takes the token, never an index — a layer
 * beneath an open one can be removed, and popping would take the wrong entry. */
export type LayerToken = number;

export interface LayerEntry {
  readonly token: LayerToken;
  /** The layer's CURRENT kind. A registry entry built by {@link layerEntry} reads it through
   * a getter over the registration's accessor, so `entry.kind` is always a value — never a
   * copy taken at registration and never a function a caller must remember to call. */
  readonly kind: LayerKind;
  readonly root: () => HTMLElement | undefined;
  /** Called when this layer is the resolved recipient of a dismissal. It MUST NOT remove
   * its own registration directly — a busy dialog may refuse, and must stay in the
   * ordering when it does. */
  readonly onDismiss: () => void;
}

/** A kind source as an accessor. */
export function kindAccessor(kind: LayerKindSource): () => LayerKind {
  return typeof kind === 'function' ? kind : () => kind;
}

/** A registry entry whose `kind` is a GETTER over its source (add-docked-inspector D2).
 *
 * A getter, not a stored value and not an exposed function: a stored value would go stale
 * when the kind changes in place, and an exposed accessor would break every reader that
 * treats `kind` as a value — including `page.evaluate`, which cannot return a function. The
 * getter is evaluated on read, so the arbiter, the supersession rule and the modal check all
 * see the kind as it is now. */
export function layerEntry(
  token: LayerToken,
  kind: LayerKindSource,
  root: () => HTMLElement | undefined,
  onDismiss: () => void,
): LayerEntry {
  const kindOf = kindAccessor(kind);
  return {
    token,
    get kind(): LayerKind {
      return kindOf();
    },
    root,
    onDismiss,
  };
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
  // Transients only. A docked panel is NOT one: it stays open and registered beneath the
  // dialog, inert with the rest of the content behind it, and resumes when it closes.
  return layers.filter((l) => l.kind === 'menu' || l.kind === 'popover');
}

/** What a registered layer whose kind has just changed to `dialog` IN PLACE does
 * (add-docked-inspector D2) — the docked inspector crossing below the dock threshold.
 *
 * - With no dialog registered above it, it acts as a dialog opening at its own position:
 *   the transients registered above it are superseded, and it takes focus (when focus is
 *   outside it — the caller checks).
 * - With a dialog registered above it (the payload deletion confirmation opened from the
 *   docked panel), only the kind changes. Nothing is superseded and no focus moves: the
 *   dialog above keeps focus and Escape, and so does any transient it owns. Pulling focus
 *   into the inspector would take it out of the topmost modal onto an element inert
 *   beneath it.
 *
 * Changing to any other kind supersedes nothing and moves no focus. */
export function promotedToDialog(
  layers: readonly LayerEntry[],
  token: LayerToken,
): { supersede: readonly LayerEntry[]; takeFocus: boolean } {
  const i = layers.findIndex((l) => l.token === token);
  const entry = layers[i];
  if (entry === undefined || entry.kind !== 'dialog') return { supersede: [], takeFocus: false };
  const above = layers.slice(i + 1);
  if (above.some((l) => l.kind === 'dialog')) return { supersede: [], takeFocus: false };
  return { supersede: supersededByDialog(above), takeFocus: true };
}

/** The root of the topmost layer that is CURRENTLY a dialog — the modal that makes the
 * content outside it inert. Docked, menu and popover layers make nothing inert. */
export function topDialogRoot(layers: readonly LayerEntry[]): HTMLElement | undefined {
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (l !== undefined && l.kind === 'dialog') return l.root();
  }
  return undefined;
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
  // docked: a no-op. The panel sits beside a live page, so Tab travels on in document order —
  // never prevented (that would trap it), never a dismissal (that would close the panel the
  // user is tabbing through).
  if (entry.kind === 'docked') return;
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
 * removed is the one that actually holds it, and never to a detached element.
 *
 * Only a `dialog` takes focus on open. A `docked` panel, a menu and a popover move nothing.
 *
 * - `restoreTo` replaces the element captured on open as the restore target — for a surface
 *   whose own content decides where focus returns (the inspector: the row of the record it
 *   shows, add-docked-inspector D6). A kind change in place never re-captures it.
 * - `topDialogRoot` is the registry's view at restore time, read AFTER this layer was
 *   removed (add-docked-inspector D2). Focus is never returned into content that the topmost
 *   modal makes inert: a restore target outside that modal's root gives way to the root.
 *   That is the case after the inspector became modal beneath a dialog opened from the page
 *   while it was docked. The test is containment in the root, not the `inert` attribute —
 *   content behind a modal is inert through `aria-modal`, the Tab trap and the backdrop. A
 *   target that is gone is left to the caller, as before (a confirmation's `fallbackFocus`). */
export function layerFocus(
  kind: LayerKind,
  root: () => HTMLElement | undefined,
  opts: {
    restoreTo?: (() => HTMLElement | null | undefined) | undefined;
    topDialogRoot?: (() => HTMLElement | undefined) | undefined;
  } = {},
): () => void {
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
    const target = opts.restoreTo ? (opts.restoreTo() ?? null) : previous;
    if (!target || !target.isConnected) return;
    // A target that is gone stays the caller's to settle (a confirmation's `fallbackFocus`);
    // only a target that is THERE but behind the topmost modal is replaced by that modal.
    const modal = opts.topDialogRoot?.();
    if (modal !== undefined && modal !== el && modal.isConnected && !modal.contains(target)) {
      modal.focus();
      return;
    }
    target.focus();
  };
}

/** What `useLayer` needs from the store: the registry, plus the two reads a kind change in
 * place needs (add-docked-inspector D2). The app store satisfies it. */
export interface LayerHost {
  registerLayer: (o: {
    kind: LayerKindSource;
    root: () => HTMLElement | undefined;
    onDismiss: () => void;
  }) => LayerToken;
  removeLayer: (t: LayerToken) => void;
  layerZ: (t: LayerToken) => { backdrop: number; surface: number };
  /** Runs the consequences of a registered layer's kind having changed in place, and says
   * whether that layer should now take focus (see {@link promotedToDialog}). */
  layerKindChanged: (t: LayerToken) => boolean;
  /** The root of the topmost layer that is currently a dialog (see {@link topDialogRoot}). */
  topDialogRoot: () => HTMLElement | undefined;
}

/** Solid binding: register a layer while `when()` is true, with focus entry/restore by kind.
 *
 * Deliberately thin. It exists so the seven call sites do not each hand-roll
 * register/focus/cleanup — the kind of duplication that let two `BodyCaptureCard` dialogs
 * claim `aria-modal` while implementing none of it.
 *
 * `kind` may be an accessor (add-docked-inspector D2). The registration is NOT redone when it
 * changes — the same token keeps its position, its z-slot and its focus restore — and the
 * change is handed to the store, which supersedes what a dialog opening there would; the
 * layer then takes focus only when the store says so and focus is outside it. */
export function useLayer(
  app: LayerHost,
  opts: {
    when: () => boolean;
    kind: LayerKindSource;
    root: () => HTMLElement | undefined;
    onDismiss: () => void;
    /** Overrides the restore target captured on open (see {@link layerFocus}). */
    restoreTo?: (() => HTMLElement | null | undefined) | undefined;
  },
): () => { backdrop: number; surface: number } {
  const [token, setToken] = createSignal<LayerToken | null>(null);
  const kindOf = kindAccessor(opts.kind);
  createEffect(() => {
    if (!opts.when()) return;
    // Register FIRST. Registration synchronously supersedes any open transient, and a
    // dismissed menu restores focus to its trigger — doing that after focusing the dialog
    // would steal focus straight back out of the layer just opened. Registering first also
    // means `layerFocus` captures the post-supersession element as the restore target,
    // which is the one the user will expect to return to.
    //
    // UNTRACKED kind reads: a kind change must not re-run this effect, which would
    // unregister and re-register the same element — exactly what a crossing may not do.
    const registered = untrack(() =>
      app.registerLayer({
        kind: opts.kind,
        root: opts.root,
        onDismiss: opts.onDismiss,
      }),
    );
    const restore = layerFocus(untrack(kindOf), opts.root, {
      restoreTo: opts.restoreTo,
      topDialogRoot: () => app.topDialogRoot(),
    });
    setToken(registered);
    if (typeof opts.kind === 'function') {
      createEffect(
        on(
          kindOf,
          (next, prev) => {
            if (next === prev) return;
            // Supersession FIRST, then focus — a dismissed menu restores focus to its
            // trigger, which would otherwise take it straight back out of the root.
            if (!app.layerKindChanged(registered)) return;
            const root = opts.root();
            const active = document.activeElement;
            if (root && !(active instanceof Node && root.contains(active))) root.focus();
          },
          { defer: true },
        ),
      );
    }
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
    /** The id of the element holding the text that describes the dialog, announced with its
     * name when focus moves in (allow-preset-client-identity D10). Optional: most dialogs are
     * fully described by their name. */
    describedBy?: string;
    onDismiss: () => void;
    /** Overrides the restore target captured on open, for a trigger that may not hold focus
     * when the dialog opens (a checkbox clicked in Safari). See {@link layerFocus}. */
    restoreTo?: () => HTMLElement | null | undefined;
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
    restoreTo: opts.restoreTo,
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
      get 'aria-describedby'() {
        return opts.when() ? opts.describedBy : undefined;
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

/** The inspector root's accessible name, in every presentation. */
export const INSPECTOR_LABEL = 'Request inspector';

/** The Request Inspector's surface (add-docked-inspector D5): one element and one layer
 * registration across every presentation, whose kind — and with it its modality — follows
 * `docked()`.
 *
 * A sibling of {@link useModalSurface}, for the one surface whose modality MAY depend on
 * width (dashboard-core "An overlay's behaviour is independent of its presentation"). Its
 * attributes are GETTERS over the very accessor the registry entry reads, so the role,
 * `aria-modal` and the registered kind cannot disagree — the property `useModalSurface`
 * exists to guarantee, kept across a kind change in place:
 *
 * - docked: `role="complementary"`, no `aria-modal`, kind `docked`;
 * - otherwise: `role="dialog"`, `aria-modal="true"`, kind `dialog`.
 *
 * The name (`Request inspector`) and `tabindex="-1"` (so the panel can take programmatic
 * focus) are the same in both. The returned `modal()` is the same accessor again, for the
 * parts of the presentation the kind drives that are not attributes (the scrim).
 *
 * Registered for as long as the caller is mounted: the inspector renders this only while a
 * record is shown. */
export function useInspectorSurface(
  app: LayerHost,
  opts: {
    docked: () => boolean;
    onDismiss: () => void;
    /** The inspector's own restore target (D6), replacing the element captured on open. */
    restoreTo?: () => HTMLElement | null | undefined;
  },
): {
  z: () => { backdrop: number; surface: number };
  modal: () => boolean;
  props: Record<string, unknown>;
} {
  let el: HTMLElement | undefined;
  const kind = createMemo<LayerKind>(() => (opts.docked() ? 'docked' : 'dialog'));
  const modal = (): boolean => kind() === 'dialog';
  const z = useLayer(app, {
    when: () => true,
    kind,
    root: () => el,
    onDismiss: opts.onDismiss,
    restoreTo: opts.restoreTo,
  });
  return {
    z,
    modal,
    props: {
      get role() {
        return modal() ? 'dialog' : 'complementary';
      },
      get 'aria-modal'() {
        return modal() ? 'true' : undefined;
      },
      get 'aria-label'() {
        return INSPECTOR_LABEL;
      },
      get tabindex() {
        return -1;
      },
      ref: (node: HTMLElement) => {
        el = node;
      },
    },
  };
}

/** Every rendered element claiming `aria-modal`, paired with whether it IS a registered
 * layer root whose CURRENT kind is `dialog` — compared by element IDENTITY.
 *
 * Not by count and not by id: a bogus registration satisfies either. The check this backs
 * has to fail when a surface claims modal semantics it did not register, which is exactly
 * what shipped twice. And registered is not enough: a root registered as a docked panel (or
 * a menu, or a popover) owes none of the trapping contract, so its claiming `aria-modal`
 * fails too (add-docked-inspector D2) — a kind change in place must carry its attributes
 * with it. */
export function unregisteredModalSurfaces(
  scope: ParentNode,
  layers: readonly LayerEntry[],
): HTMLElement[] {
  const roots = new Set(
    layers
      .filter((l) => l.kind === 'dialog')
      .map((l) => l.root())
      .filter((r): r is HTMLElement => !!r),
  );
  return [...scope.querySelectorAll<HTMLElement>('[aria-modal="true"]')].filter(
    (el) => !roots.has(el),
  );
}
