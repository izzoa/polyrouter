import * as React from 'react';
import { Setup } from '@polyrouter/design-kit';

/** The three-step onboarding guide (mint an agent key → connect a provider →
 * verify a routed request), open at step one — fully interactive against the
 * demo backend. */
export const Guide = () => <Setup />;

/** Same onboarding guide in the dark token set. */
export const Dark = () => <Setup theme="dark" />;
