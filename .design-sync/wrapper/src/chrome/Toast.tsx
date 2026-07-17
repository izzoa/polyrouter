import type * as React from 'react';
import { mountWithApp, solid } from '../../solid/design-kit.mjs';
import { useSolidMount, type CommonProps } from '../mount';

export interface ToastProps extends CommonProps {
  /** Toast text (default "Endpoint copied"). */
  message?: string;
}

/** The dashboard's toast (role=status): a small floating dark chip. In the app
 * it auto-dismisses after ~1.8s; here it stays visible for composition. */
export function Toast(props: ToastProps): React.ReactElement {
  return useSolidMount(props, (el, p) => {
    const { message, ...rest } = p;
    return mountWithApp(el, solid['Toast']!, rest, {
      seed: { toast: typeof message === 'string' ? message : 'Endpoint copied' },
    });
  });
}
