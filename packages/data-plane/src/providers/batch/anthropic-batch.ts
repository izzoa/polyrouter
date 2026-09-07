import { BATCH_COMPLETION_WINDOW_MS } from '@polyrouter/shared';
/**
 * Anthropic's Message Batches API (`/v1/messages/batches`, add-batch-inference
 * task 2.9): `requests[{ custom_id, params }]`, a three-state
 * `processing_status` whose `ended` resolves through `request_counts`, results
 * streamed as JSONL from the batch's own `/results` path, a newest-first list,
 * and cancellation via `/cancel`. Limits and retention per the published guide
 * (2026-09): 100,000 requests or 256 MB; results readable for 29 days; every
 * `custom_id` must match `^[a-zA-Z0-9_-]{1,64}$`.
 */
import type { NormalizedResponse } from '../../proxy/translate';
import type { BatchCounts, BatchItemOutcome, BatchListEntry, BatchUpstreamStatus } from '../batch';
import type { ProviderErrorKind } from '../errors';
import { joinUrl } from '../http';
import { bytesOf, readJsonLines } from './json-stream';
import {
  asDate,
  asNumber,
  asRecord,
  asString,
  batchCall,
  malformed,
  streamJsonDocument,
} from './support';
import type { BatchFactory } from './transport';

export const ANTHROPIC_PROCESSING_STATUSES = ['in_progress', 'canceling', 'ended'] as const;
export type AnthropicProcessingStatus = (typeof ANTHROPIC_PROCESSING_STATUSES)[number];

interface AnthropicCounts {
  readonly processing: number;
  readonly succeeded: number;
  readonly errored: number;
  readonly canceled: number;
  readonly expired: number;
}

/** `ended` is definitive but not self-describing: the tallies say whether the
 * batch was cancelled, expired wholesale, or completed (possibly partially —
 * expired/cancelled items are simply not among the results). */
function resolveEnded(
  counts: AnthropicCounts | null,
  cancelInitiated: boolean,
): BatchUpstreamStatus {
  if (cancelInitiated || (counts !== null && counts.canceled > 0)) return 'cancelled';
  if (counts !== null && counts.succeeded + counts.errored === 0 && counts.expired > 0)
    return 'expired';
  return 'completed';
}

/** Total over the documented enum — a value outside it is null (D21). */
const STATUS_RESOLVERS: Readonly<
  Record<
    AnthropicProcessingStatus,
    (counts: AnthropicCounts | null, cancelInitiated: boolean) => BatchUpstreamStatus
  >
> = {
  in_progress: () => 'in_progress',
  canceling: () => 'cancelling',
  ended: resolveEnded,
};

export function mapAnthropicStatus(
  raw: unknown,
  counts: AnthropicCounts | null,
  cancelInitiated: boolean,
): BatchUpstreamStatus | null {
  if (typeof raw !== 'string' || !Object.prototype.hasOwnProperty.call(STATUS_RESOLVERS, raw))
    return null;
  return STATUS_RESOLVERS[raw as AnthropicProcessingStatus](counts, cancelInitiated);
}

/** Per-item error types → the taxonomy (the message is never kept). */
const ERROR_KINDS: Readonly<Record<string, ProviderErrorKind>> = {
  invalid_request_error: 'bad_request',
  authentication_error: 'auth',
  billing_error: 'insufficient_funds',
  permission_error: 'permission',
  not_found_error: 'unknown_model',
  rate_limit_error: 'rate_limit',
  timeout_error: 'unavailable',
  api_error: 'unavailable',
  overloaded_error: 'unavailable',
};

export function anthropicErrorKind(type: unknown): ProviderErrorKind {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(ERROR_KINDS, type)
    ? ERROR_KINDS[type]!
    : 'upstream_rejected';
}

/** "Batches expire if processing does not complete within 24 hours." */
/** The shared window (add-batch-mode-help): one declaration the dashboard reads too,
 * so this provider and the help text cannot state different figures. */
const COMPLETION_WINDOW_MS = BATCH_COMPLETION_WINDOW_MS;
/** "Batch results are available for 29 days after creation." */
const RETENTION_MS = 29 * 86_400_000;
/** One JSONL result line (a whole message) — bounded like any value. */
const MAX_LINE_BYTES = 32 * 1024 * 1024;

export const ANTHROPIC_CUSTOM_ID = /^[a-zA-Z0-9_-]{1,64}$/;

interface MessageBatchMeta {
  readonly id: string;
  readonly status: BatchUpstreamStatus | null;
  readonly counts: BatchCounts | null;
  readonly resultsExpireAt: Date | null;
}

function parseCounts(rc: Record<string, unknown> | null): AnthropicCounts | null {
  if (rc === null) return null;
  const n = (k: string): number | null => asNumber(rc[k]);
  const processing = n('processing');
  const succeeded = n('succeeded');
  const errored = n('errored');
  const canceled = n('canceled');
  const expired = n('expired');
  if (
    processing === null ||
    succeeded === null ||
    errored === null ||
    canceled === null ||
    expired === null
  ) {
    return null;
  }
  return { processing, succeeded, errored, canceled, expired };
}

