import type * as React from 'react';
import { useSolidMount, type CommonProps } from '../mount';
import { mountPage } from './page';

export type AgentsProps = CommonProps;

/** The full Agents screen: each connected agent (name, platform, key prefix,
 * 24h requests + spend) with rotate-key and delete actions, and the
 * new-agent entry point. */
export function Agents(props: AgentsProps): React.ReactElement {
  return useSolidMount(props, (el, p) => mountPage(el, 'Agents', p));
}
