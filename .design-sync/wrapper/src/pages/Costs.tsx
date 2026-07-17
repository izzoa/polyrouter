import type * as React from 'react';
import { useSolidMount, type CommonProps } from '../mount';
import { mountPage } from './page';

export type CostsProps = CommonProps;

/** The full Costs screen: spend summary for the selected range plus by-model,
 * by-provider and by-agent breakdown bars (free rows shown green). */
export function Costs(props: CostsProps): React.ReactElement {
  return useSolidMount(props, (el, p) => mountPage(el, 'Costs', { live: false, ...p }));
}
