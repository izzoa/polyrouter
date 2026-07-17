import type * as React from 'react';
import { useSolidMount, type CommonProps } from '../mount';
import { mountPage } from './page';

export type RequestsProps = CommonProps;

/** The full Requests screen: filter chips (all/explicit/auto/fallback/escalated),
 * the request-log table with decision-layer chips, and Load more pagination —
 * all live against the demo corpus. Row clicks open the Inspector drawer. */
export function Requests(props: RequestsProps): React.ReactElement {
  return useSolidMount(props, (el, p) => mountPage(el, 'Requests', p));
}
