import * as React from 'react';
import { Settings } from '@polyrouter/design-kit';

/** The full Settings screen: instance/session info and notification channels
 * (SMTP / Apprise) with per-channel enable, test-send and event
 * subscriptions. Self-loads the Ops email + ntfy push channels. */
export const Default = () => <Settings height={600} />;

/** Same screen scoped to the dashboard's dark token set. */
export const Dark = () => <Settings height={600} theme="dark" />;
