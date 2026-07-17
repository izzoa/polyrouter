import type * as React from 'react';
import { useSolidMount, type CommonProps } from '../mount';
import { mountPage } from './page';

export type RoutingProps = CommonProps;

/** The full Routing screen: tier cards with ordered model chains
 * (primary → fallbacks), header rules for `x-polyrouter-tier`, and the
 * auto-routing layer toggles (structural / cascade). */
export function Routing(props: RoutingProps): React.ReactElement {
  return useSolidMount(props, (el, p) => mountPage(el, 'Routing', p));
}
