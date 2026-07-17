import type * as React from 'react';
import { useSolidMount, type CommonProps } from '../mount';
import { mountPage } from './page';

export type SettingsProps = CommonProps;

/** The full Settings screen: instance/session info and notification channels
 * (SMTP / Apprise) with per-channel enable, test-send and event subscriptions. */
export function Settings(props: SettingsProps): React.ReactElement {
  return useSolidMount(props, (el, p) => mountPage(el, 'Settings', p));
}
