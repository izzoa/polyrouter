import { createSignal } from 'solid-js';

/** A button's own in-flight state, for a request-starting action the store tracks no flag
 * for (adopt-design-tokens-v2 D14, "Which buttons are busy").
 *
 * `run` starts the action once — a second activation while it is in flight is ignored —
 * and `busy()` is true until its promise settles, whether it resolves or rejects. The
 * button reads it as natively `disabled`, `aria-busy` and a progressive label in a
 * `StackedLabel`, so it keeps its width.
 *
 * Call it from a click handler as `void x.run(() => app.action(…))`: the `void` keeps the
 * codebase's fire-and-forget idiom, and `busyActions.test.ts` reads the inner `app.action`
 * as the call that needs a busy-table row. */
export interface Busy {
  busy: () => boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
}

/** Native `disabled` on the focused button drops focus to `<body>` (the browser's focus
 * fixup), so a keyboard user who activates a busy button loses their place, and a Tab during a
 * slow request starts again from the top of the document. `capture` notes the focused control
 * as the run starts; `restore` hands focus back when it settles, if that control is still in
 * the document and focus has not gone anywhere else meanwhile (a dialog, another field). A
 * button the run removed is not followed. (The switch's busy state keeps focus by being
 * `aria-disabled` instead, D3.) */
export interface FocusReturn {
  capture: () => void;
  restore: () => void;
  /** Forget a capture whose run never started. */
  drop: () => void;
}

export function createFocusReturn(): FocusReturn {
  let held: HTMLElement | null = null;
  return {
    capture: () => {
      const el = typeof document === 'undefined' ? null : document.activeElement;
      held = el instanceof HTMLElement && el !== document.body ? el : null;
    },
    restore: () => {
      const el = held;
      held = null;
      if (el === null || !el.isConnected) return;
      const now = document.activeElement;
      if (now !== null && now !== document.body) return;
      el.focus({ preventScroll: true });
    },
    drop: () => {
      held = null;
    },
  };
}

export function createBusy(): Busy {
  const [busy, setBusy] = createSignal(false);
  const focus = createFocusReturn();
  return {
    busy,
    run: async (action) => {
      if (busy()) return;
      focus.capture();
      setBusy(true);
      try {
        await action();
      } finally {
        // Re-enabled first (Solid writes `disabled` synchronously), then focus goes back.
        setBusy(false);
        focus.restore();
      }
    },
  };
}

/** `createBusy` for a list: one in-flight state per row key (an agent's Rotate key, a user's
 * Make admin), so a row's button is busy without its siblings going busy with it. */
export interface BusyMap {
  busy: (key: string) => boolean;
  run: (key: string, action: () => Promise<unknown>) => Promise<void>;
}

export function createBusyMap(): BusyMap {
  const [keys, setKeys] = createSignal<ReadonlySet<string>>(new Set());
  const busy = (key: string): boolean => keys().has(key);
  return {
    busy,
    run: async (key, action) => {
      if (busy(key)) return;
      // One return per run: rows settle independently, each handing back its own control.
      const focus = createFocusReturn();
      focus.capture();
      setKeys((s) => new Set([...s, key]));
      try {
        await action();
      } finally {
        setKeys((s) => {
          const next = new Set(s);
          next.delete(key);
          return next;
        });
        focus.restore();
      }
    },
  };
}
