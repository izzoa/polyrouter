/** Anthropic-compatible provider adapter: `x-api-key` + version header,
 * `/v1/messages` + `/v1/models`, with a `max_tokens` default for #5. */
import { createAnthropicAdapter } from '../proxy/translate';
import type { ProviderAdapter, ProviderConfig } from './adapter';
import { createHttpProviderAdapter, parseModelList, type AdapterDeps } from './http-adapter';

const ANTHROPIC_VERSION = '2023-06-01';

export function createAnthropicProviderAdapter(
  config: ProviderConfig,
  deps: AdapterDeps = {},
): ProviderAdapter {
  const translate = createAnthropicAdapter(
    config.quirks ?? {},
    config.defaultMaxOutputTokens !== undefined
      ? { defaultMaxOutputTokens: config.defaultMaxOutputTokens }
      : {},
  );
  return createHttpProviderAdapter(config, deps, {
    protocol: 'anthropic_compatible',
    translate,
    chatPath: '/v1/messages',
    modelsPath: '/v1/models',
    authHeaders: (credential) => ({
      'x-api-key': credential,
      'anthropic-version': ANTHROPIC_VERSION,
    }),
    parseModels: (json) => parseModelList(json, 'display_name'),
  });
}
