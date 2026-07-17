import * as React from 'react';
import { Limits } from '@polyrouter/design-kit';

/** The full Limits screen: spend budgets (global or per-agent, day/week/month)
 * that alert or hard-block, with their notification channels and enable
 * toggles. Self-loads the Monthly cap + openclaw/day budgets. */
export const Default = () => <Limits height={340} />;

/** Same screen scoped to the dashboard's dark token set. */
export const Dark = () => <Limits height={340} theme="dark" />;
