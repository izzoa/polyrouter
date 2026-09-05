/**
 * The OpenAI-compatible batch object (add-batch-inference task 3.6): what an
 * existing OpenAI batch poller reads unchanged — `id`, `object: "batch"`,
 * `status`, `request_counts`, the timestamps — with the file-plane fields
 * present but null (there is no file plane) and `results_url` in their place
 * once the job is completed (D25). Metadata only: no item, no result, no id a
 * client authored.
 */
import { createHash } from 'node:crypto';
import type { BatchItemOutcome, ProtocolAdapter } from '@polyrouter/data-plane';
import { isBatchJobTerminal, type BatchJobStatus } from '@polyrouter/shared';
import type { BatchJobRow } from '@polyrouter/shared/server';

/** polyrouter's two pre-acceptance states read as `validating` to a client —
 * the OpenAI vocabulary has no earlier state, and both mean "accepted, not yet
 * running upstream". */
export function clientStatus(status: BatchJobStatus): string {
  return status === 'submitting' || status === 'submission_unknown' ? 'validating' : status;
}

function unix(d: Date | null): number | null {
  return d === null ? null : Math.floor(d.getTime() / 1000);
}

export function renderBatchObject(
  row: BatchJobRow,
  externalModelId: string,
): Record<string, unknown> {
  const status = row.status as BatchJobStatus;
  const terminalAt = isBatchJobTerminal(status) ? row.terminalAt : null;
  return {
    id: row.id,
    object: 'batch',
    endpoint: row.endpoint,
    errors: null,
    input_file_id: null,
    completion_window: `${String(Math.max(1, Math.round(row.completionWindowMs / 3_600_000)))}h`,
    status: clientStatus(status),
    output_file_id: null,
    error_file_id: null,
    created_at: unix(row.submittedAt),
    in_progress_at: null,
    expires_at: unix(new Date(row.submittedAt.getTime() + row.completionWindowMs)),
    finalizing_at: null,
    completed_at: status === 'completed' ? unix(terminalAt) : null,
    failed_at: status === 'failed' ? unix(terminalAt) : null,
    expired_at: status === 'expired' ? unix(terminalAt) : null,
    cancelling_at: null,
    cancelled_at: status === 'cancelled' ? unix(terminalAt) : null,
    request_counts: {
      total: row.itemCount,
      completed: row.completedCount,
      failed: row.failedCount,
    },
    metadata: null,
    model: externalModelId,
    results_url: status === 'completed' ? `/v1/batches/${row.id}/results` : null,
    results_expire_at: unix(row.resultsExpireAt),
    // A fixed taxonomy token, never upstream text.
    error:
      row.errorKind === null
        ? null
        : { code: row.errorKind, message: `batch ${status}: ${row.errorKind}` },
  };
}

/**
 * One line of the results stream (add-batch-inference task 4.5), in the OpenAI
 * output-file line shape an SDK user would have downloaded from `files.content()`
 * — minus the file. `body` is serialized in the CALLER's protocol (the batch's
 * `endpoint`), `custom_id` is preserved verbatim, and exactly one of `response`
 * or `error` is populated.
 *
 * A failed item carries the taxonomy kind and the upstream status only: the
 * upstream's own message may quote the prompt, so it is never passed through
 * (invariant 8 governs what polyrouter emits about an item, not just what it
 * stores).
 */
export function resultLine(
  job: BatchJobRow,
  outcome: BatchItemOutcome,
  client: ProtocolAdapter,
): Record<string, unknown> {
  const base = {
    id: `batch_req_${itemLineId(job.id, outcome.customId)}`,
    custom_id: outcome.customId,
  };
  if (outcome.ok) {
    return {
      ...base,
      response: {
        status_code: outcome.statusCode,
        request_id: null,
        body: client.responseOut(outcome.response),
      },
      error: null,
    };
  }
  return {
    ...base,
    response: null,
    error: {
      code: outcome.kind,
      message: `the provider did not complete this item (${outcome.kind})`,
      ...(outcome.statusCode !== null ? { status_code: outcome.statusCode } : {}),
    },
  };
}

/** A stable, opaque per-item line id. Derived like the ledger row's id so the two
 * can be correlated by a caller that keeps its own `custom_id` mapping — and,
 * being a digest, it carries the client's id nowhere. */
function itemLineId(jobId: string, customId: string): string {
  return createHash('sha256').update(jobId).update('|').update(customId).digest('hex').slice(0, 24);
}
