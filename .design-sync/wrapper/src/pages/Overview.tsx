import type * as React from 'react';
import { useSolidMount, type CommonProps } from '../mount';
import { mountPage } from './page';

export type OverviewProps = CommonProps;

/** The full Overview screen: four stat cards (spend/requests/tokens/health),
 * the requests line chart with range selector, spend-by-model bars, and the
 * recent-requests table. Self-loads realistic demo analytics. Use as the
 * canonical polyrouter dashboard reference (try height 720). */
export function Overview(props: OverviewProps): React.ReactElement {
  return useSolidMount(props, (el, p) => mountPage(el, 'Overview', { live: false, ...p }));
}
