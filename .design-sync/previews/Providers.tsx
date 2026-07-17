import * as React from 'react';
import { Providers } from '@polyrouter/design-kit';

/** The full Providers screen: connected providers (kind, protocol, base URL,
 * health) with test/sync/delete actions and per-provider model lists (context
 * window, capabilities, prices). Self-loads Anthropic / OpenAI / Ollama. */
export const Default = () => <Providers height={410} />;

/** Same screen scoped to the dashboard's dark token set. */
export const Dark = () => <Providers height={410} theme="dark" />;
