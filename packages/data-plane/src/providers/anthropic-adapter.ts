/** Anthropic-compatible provider adapter: `x-api-key` + version header,
 * `/v1/messages` + `/v1/models`, with a `max_tokens` default for #5. */
import { createAnthropicAdapter } from '../proxy/translate';
import { ProviderError } from './errors';
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
  // OAuth subscriptions (add-subscription-oauth): Anthropic OAuth tokens authenticate
  // with Bearer + the preset's anthropic-beta value — NOT x-api-key. The beta value is
  // trusted preset-registry data threaded via ProviderConfig; requiring it here means a
  // misconfigured oauth_bearer build fails typed instead of sending a header-less call.
  if (config.authScheme === 'oauth_bearer' && config.oauthBeta === undefined) {
    // Typed + breaker-neutral: a missing beta value is a configuration/credential
    // wiring bug, not upstream ill health.
    throw new ProviderError('credential', 'anthropic oauth_bearer requires the preset oauthBeta value');
  }
  const authHeaders =
    config.authScheme === 'oauth_bearer'
      ? (credential: string): Record<string, string> => ({
          Authorization: `Bearer ${credential}`,
          'anthropic-beta': config.oauthBeta!,
          'anthropic-version': ANTHROPIC_VERSION,
        })
      : (credential: string): Record<string, string> => ({
          'x-api-key': credential,
          'anthropic-version': ANTHROPIC_VERSION,
        });
  return createHttpProviderAdapter(config, deps, {
    protocol: 'anthropic_compatible',
    translate,
    chatPath: '/v1/messages',
    modelsPath: '/v1/models',
    authHeaders,
    parseModels: (json) => parseModelList(json, 'display_name'),
    // Anthropic's /v1/models is cursor-paginated (`has_more` + `last_id`, followed via
    // `after_id`) — follow the pages so a large catalog isn't truncated (A-12).
    modelsPagination: {
      param: 'after_id',
      nextCursor: (json) => {
        if (typeof json !== 'object' || json === null) return null;
        const rec = json as Record<string, unknown>;
        return rec['has_more'] === true && typeof rec['last_id'] === 'string' ? rec['last_id'] : null;
      },
    },
  });
}
