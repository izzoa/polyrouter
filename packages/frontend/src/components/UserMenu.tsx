import { createSignal, onCleanup, Show } from 'solid-js';
import { useApp } from '../state/context';

/** The signed-in identity + account menu (user-administration): always-visible
 * chrome in the sidebar footer. Opens an upward `role="menu"` popover with
 * Settings · theme toggle · (admin) Users · Log out. Keyboard: Escape closes,
 * focus moves to the first item on open, click-outside dismisses. */
export function UserMenu() {
  const app = useApp();
  const { state } = app;
  const [open, setOpen] = createSignal(false);
  let rootEl: HTMLDivElement | undefined;
  let menuEl: HTMLDivElement | undefined;
  let triggerEl: HTMLButtonElement | undefined;

  const items = (): HTMLButtonElement[] => [
    ...(menuEl?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
  ];

  const close = (restoreFocus = false): void => {
    setOpen(false);
    if (restoreFocus) triggerEl?.focus();
  };
  const toggle = (): void => {
    const next = !open();
    setOpen(next);
    if (next) queueMicrotask(() => items()[0]?.focus());
  };

  // Menu-pattern keyboard support while open: Escape restores the trigger,
  // arrows cycle the items, Home/End jump (document-level — the menuitems
  // themselves are plain buttons).
  const onDocKeydown = (e: KeyboardEvent): void => {
    if (!open()) return;
    if (e.key === 'Escape') {
      close(true); // focus returns to the trigger
      return;
    }
    const list = items();
    if (list.length === 0) return;
    const idx = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[(idx + 1) % list.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      list[(idx - 1 + list.length) % list.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      list[list.length - 1]?.focus();
    }
  };
  const onDocClick = (e: MouseEvent): void => {
    if (open() && rootEl && !rootEl.contains(e.target as Node)) close();
  };
  document.addEventListener('keydown', onDocKeydown);
  document.addEventListener('click', onDocClick);
  onCleanup(() => {
    document.removeEventListener('keydown', onDocKeydown);
    document.removeEventListener('click', onDocClick);
  });

  const isAdmin = (): boolean => state.session?.role === 'admin';

  const item = (label: string, action: () => void, opts?: { danger?: boolean }) => (
    <button
      type="button"
      role="menuitem"
      style={{
        display: 'block',
        width: '100%',
        'text-align': 'left',
        padding: '7px 12px',
        font: "400 12.5px 'Geist', sans-serif",
        color: opts?.danger === true ? 'var(--red)' : 'var(--text)',
        'border-radius': '6px',
      }}
      class="row-hover"
      onClick={() => {
        close();
        action();
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      style="position:relative"
      ref={(el) => {
        rootEl = el;
      }}
    >
      <Show when={open()}>
        <div
          role="menu"
          aria-label="Account"
          class="panel"
          ref={(el) => {
            menuEl = el;
          }}
          style="position:absolute;bottom:calc(100% + 6px);left:0;right:0;padding:5px;display:flex;flex-direction:column;gap:1px;z-index:30"
        >
          {item('Settings', () => app.go('settings'))}
          {item(state.theme === 'light' ? 'Switch to dark' : 'Switch to light', () =>
            app.toggleTheme(),
          )}
          <Show when={isAdmin()}>{item('Users', () => app.go('users'))}</Show>
          {item('Log out', () => void app.signOut(), { danger: true })}
        </div>
      </Show>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open()}
        aria-label={`Account: ${state.session?.email ?? 'signed in'}`}
        ref={(el) => {
          triggerEl = el;
        }}
        style="display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);cursor:pointer"
        onClick={toggle}
      >
        <span
          aria-hidden="true"
          style="flex:none;width:20px;height:20px;border-radius:50%;background:var(--accent-bg);color:var(--accent-deep);display:grid;place-items:center;font:600 10px 'Geist',sans-serif"
        >
          {(state.session?.name?.[0] ?? state.session?.email?.[0] ?? '?').toUpperCase()}
        </span>
        <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:500 11.5px 'Geist',sans-serif;color:var(--text2)">
          {state.session?.email ?? '—'}
        </span>
        <span aria-hidden="true" style="margin-left:auto;color:var(--text3);font-size:9px">
          ▲
        </span>
      </button>
    </div>
  );
}
