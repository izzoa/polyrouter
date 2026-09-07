import { BATCH_COMPLETION_WINDOW_MS } from '@polyrouter/shared';
/**
 * OpenRouter's Batch API (`/api/beta/batches`, add-batch-inference task 2.8):
 * inline `requests[]` with `endpoint` and `model` serialized FIRST (the API
 * stream-parses and returns 400 otherwise), results INLINED on the GET of a
 * completed batch (no separate download endpoint), a newest-first list, and
 * a 30-day artifact retention. Shape pinned from the published quickstart
 * (2026-09); the cancel route follows the object's OpenAI-compatible
 * conventions and is exercised only through the golden stub.
 */
import type { CallContext, ProviderProtocol } from '../adapter';
import {
  mapUpstreamStatus,
  type BatchCounts,
  type BatchItemOutcome,
  type BatchListEntry,
  type BatchUpstreamStatus,
} from '../batch';
import { bytesOf, scanTopLevelObject } from './json-stream';
import {
  asNumber,
  asRecord,
  asString,
  batchCall,
  kindForStatus,
  malformed,
  streamJsonDocument,
} from './support';
import type { BatchFactory, BatchTransport } from './transport';

/** Every status the quickstart documents; the table is total over this list. */
export const OPENROUTER_BATCH_STATUSES = [
  'validating',
  'in_progress',
  'finalizing',
  'completed',
  'failed',
  'expired',
  'cancelling',
  'cancelled',
] as const;
export type OpenRouterBatchStatus = (typeof OPENROUTER_BATCH_STATUSES)[number];

export const OPENROUTER_STATUS_MAP: Readonly<Record<OpenRouterBatchStatus, BatchUpstreamStatus>> = {
  validating: 'validating',
  in_progress: 'in_progress',
  finalizing: 'finalizing',
  completed: 'completed',
  failed: 'failed',
  expired: 'expired',
  cancelling: 'cancelling',
  cancelled: 'cancelled',
};

/** "The only supported completion window is 24h." */
/** The shared window (add-batch-mode-help): one declaration the dashboard reads too,
 * so this provider and the help text cannot state different figures. */
const COMPLETION_WINDOW_MS = BATCH_COMPLETION_WINDOW_MS;
/** "OpenRouter … deletes them 30 days after creation." */
const RETENTION_MS = 30 * 86_400_000;
/** One inlined result (a whole completion body) or one metadata member. */
const MAX_VALUE_BYTES = 32 * 1024 * 1024;

/** The batch API lives beside `/api/v1`, not under it. */
export function openRouterBatchesUrl(baseUrl: string): string {
  return `${new URL(baseUrl).origin}/api/beta/batches`;
}

/** The upstream item shape is the adapter's OWN wire protocol — the client's
 * endpoint is already translated away by the time items reach the seam. */
function upstreamEndpoint(protocol: ProviderProtocol): string {
  if (protocol === 'anthropic_compatible') return '/v1/messages';
  if (protocol === 'openai_responses') return '/v1/responses';
  return '/v1/chat/completions';
}

interface BatchMeta {
  readonly id: string;
  readonly status: BatchUpstreamStatus | null;
  readonly counts: BatchCounts | null;
  readonly resultsExpireAt: Date | null;
}

function parseBatchObject(members: Record<string, unknown>): BatchMeta {
  const id = asString(members['id']);
  if (id === null) throw malformed('batch object');
  const rc = asRecord(members['request_counts']);
  const total = rc !== null ? asNumber(rc['total']) : null;
  const completed = rc !== null ? asNumber(rc['completed']) : null;
  const failed = rc !== null ? asNumber(rc['failed']) : null;
  const createdAt = asNumber(members['created_at']);
  return {
    id,
    status: mapUpstreamStatus(OPENROUTER_STATUS_MAP, members['status']),
    counts:
      total !== null && completed !== null && failed !== null ? { total, completed, failed } : null,
    resultsExpireAt: createdAt !== null ? new Date(createdAt * 1000 + RETENTION_MS) : null,
  };
}

