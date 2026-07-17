import * as React from 'react';
import { Login } from '@polyrouter/design-kit';

/** The self-hosted auth gate: sign-in / sign-up toggle, email + password, and
 * one button per configured OAuth provider (GitHub, Google) below the divider. */
export const WithOAuth = () => (
  <Login oauthProviders={['github', 'google']} height={640} />
);

/** Email + password only — an instance with no OAuth providers configured
 * (the divider and social buttons drop away). */
export const EmailOnly = () => <Login oauthProviders={[]} height={640} />;
