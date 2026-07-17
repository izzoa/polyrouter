import * as React from 'react';
import { Costs } from '@polyrouter/design-kit';

/** The full Costs screen: the spend summary for the selected range plus the
 * by-model, by-provider and by-agent breakdown bars (free local rows shown
 * green with their would-have-cost). Self-loads the demo spend corpus. */
export const Default = () => <Costs height={720} />;

/** Dark-theme spend breakdown — bar fills and free-row green on dark panels. */
export const Dark = () => <Costs theme="dark" height={720} />;
