import * as React from 'react';
import { Requests } from '@polyrouter/design-kit';

/** The full Requests screen: filter chips (all / explicit / auto / fallback /
 * escalated), the request-log table with decision-layer chips and immutable
 * price snapshots, and Load-more pagination — live against the demo corpus. */
export const Default = () => <Requests height={720} />;

/** Same request log on the dark token set — decision-layer chips (explicit /
 * header / default / structural / cascade) and status colors on dark rows. */
export const Dark = () => <Requests theme="dark" height={720} />;
