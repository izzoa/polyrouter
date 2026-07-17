import * as React from 'react';
import { Overview } from '@polyrouter/design-kit';

/** The canonical polyrouter dashboard: four stat cards (spend / requests /
 * tokens / health), the 24h requests area chart with its range selector,
 * spend-by-model bars, and the recent-requests table with decision-layer
 * chips. Self-loads the demo analytics corpus. */
export const Default = () => <Overview height={720} />;

/** Full dark-theme token coverage — panel / border / text tokens, the accent
 * (#4F5DFF) on the area chart, and the status chips on the dark surface. */
export const Dark = () => <Overview theme="dark" height={720} />;
