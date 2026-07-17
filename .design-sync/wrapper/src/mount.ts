/** React host for the compiled Solid components.
 *
 * Interop contract: data props remount the Solid root when they change (cheap,
 * always correct); function props are forwarded through stable trampolines so
 * React inline callbacks never force a remount. `theme` scopes the dashboard's
 * light/dark tokens to this block via the same [data-theme] attribute the app
 * uses; `height` fixes the host block's height (content scrolls).
 */
import * as React from 'react';
import type { Disposer } from '../solid/design-kit.mjs';

export interface CommonProps {
  /** Scope this block to the dashboard's light or dark token set. */
  theme?: 'light' | 'dark';
  /** Fixed host height in px; content scrolls inside. Omit for natural height. */
  height?: number;
}

type Mounter = (el: HTMLElement, props: Record<string, unknown>) => Disposer;

export function useSolidMount<P extends CommonProps>(props: P, mount: Mounter): React.ReactElement {
  const latest = React.useRef<P>(props);
  latest.current = props;
  const ref = React.useRef<HTMLDivElement | null>(null);
  // Remount key: every serializable prop; functions are identity-insensitive.
  const depKey = JSON.stringify(props, (_k, v: unknown) =>
    typeof v === 'function' ? 'ƒ' : v,
  );
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const snapshot = latest.current as Record<string, unknown>;
    const solidProps: Record<string, unknown> = {};
    for (const key of Object.keys(snapshot)) {
      if (key === 'theme') continue;
      const value = snapshot[key];
      solidProps[key] =
        typeof value === 'function'
          ? (...args: unknown[]) => {
              const fn = (latest.current as Record<string, unknown>)[key];
              return typeof fn === 'function'
                ? (fn as (...a: unknown[]) => unknown)(...args)
                : undefined;
            }
          : value;
    }
    el.innerHTML = '';
    const dispose = mount(el, solidProps);
    return () => {
      dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depKey]);
  return React.createElement('div', {
    ref,
    'data-theme': props.theme,
    style: {
      display: 'block',
      position: 'relative',
      width: '100%',
      fontFamily: "'Geist', sans-serif",
      color: 'var(--text)',
      background: props.theme ? 'var(--bg)' : 'transparent',
      ...(props.height !== undefined
        ? { height: `${String(props.height)}px`, overflow: 'auto' }
        : {}),
    } as React.CSSProperties,
  });
}
