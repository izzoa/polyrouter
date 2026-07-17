import type * as React from 'react';
import { useSolidMount, type CommonProps } from '../mount';
import { mountPage } from './page';

export type SetupProps = CommonProps;

/** The full Setup guide: the three-step onboarding (mint an agent key →
 * connect a provider → verify a routed request), fully interactive against
 * the demo backend. */
export function Setup(props: SetupProps): React.ReactElement {
  return useSolidMount(props, (el, p) => mountPage(el, 'Setup', p));
}
