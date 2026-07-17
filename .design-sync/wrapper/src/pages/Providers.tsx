import type * as React from 'react';
import { useSolidMount, type CommonProps } from '../mount';
import { mountPage } from './page';

export type ProvidersProps = CommonProps;

/** The full Providers screen: connected providers (kind, protocol, base URL,
 * health status) with test/sync/delete actions and per-provider model lists
 * (context window, capabilities, prices). */
export function Providers(props: ProvidersProps): React.ReactElement {
  return useSolidMount(props, (el, p) => mountPage(el, 'Providers', p));
}
