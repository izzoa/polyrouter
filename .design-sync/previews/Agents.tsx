import * as React from 'react';
import { Agents } from '@polyrouter/design-kit';

/** The full Agents screen: each connected agent (name, platform, key prefix,
 * 24h requests + spend) with rotate-key / delete actions and the new-agent
 * entry point. Self-loads the openclaw / ci-summarizer / support-bot corpus. */
export const Default = () => <Agents height={430} />;

/** Same screen scoped to the dashboard's dark token set. */
export const Dark = () => <Agents height={430} theme="dark" />;
