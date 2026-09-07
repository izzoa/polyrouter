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

/**
 * The completion window every batch provider polyrouter supports documents: a batch
 * may take up to 24 hours (add-batch-mode-help).
 *
 * ONE declaration, referenced by each adapter and by the dashboard's help text. The
 * adapters each declared their own copy of this number, which meant a fourth adapter
 * with a different window would have left the interface quietly asserting a figure
 * that provider does not honour. Sharing it makes that drift unrepresentable rather
 * than merely detectable: a provider needing a different window has to introduce a
 * per-provider one deliberately, and the test in the data plane fails until it does.
 *
 * It lives here because the frontend depends on `@polyrouter/shared` and NOT on
 * `@polyrouter/data-plane`, so this is the only place both sides can read.
 */
export const BATCH_COMPLETION_WINDOW_MS = 86_400_000;

/** How that window is written for a reader. Kept beside the number so the two cannot
 * disagree — a change to one is a visible change to the other. */
export const BATCH_COMPLETION_WINDOW_TEXT = '24 hours';