export function parseMessageBatch(raw: unknown): MessageBatchMeta {
  const rec = asRecord(raw);
  const id = rec !== null ? asString(rec['id']) : null;
  if (rec === null || id === null) throw malformed('message batch');
  const counts = parseCounts(asRecord(rec['request_counts']));
  const cancelInitiated = asDate(rec['cancel_initiated_at']) !== null;
  const archivedAt = asDate(rec['archived_at']);
  const createdAt = asDate(rec['created_at']);
  return {
    id,
    status: mapAnthropicStatus(rec['processing_status'], counts, cancelInitiated),
    counts:
      counts !== null
        ? {
            total:
              counts.processing +
              counts.succeeded +
              counts.errored +
              counts.canceled +
              counts.expired,
            completed: counts.succeeded,
            failed: counts.errored,
          }
        : null,
    // The archive stamp is authoritative once present; before that, the documented
    // 29-day window from creation.
    resultsExpireAt:
      archivedAt ?? (createdAt !== null ? new Date(createdAt.getTime() + RETENTION_MS) : null),
  };
}

function toOutcome(
  responseIn: (wire: unknown) => NormalizedResponse,
  raw: unknown,
): BatchItemOutcome | 'skip' | null {
  const rec = asRecord(raw);
  const customId = rec !== null ? asString(rec['custom_id']) : null;
  const result = rec !== null ? asRecord(rec['result']) : null;
  if (rec === null || customId === null || result === null) return null;
  const type = result['type'];
  if (type === 'succeeded') {
    try {
      return {
        customId,
        ok: true,
        statusCode: 200,
        response: responseIn(result['message']),
      };
    } catch {
      return { customId, ok: false, statusCode: 200, kind: 'upstream_rejected' };
    }
  }
  if (type === 'errored') {
    const envelope = asRecord(result['error']);
    const inner = envelope !== null ? asRecord(envelope['error']) : null;
    return { customId, ok: false, statusCode: null, kind: anthropicErrorKind(inner?.['type']) };
  }
  // `canceled` / `expired`: the item never ran — neither recorded nor charged.
  return 'skip';
}

export const createAnthropicBatchAdapter: BatchFactory = (t) => {
  const batches = joinUrl(t.baseUrl, '/v1/messages/batches');
  const byId = (id: string): string => `${batches}/${encodeURIComponent(id)}`;

  return {
    limits: {
      maxItems: 100_000,
      maxBytes: 256_000_000,
      customIdPattern: ANTHROPIC_CUSTOM_ID,
      completionWindowMs: COMPLETION_WINDOW_MS,
    },

    async submit(input, ctx) {
      const model = input.model;
      const items = (function* (): Generator<unknown> {
        for (const item of input.items) {
          yield {
            custom_id: item.customId,
            params: t.translate.requestOut({ ...item.request, model, stream: false }),
          };
        }
      })();
      const body = streamJsonDocument({}, 'requests', items);
      const { res, dispose } = await batchCall(
        t,
        batches,
        { method: 'POST', body, notFoundIsBatch: false, idempotencyKey: input.jobId },
        ctx,
      );
      try {
        const meta = parseMessageBatch(await res.json());
        return {
          upstreamId: meta.id,
          status: meta.status,
          completionWindowMs: COMPLETION_WINDOW_MS,
          resultsExpireAt: meta.resultsExpireAt,
        };
      } finally {
        dispose();
      }
    },

    async status(id, ctx) {
      const { res, dispose } = await batchCall(
        t,
        byId(id),
        { method: 'GET', notFoundIsBatch: true },
        ctx,
      );
      try {
        const meta = parseMessageBatch(await res.json());
        return { status: meta.status, counts: meta.counts, resultsExpireAt: meta.resultsExpireAt };
      } finally {
        dispose();
      }
    },

    async *results(id, ctx) {
      // The batch's own `/results` path — never a `results_url` echoed by the
      // upstream, so the credential can only ever go to the configured origin.
      const { res, dispose } = await batchCall(
        t,
        `${byId(id)}/results`,
        { method: 'GET', notFoundIsBatch: true },
        ctx,
      );
      try {
        for await (const line of readJsonLines(bytesOf(res.body), MAX_LINE_BYTES)) {
          const outcome = toOutcome((wire) => t.translate.responseIn(wire), line);
          if (outcome === null || outcome === 'skip') continue;
          yield outcome;
        }
      } finally {
        dispose();
      }
    },

    async list(ctx) {
      const { res, dispose } = await batchCall(
        t,
        `${batches}?limit=100`,
        { method: 'GET', notFoundIsBatch: false },
        ctx,
      );
      try {
        const json = asRecord(await res.json());
        const data =
          json !== null && Array.isArray(json['data']) ? (json['data'] as unknown[]) : [];
        const out: BatchListEntry[] = [];
        for (const raw of data) {
          const rec = asRecord(raw);
          const id = rec !== null ? asString(rec['id']) : null;
          if (rec === null || id === null) continue;
          const counts = parseCounts(asRecord(rec['request_counts']));
          // No metadata echo on a Message Batch: a job cannot be matched by id here.
          out.push({
            upstreamId: id,
            jobId: null,
            status: mapAnthropicStatus(
              rec['processing_status'],
              counts,
              asDate(rec['cancel_initiated_at']) !== null,
            ),
          });
        }
        return out;
      } finally {
        dispose();
      }
    },

    async cancel(id, ctx) {
      const { res, dispose } = await batchCall(
        t,
        `${byId(id)}/cancel`,
        { method: 'POST', notFoundIsBatch: true },
        ctx,
      );
      try {
        await res.text();
      } finally {
        dispose();
      }
    },
  };
};
