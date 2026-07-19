/** Selects a provider adapter by protocol and rejects local providers outside
 * self-host mode (SSRF context alone would not stop a local kind with a public
 * URL under MODE=cloud). */
import type { ProviderAdapter, ProviderConfig } from './adapter';
import { createOpenaiProviderAdapter } from './openai-adapter';
import { createAnthropicProviderAdapter } from './anthropic-adapter';
import { createResponsesProviderAdapter } from './responses-adapter';
import type { AdapterDeps } from './http-adapter';

export function createProviderAdapter(
  config: ProviderConfig,
  deps: AdapterDeps = {},
): ProviderAdapter {
  if (config.kind === 'local' && config.mode !== 'selfhosted') {
    throw new Error('local providers are only available when MODE=selfhosted');
  }
  if (config.protocol === 'openai_responses') {
    return createResponsesProviderAdapter(config, deps);
  }
  return config.protocol === 'openai_compatible'
    ? createOpenaiProviderAdapter(config, deps)
    : createAnthropicProviderAdapter(config, deps);
}
