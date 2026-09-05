/**
 * Batch-job vocabulary (add-batch-inference). Shared by the schema CHECKs, the
 * persistence seam, the poller, the API's batch object, and the dashboard — one
 * definition, so a status the database admits is exactly a status the code
 * handles, and vice versa.
 */

/** A job's lifecycle. `submitting` → (`submission_unknown`) → `validating` →
 * `in_progress` → `finalizing` → a terminal state; `cancelling` holds until the
 * partial settlement is durable. Terminal means DEFINITIVE — the upstream said so
 * and settlement is durable — never a local guess. */
export const BATCH_JOB_STATUSES = [
  'submitting',
  'submission_unknown',
  'validating',
  'in_progress',
  'finalizing',
  'completed',
  'failed',
  'expired',
  'cancelling',
  'cancelled',
] as const;
export type BatchJobStatus = (typeof BATCH_JOB_STATUSES)[number];

/** The states in which a job holds no further work — and no reservation. */
export const BATCH_JOB_TERMINAL_STATUSES = ['completed', 'failed', 'expired', 'cancelled'] as const;
export type BatchJobTerminalStatus = (typeof BATCH_JOB_TERMINAL_STATUSES)[number];

export function isBatchJobTerminal(status: BatchJobStatus): status is BatchJobTerminalStatus {
  return (BATCH_JOB_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** The shape of every item in a batch — the caller's protocol. */
export const BATCH_ENDPOINTS = ['/v1/chat/completions', '/v1/messages'] as const;
export type BatchEndpoint = (typeof BATCH_ENDPOINTS)[number];

/** Why a job failed, fixed vocabulary: the provider-error taxonomy for a rejected
 * submit (mirrors `PROVIDER_ERROR_KINDS` in the data plane, which cannot be
 * imported here), plus the batch-only kinds. */
export const BATCH_JOB_ERROR_KINDS = [
  // provider-error taxonomy — a rejected create classifies like any provider call
  'auth',
  'permission',
  'rate_limit',
  'unavailable',
  'bad_request',
  'unknown_model',
  'insufficient_funds',
  'content_policy',
  'policy_block',
  'upstream_rejected',
  'credential',
  // batch-only
  'submit_lost', // the upstream provably never received the create
  'submit_unresolved', // reconciliation window elapsed with no answer either way
  'upstream_status_unknown', // an unmapped upstream status; NOT terminal on its own
  'provider_missing', // the provider row was deleted while the job was in flight
] as const;
export type BatchJobErrorKind = (typeof BATCH_JOB_ERROR_KINDS)[number];
