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
 * Which batch implementation a provider's family and protocol carry, ignoring
 * `kind` (add-batch-mode-routing task 1.1). This is the SERVICING predicate: the
 * seam used to poll, cancel, settle, and read the results of a job the system has
 * ALREADY accepted. It deliberately admits kinds that may no longer submit,
 * because narrowing submission eligibility must never strand accepted work — a
 * job that cannot be polled never terminates, so its budget reservation is held
 * for the rest of its window and its paid-for results become unreadable
 * (`batch-inference`; the same "drain, never strand" rule `BATCH_ENABLED=false`
 * already follows).
 *
 * `custom`/`local` are excluded here too, but for a different reason: they have
 * no batch API to have accepted a job with in the first place.
 */
/** Only the three fields the predicates actually read, so a caller that holds a
 * provider ROW (the dashboard) need not fabricate a whole `ProviderConfig` — and
 * cannot silently mis-state one. `ProviderConfig` satisfies this structurally. */
export type BatchSeamInput = Pick<ProviderConfig, 'kind' | 'protocol' | 'baseUrl'>;

export function servicingBatchFactoryFor(config: BatchSeamInput): BatchFactory | undefined {
  if (config.kind === 'custom' || config.kind === 'local') return undefined;
  const family = deriveProviderFamily(config.baseUrl);
  if (family === 'openrouter') return createOpenRouterBatchAdapter;
  if (family === 'anthropic' && config.protocol === 'anthropic_compatible') {
    return createAnthropicBatchAdapter;
  }
  // OpenAI's file plane, on the API-key wire only. `openai_responses` is the
  // ChatGPT SUBSCRIPTION protocol — it refuses to build without an OAuth
  // credential — so a seam there would promise a surface that cannot exist.
  if (family === 'openai' && config.protocol === 'openai_compatible') {
    return createOpenAiBatchAdapter;
  }
  return undefined;
}

/**
 * Which batch implementation a provider carries for a NEW submission
 * (add-batch-inference task 2.10, narrowed by add-batch-mode-routing task 1.1),
 * derived from its billing family + protocol — never from a caller flag. So a
 * caller can refuse `batch_not_supported` before any upstream call.
 *
 * `kind` is decisive and is tested FIRST. A flat-rate consumer subscription has
 * no Batch API behind it whatever protocol it speaks, and testing the protocol
 * instead only caught ChatGPT by accident: the Claude Pro/Max preset ships
 * `anthropic_compatible` against `api.anthropic.com`, indistinguishable from an
 * API-key provider on family and protocol, and was handed the Anthropic batch
 * adapter — so a submission got a job row and a budget reservation before the
 * upstream rejected a call the plan does not include. Refusing by kind holds for
 * every present and future subscription preset.
 */
export function batchFactoryFor(config: BatchSeamInput): BatchFactory | undefined {
  if (config.kind === 'subscription') return undefined;
  return servicingBatchFactoryFor(config);
}

export function createProviderAdapter(
  config: ProviderConfig,
  suppliedDeps: AdapterDeps = {},
): ProviderAdapter {
  if (config.kind === 'local' && config.mode !== 'selfhosted') {
    throw new Error('local providers are only available when MODE=selfhosted');
  }
  // A test may inject its own batch factory. Otherwise the PURPOSE decides which
  // predicate applies: a job already accepted is serviced under the wider rule, so
  // narrowing submission eligibility cannot strand it.
  const batch =
    suppliedDeps.batch ??
    (suppliedDeps.batchPurpose === 'servicing'
      ? servicingBatchFactoryFor(config)
      : batchFactoryFor(config));
  const deps: AdapterDeps = batch !== undefined ? { ...suppliedDeps, batch } : suppliedDeps;
  if (config.protocol === 'openai_responses') {
    return createResponsesProviderAdapter(config, deps);
  }
  return config.protocol === 'openai_compatible'
    ? createOpenaiProviderAdapter(config, deps)
    : createAnthropicProviderAdapter(config, deps);
}
