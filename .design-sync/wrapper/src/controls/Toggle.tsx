import type * as React from 'react';
import { mountPlain, solid } from '../../solid/design-kit.mjs';
import { useSolidMount, type CommonProps } from '../mount';

export interface ToggleProps extends CommonProps {
  /** Switch state. */
  on: boolean;
  /** `sm` = dense rows/channels (default), `md` = settings. */
  size?: 'sm' | 'md';
  /** Locked switches render but ignore clicks. */
  locked?: boolean;
  /** Accessible name — the control is icon-only. */
  label: string;
  /** Click handler; wire to state for a working switch. */
  onToggle?: () => void;
}

/** polyrouter's switch control — the dashboard's real compiled SolidJS Toggle
 * (accent when on, grey when off, knob slide). */
export function Toggle(props: ToggleProps): React.ReactElement {
  return useSolidMount(props, (el, p) =>
    mountPlain(el, solid['Toggle']!, { onToggle: () => undefined, ...p }),
  );
}
