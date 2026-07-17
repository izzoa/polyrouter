/** Focusable-descendant query for the dialog Tab loop. Evaluated at keydown time so
 * dynamically revealed controls are always included. */
const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export interface DialogKeyboardOptions {
  /** The dialog root (must carry tabindex="-1" so it can take initial focus). */
  root: () => HTMLElement | undefined;
  onClose: () => void;
  /** Return true while a higher overlay is stacked above this dialog (e.g. a modal over
   * the drawer): the ENTIRE handler goes inert — Escape and the Tab loop both belong to
   * the topmost overlay. Layering is decided by this state guard, never by listener
   * registration order. */
  suspended?: () => boolean;
}

/** Real-dialog keyboard behavior: focus-on-open, Tab loop, Escape close, focus restore.
 * Returns a dispose function; `aria-modal` must only be claimed on roots wired through
 * this helper. */
export function dialogKeyboard(opts: DialogKeyboardOptions): () => void {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const onKeydown = (e: KeyboardEvent): void => {
    if (opts.suspended?.() === true) return;
    if (e.key === 'Escape') {
      opts.onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const root = opts.root();
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
  };

  document.addEventListener('keydown', onKeydown);
  opts.root()?.focus();

  return () => {
    document.removeEventListener('keydown', onKeydown);
    previous?.focus();
  };
}
