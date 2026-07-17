import type * as React from 'react';
import { useSolidMount, type CommonProps } from '../mount';
import { mountPage } from './page';

export type LimitsProps = CommonProps;

/** The full Limits screen: spend budgets (global or per-agent, day/week/month)
 * that alert or hard-block, with their notification channels and enable toggles. */
export function Limits(props: LimitsProps): React.ReactElement {
  return useSolidMount(props, (el, p) => mountPage(el, 'Limits', p));
}
