/** OpenAI-compatible provider adapter: bearer auth, `/chat/completions` + `/models`. */
import { openaiAdapter, createOpenaiAdapter } from '../proxy/translate';
import type { ProviderAdapter, ProviderConfig } from './adapter';
import { createHttpProviderAdapter, parseModelList, type AdapterDeps } from './http-adapter';

export function createOpenaiProviderAdapter(
  config: ProviderConfig,
  deps: AdapterDeps = {},
): ProviderAdapter {
  const translate =
    config.quirks !== undefined ? createOpenaiAdapter(config.quirks) : openaiAdapter;
  return createHttpProviderAdapter(config, deps, {
    protocol: 'openai_compatible',
    translate,
    chatPath: '/chat/completions',
    modelsPath: '/models',
    authHeaders: (credential) => ({ Authorization: `Bearer ${credential}` }),
    parseModels: (json) => parseModelList(json),
  });
}
