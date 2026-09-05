/**
 * The optional batch seam (add-batch-inference; provider-adapters delta). An
 * adapter MAY expose `batch` when its provider family has an asynchronous batch
 * API; the factory decides presence from the family, so a custom/local provider
 * never carries one. Items are the SAME `Normalized*` IR the chat path consumes
 * and are serialized by the translate module — the seam defines no request shape
 * of its own (invariant 2). Results stream per item, beyond the buffered-response
 * byte cap: no adapter ever buffers a whole result set.
 */
import type { BatchJobStatus } from '@polyrouter/shared';
import type { NormalizedRequest, NormalizedResponse } from '../proxy/translate';
import type { CallContext } from './adapter';
import type { ProviderErrorKind } from './errors';

/** What an upstream can report: the job vocabulary minus polyrouter's two local
 * pre-acceptance states. */
export type BatchUpstreamStatus = Exclude<BatchJobStatus, 'submitting' | 'submission_unknown'>;

export interface BatchItem {
  /** The client-authored id, echoed by the upstream on every result line. Passes
   * through memory only — never stored, logged, or put in an error (D2). */
  readonly customId: string;
  readonly request: NormalizedRequest;
}

export interface BatchSubmitInput {
  readonly items: readonly BatchItem[];
  /** The external model id every item runs on. */
  readonly model: string;
  /** polyrouter's job id: the idempotency key where the upstream honours one, and
   * the metadata echo reconciliation searches for (D6). */
  readonly jobId: string;
}

export interface BatchSubmitResult {
  readonly upstreamId: string;
  readonly status: BatchUpstreamStatus | null;
  /** The provider's declared completion window for this job. */
  readonly completionWindowMs: number;
  /** The upstream's results-retention deadline, or null when it states none (D23). */
  readonly resultsExpireAt: Date | null;
}

export interface BatchCounts {
  readonly total: number;
  readonly completed: number;
  readonly failed: number;
}

export interface BatchStatusView {
  /** The mapped status, or null when the upstream's value has NO mapping — the
   * caller records `upstream_status_unknown` and keeps polling; null is never
   * terminal (D21). */
  readonly status: BatchUpstreamStatus | null;
  readonly counts: BatchCounts | null;
  readonly resultsExpireAt: Date | null;
}

/** One item's outcome, extracted from the results stream. A failed item carries
 * the taxonomy kind and the upstream status code only — never the upstream's
 * message text (the results pass-through renders a fixed message per kind). */
export type BatchItemOutcome =
  | {
      readonly customId: string;
      readonly ok: true;
      readonly statusCode: number;
      readonly response: NormalizedResponse;
    }
  | {
      readonly customId: string;
      readonly ok: false;
      readonly statusCode: number | null;
      readonly kind: ProviderErrorKind;
    };

/** One upstream job as its listing reports it — enough for `submission_unknown`
 * reconciliation to find a job by the id polyrouter attached at create time. */
export interface BatchListEntry {
  readonly upstreamId: string;
  /** polyrouter's job id if the upstream echoes it (idempotency key / metadata), else null. */
  readonly jobId: string | null;
  readonly status: BatchUpstreamStatus | null;
}

/** The upstream no longer knows the job (retention ended, or it was never
 * created). Distinct from a provider fault: a caller maps it to `results_expired`
 * / `submit_lost` rather than to the breaker-classified taxonomy. */
export class BatchUpstreamNotFoundError extends Error {
  constructor(message = 'upstream batch not found') {
    super(message);
    this.name = 'BatchUpstreamNotFoundError';
  }
}

/** What an upstream accepts, so the ingress can refuse BEFORE a job row exists.
 * Null = the upstream documents no bound (polyrouter's own config still applies). */
export interface BatchLimits {
  readonly maxItems: number | null;
  readonly maxBytes: number | null;
  /** A `custom_id` grammar the upstream enforces (Anthropic: `^[a-zA-Z0-9_-]{1,64}$`). */
  readonly customIdPattern: RegExp | null;
  /** The upstream's completion window (both shipped APIs: 24h) — declared, so
   * the job row can carry it BEFORE the create (the D6 order). */
  readonly completionWindowMs: number;
}

export interface BatchAdapter {
  readonly limits: BatchLimits;
  /** Create the upstream job. Classifies through the provider-error taxonomy like
   * any provider call (a rejected create is an ordinary upstream failure). */
  submit(input: BatchSubmitInput, ctx?: CallContext): Promise<BatchSubmitResult>;
  /** Breaker-neutral status probe (D14). */
  status(upstreamId: string, ctx?: CallContext): Promise<BatchStatusView>;
  /** Streamed per-item outcomes keyed by the echoed `custom_id`; NOT subject to
   * the buffered byte cap; may repeat a `custom_id` (the caller deduplicates). */
  results(upstreamId: string, ctx?: CallContext): AsyncIterable<BatchItemOutcome>;
  /** Bounded, most-recent-first listing for reconciliation (D6). */
  list(ctx?: CallContext): Promise<readonly BatchListEntry[]>;
  cancel(upstreamId: string, ctx?: CallContext): Promise<void>;
}

/**
 * Map an upstream's status token through a per-adapter table into the fixed
 * vocabulary. The table is typed over the upstream's DOCUMENTED status list, so
 * the compiler enforces totality over that list; anything outside it (a new value
 * the upstream ships tomorrow) is null — recorded as `upstream_status_unknown`,
 * never guessed terminal.
 */
export function mapUpstreamStatus<K extends string>(
  table: Readonly<Record<K, BatchUpstreamStatus>>,
  raw: unknown,
): BatchUpstreamStatus | null {
  if (typeof raw !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(table, raw) ? table[raw as K] : null;
}
