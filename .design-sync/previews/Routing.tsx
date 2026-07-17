import * as React from 'react';
import { Routing } from '@polyrouter/design-kit';

/** The full Routing screen: tier cards with ordered model chains
 * (primary → fallbacks), header rules for `x-polyrouter-tier`, and the
 * auto-routing layer toggles (structural / cascade). */
export const Default = () => <Routing height={700} />;

/** Same screen scoped to the dashboard's dark token set. */
export const Dark = () => <Routing height={700} theme="dark" />;
