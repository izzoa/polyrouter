/** Selects a provider adapter by protocol and rejects local providers outside
 * self-host mode (SSRF context alone would not stop a local kind with a public
 * URL under MODE=cloud). */
import { deriveProviderFamily } from '@polyrouter/shared/server';
import type { ProviderAdapter, ProviderConfig } from './adapter';
import { createOpenaiProviderAdapter } from './openai-adapter';
import { createAnthropicProviderAdapter } from './anthropic-adapter';
import { createResponsesProviderAdapter } from './responses-adapter';
import type { AdapterDeps } from './http-adapter';
import { createAnthropicBatchAdapter } from './batch/anthropic-batch';
import { createOpenAiBatchAdapter } from './batch/openai-batch';
import { createOpenRouterBatchAdapter } from './batch/openrouter-batch';
import type { BatchFactory } from './batch/transport';

/**
 * Which batch implementation a provider carries (add-batch-inference task 2.10),
 * derived from its billing family + protocol — never from a caller flag. A
 * `custom`/`local` provider and every family without a batch API get none, so
 * a caller can refuse `batch_not_supported` before any upstream call.
 * (`openai` — files + `/v1/batches` — arrives in Phase C.)
 */
export function batchFactoryFor(config: ProviderConfig): BatchFactory | undefined {
  if (config.kind === 'custom' || config.kind === 'local') return undefined;
  const family = deriveProviderFamily(config.baseUrl);
  if (family === 'openrouter') return createOpenRouterBatchAdapter;
  if (family === 'anthropic' && config.protocol === 'anthropic_compatible') {
    return createAnthropicBatchAdapter;
  }
  // OpenAI's file plane (Phase C), on the API-key wire only. `openai_responses`
  // is the ChatGPT SUBSCRIPTION protocol — it refuses to build without an OAuth
  // credential, and a flat-rate plan has no Batch API behind it — so attaching a
  // seam there would promise a surface that cannot exist.
  if (family === 'openai' && config.protocol === 'openai_compatible') {
    return createOpenAiBatchAdapter;
  }
  return undefined;
}

export function createProviderAdapter(
  config: ProviderConfig,
  suppliedDeps: AdapterDeps = {},
): ProviderAdapter {
  if (config.kind === 'local' && config.mode !== 'selfhosted') {
    throw new Error('local providers are only available when MODE=selfhosted');
  }
  // A test may inject its own batch factory; otherwise the family decides.
  const batch = suppliedDeps.batch ?? batchFactoryFor(config);
  const deps: AdapterDeps = batch !== undefined ? { ...suppliedDeps, batch } : suppliedDeps;
  if (config.protocol === 'openai_responses') {
    return createResponsesProviderAdapter(config, deps);
  }
  return config.protocol === 'openai_compatible'
    ? createOpenaiProviderAdapter(config, deps)
    : createAnthropicProviderAdapter(config, deps);
}
