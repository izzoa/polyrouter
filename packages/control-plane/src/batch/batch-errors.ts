/**
 * The batch error taxonomy (add-batch-inference task 3.7): total by construction —
 * `BATCH_ERROR_MAP` is a `Record` over the closed kind union, so a kind without a
 * mapping does not compile. Every entry is a fixed message with a status that
 * carries the distinction into the Anthropic envelope (which renders no `code`).
 * Budget-exceeded (402) and enforcement-unavailable (503) reuse the proxy's own
 * constructors; a failed submit reuses the provider-error taxonomy.
 */
import { ProxyError, type ClientProtocol } from '../proxy/proxy-errors';
import type { BudgetHit } from '../budgets/budget-service';

export type BatchErrorKind =
  | 'batch_not_supported'
  | 'batch_auto_not_allowed'
  | 'batch_too_large'
  | 'batch_item_invalid'
  | 'batch_invalid'
  | 'batch_unbounded'
  | 'batch_not_found'
  | 'batch_not_ready'
  | 'batch_results_expired';

interface Mapped {
  readonly status: number;
  readonly message: string;
  readonly type: string;
}

export const BATCH_ERROR_MAP: Readonly<Record<BatchErrorKind, Mapped>> = {
  batch_not_supported: {
    status: 400,
    message: 'the resolved provider has no batch API (or batches are disabled)',
    type: 'invalid_request_error',
  },
  batch_auto_not_allowed: {
    status: 400,
    message: 'a batch must name an explicit model or tier; "auto" is not accepted',
    type: 'invalid_request_error',
  },
  batch_too_large: {
    status: 413,
    message: 'batch exceeds the configured item or byte bound',
    type: 'invalid_request_error',
  },
  batch_item_invalid: {
    status: 400,
    message: 'invalid batch item',
    type: 'invalid_request_error',
  },
  batch_invalid: {
    status: 400,
    message: 'invalid batch submission',
    type: 'invalid_request_error',
  },
  batch_unbounded: {
    status: 400,
    message:
      'the batch cost cannot be bounded under a block budget: set max_tokens on every item or use a model with a known batch rate and output cap',
    type: 'invalid_request_error',
  },
  batch_not_found: {
    status: 404,
    message: 'batch not found',
    type: 'invalid_request_error',
  },
  batch_not_ready: {
    status: 409,
    message: 'batch results are not ready',
    type: 'invalid_request_error',
  },
  batch_results_expired: {
    status: 410,
    message: 'batch results are no longer available upstream',
    type: 'invalid_request_error',
  },
};

/** ASCII control characters and DEL — built from code points so the source
 * itself carries none. */
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  'g',
);

/** A client-authored `custom_id` echoed back to its author only: bounded and
 * stripped of control characters so it can never break the envelope. */
export function safeCustomId(id: string): string {
  const cleaned = id.replace(CONTROL_CHARS, '?');
  return cleaned.length > 128 ? `${cleaned.slice(0, 125)}...` : cleaned;
}

/** Build the ProxyError for a batch kind; `detail` names the rule (and, for an
 * item error, the offending `custom_id`). */
export function batchError(kind: BatchErrorKind, detail?: string): ProxyError {
  const m = BATCH_ERROR_MAP[kind];
  const message = detail !== undefined ? `${m.message}: ${detail}` : m.message;
  return new ProxyError(m.status, message, m.type, kind);
}

export function batchItemError(customId: string | null, rule: string): ProxyError {
  const who = customId === null ? 'an item without a custom_id' : `"${safeCustomId(customId)}"`;
  return batchError('batch_item_invalid', `${who} ${rule}`);
}

/** The block-budget rejection for a submission — names the budget, its reset,
 * AND the ceiling that did not fit (the synchronous 402 names the first two). */
export function batchBudgetBlocked(hit: BudgetHit, ceilingMicros: number): ProxyError {
  const ceiling = (ceilingMicros / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return new ProxyError(
    402,
    `budget exceeded: ${hit.budget.name} (resets ${hit.resetAt.toISOString()}; batch ceiling $${ceiling})`,
    'invalid_request_error',
    'budget_exceeded',
  );
}

/** The client protocol a batch's `endpoint` implies — the envelope for every
 * failure raised AFTER the endpoint is known (D22). */
export function protocolForEndpoint(endpoint: string): ClientProtocol {
  return endpoint === '/v1/messages' ? 'anthropic' : 'openai';
}