function toOutcome(t: BatchTransport, raw: unknown): BatchItemOutcome | null {
  const rec = asRecord(raw);
  const customId = rec !== null ? asString(rec['custom_id']) : null;
  // An element without a custom_id cannot be settled to anything; skip it.
  if (rec === null || customId === null) return null;
  const response = asRecord(rec['response']);
  if (response !== null) {
    const statusCode = asNumber(response['status_code']) ?? 200;
    if (statusCode >= 200 && statusCode < 300) {
      try {
        return {
          customId,
          ok: true,
          statusCode,
          response: t.translate.responseIn(response['body']),
        };
      } catch {
        // A success line whose body does not parse as the wire shape: recorded
        // as a failed item, never dropped silently.
        return { customId, ok: false, statusCode, kind: 'upstream_rejected' };
      }
    }
    return {
      customId,
      ok: false,
      statusCode,
      kind: kindForStatus(statusCode, response['body'], t.credential),
    };
  }
  const error = asRecord(rec['error']);
  const status = error !== null ? (asNumber(error['status']) ?? asNumber(error['code'])) : null;
  return {
    customId,
    ok: false,
    statusCode: status,
    kind:
      status !== null && status >= 400
        ? kindForStatus(status, error, t.credential)
        : 'upstream_rejected',
  };
}

export const createOpenRouterBatchAdapter: BatchFactory = (t) => {
  const batches = openRouterBatchesUrl(t.baseUrl);
  const byId = (id: string): string => `${batches}/${encodeURIComponent(id)}`;

  /** The streaming GET: metadata members are collected, `results` elements are
   * handed to `onElement` (or skipped) — the document is never materialized. */
  const readBatch = async (
    id: string,
    ctx: CallContext | undefined,
    onElement?: (el: unknown) => Promise<void>,
  ): Promise<BatchMeta> => {
    const { res, dispose } = await batchCall(
      t,
      byId(id),
      { method: 'GET', notFoundIsBatch: true },
      ctx,
    );
    try {
      const members: Record<string, unknown> = {};
      for await (const ev of scanTopLevelObject(bytesOf(res.body), {
        arrayKeys: ['results'],
        maxValueBytes: MAX_VALUE_BYTES,
      })) {
        if (ev.type === 'member') members[ev.key] = ev.value;
        else if (ev.type === 'element' && onElement !== undefined) await onElement(ev.value);
      }
      return parseBatchObject(members);
    } finally {
      dispose();
    }
  };

  return {
    limits: {
      maxItems: null,
      maxBytes: null,
      customIdPattern: null,
      completionWindowMs: COMPLETION_WINDOW_MS,
    },

    async submit(input, ctx) {
      const model = input.model;
      const items = (function* (): Generator<unknown> {
        for (const item of input.items) {
          yield {
            custom_id: item.customId,
            body: t.translate.requestOut({ ...item.request, model, stream: false }),
          };
        }
      })();
      const body = streamJsonDocument(
        { endpoint: upstreamEndpoint(t.protocol), model },
        'requests',
        items,
      );
      const { res, dispose } = await batchCall(
        t,
        batches,
        { method: 'POST', body, notFoundIsBatch: false, idempotencyKey: input.jobId },
        ctx,
      );
      try {
        const json = asRecord(await res.json());
        if (json === null) throw malformed('batch object');
        const meta = parseBatchObject(json);
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
      // A completed batch inlines its results on this GET; the scanner skips them
      // element by element so the probe stays memory-bounded (D25).
      const meta = await readBatch(id, ctx);
      return { status: meta.status, counts: meta.counts, resultsExpireAt: meta.resultsExpireAt };
    },

    async *results(id, ctx) {
      const queue: BatchItemOutcome[] = [];
      // The scanner is pull-driven: buffering one element at a time through the
      // queue keeps this generator's consumer in control of the pace.
      const { res, dispose } = await batchCall(
        t,
        byId(id),
        { method: 'GET', notFoundIsBatch: true },
        ctx,
      );
      try {
        for await (const ev of scanTopLevelObject(bytesOf(res.body), {
          arrayKeys: ['results'],
          maxValueBytes: MAX_VALUE_BYTES,
        })) {
          if (ev.type !== 'element') continue;
          const outcome = toOutcome(t, ev.value);
          if (outcome !== null) queue.push(outcome);
          while (queue.length > 0) yield queue.shift()!;
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
          // OpenRouter echoes nothing polyrouter attached: reconciliation cannot
          // match a job by id here (D6's bounded window applies).
          out.push({
            upstreamId: id,
            jobId: null,
            status: mapUpstreamStatus(OPENROUTER_STATUS_MAP, rec['status']),
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
        await res.text(); // drain (bounded) so the guarded dispatcher closes
      } finally {
        dispose();
      }
    },
  };
};
