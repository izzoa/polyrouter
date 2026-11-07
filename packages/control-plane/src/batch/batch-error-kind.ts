import type { ProviderErrorKind } from '@polyrouter/data-plane';
import type { BatchJobErrorKind } from '@polyrouter/shared';

/**
 * The compile-time link between the provider-error taxonomy and the batch-job error
 * vocabulary (classify-plan-quota-errors, design D12).
 *
 * `batch_job.error_kind` is CHECK-constrained by `BATCH_JOB_ERROR_KINDS`, a hand-kept
 * mirror of `PROVIDER_ERROR_KINDS` with no type link. A total `Record` closes that gap: a
 * future `ProviderErrorKind` without a batch mapping is a BUILD error here, not a CHECK
 * violation at runtime.
 *
 * Each pre-existing kind maps to itself. The four plan kinds (dialect-only, never raised on
 * a batch path because a subscription row never batches, `factory.ts` refuses it first) map
 * to `upstream_rejected`: truthful for a submit the upstream answered with a refusal the
 * batch vocabulary does not model, and a terminal `failed` like any rejected create. The
 * CHECK and `BATCH_JOB_ERROR_KINDS` are unchanged, so there is no migration.
 */
export const BATCH_KIND_OF: Readonly<Record<ProviderErrorKind, BatchJobErrorKind>> = {
  auth: 'auth',
  permission: 'permission',
  rate_limit: 'rate_limit',
  unavailable: 'unavailable',
  bad_request: 'bad_request',
  unknown_model: 'unknown_model',
  insufficient_funds: 'insufficient_funds',
  content_policy: 'content_policy',
  policy_block: 'policy_block',
  upstream_rejected: 'upstream_rejected',
  oversized_response: 'oversized_response',
  credential: 'credential',
  quota_exhausted: 'upstream_rejected',
  risk_control: 'upstream_rejected',
  plan_entitlement: 'upstream_rejected',
  plan_inactive: 'upstream_rejected',
};
