import { BATCH_COMPLETION_WINDOW_MS } from '@polyrouter/shared';
/**
 * OpenAI's Batch API (add-batch-inference Phase C): the one shipped upstream with
 * a FILE plane. Items are framed as JSONL and streamed up to `POST /v1/files`
 * (purpose `batch`) as a multipart body, then `POST /v1/batches` references the
 * uploaded file by id; results come back as two more files, streamed down at
 * settlement. Nothing is written to local disk at any point (D15) — the multipart
 * body is composed as a stream over the in-memory items, and the results are read
 * straight through.
 *
 * Alone among the three, OpenAI's batch object carries `metadata`, so polyrouter's
 * job id is echoed there and `submission_unknown` reconciliation can match a job
 * by id rather than waiting out its bounded window (D6).
 *
 * Shapes pinned from the published OpenAPI document (2026-09): the status enum is
 * exactly polyrouter's vocabulary; `request_counts` is `{total, completed, failed}`;
 * the input file allows 50,000 requests or 200 MB; `completion_window` accepts only
 * `24h`; and an output file has NO expiry unless one is requested at create time,
 * so the retention deadline is honestly null.
 */
import type { CallContext, ProviderProtocol } from '../adapter';
import {
  mapUpstreamStatus,
  type BatchCounts,
  type BatchItemOutcome,
  type BatchListEntry,
  type BatchStatusView,
  type BatchUpstreamStatus,
} from '../batch';
import { joinUrl } from '../http';
import { bytesOf, readJsonLines } from './json-stream';
import { asNumber, asRecord, asString, batchCall, kindForStatus, malformed } from './support';
import type { BatchFactory, BatchTransport } from './transport';

/** Every status the OpenAPI document declares for a batch. */
export const OPENAI_BATCH_STATUSES = [
  'validating',
  'failed',
  'in_progress',
  'finalizing',
  'completed',
  'expired',
  'cancelling',
  'cancelled',
] as const;
export type OpenAiBatchStatus = (typeof OPENAI_BATCH_STATUSES)[number];

/** The vocabularies coincide exactly — which is why the table is written out in
 * full rather than assumed: a future divergence fails the totality check here
 * instead of silently mapping a new status onto the wrong one. */
export const OPENAI_STATUS_MAP: Readonly<Record<OpenAiBatchStatus, BatchUpstreamStatus>> = {
  validating: 'validating',
  failed: 'failed',
  in_progress: 'in_progress',
  finalizing: 'finalizing',
  completed: 'completed',
  expired: 'expired',
  cancelling: 'cancelling',
  cancelled: 'cancelled',
};

/** The metadata key carrying polyrouter's job id (≤64 chars, per `Metadata`). */
export const OPENAI_JOB_ID_KEY = 'polyrouter_job_id';

/** "Currently only `24h` is supported." */
/** The shared window (add-batch-mode-help): one declaration the dashboard reads too,
 * so this provider and the help text cannot state different figures. */
const COMPLETION_WINDOW_MS = BATCH_COMPLETION_WINDOW_MS;
/** "The file can contain up to 50,000 requests, and can be up to 200 MB in size." */
const MAX_ITEMS = 50_000;
const MAX_BYTES = 200_000_000;
/** One JSONL result line (a whole completion), bounded like any value. */
const MAX_LINE_BYTES = 32 * 1024 * 1024;

/** The upstream endpoint every item in the batch runs against, from the adapter's
 * own protocol — the client's endpoint is already translated away by here. */
function upstreamEndpoint(protocol: ProviderProtocol): string {
  return protocol === 'openai_responses' ? '/v1/responses' : '/v1/chat/completions';
}

interface OpenAiBatchMeta {
  readonly id: string;
  readonly status: BatchUpstreamStatus | null;
  readonly counts: BatchCounts | null;
  readonly outputFileId: string | null;
  readonly errorFileId: string | null;
  readonly jobId: string | null;
}

export function parseOpenAiBatch(raw: unknown): OpenAiBatchMeta {
  const rec = asRecord(raw);
  const id = rec !== null ? asString(rec['id']) : null;
  if (rec === null || id === null) throw malformed('batch object');
  const rc = asRecord(rec['request_counts']);
  const total = rc !== null ? asNumber(rc['total']) : null;
  const completed = rc !== null ? asNumber(rc['completed']) : null;
  const failed = rc !== null ? asNumber(rc['failed']) : null;
  const metadata = asRecord(rec['metadata']);
  return {
    id,
    status: mapUpstreamStatus(OPENAI_STATUS_MAP, rec['status']),
    counts:
      total !== null && completed !== null && failed !== null ? { total, completed, failed } : null,
    outputFileId: asString(rec['output_file_id']),
    errorFileId: asString(rec['error_file_id']),
    jobId: metadata !== null ? asString(metadata[OPENAI_JOB_ID_KEY]) : null,
  };
}

/**
 * A multipart/form-data body composed as a STREAM (task 6.1). The JSONL lines are
 * produced one at a time from the already-in-memory items, so the upload never
 * materializes a second copy of the batch and never touches disk. A 200 MB batch
 * costs one line of buffer here, not 200 MB.
 */
export function multipartJsonl(
  boundary: string,
  purpose: string,
  filename: string,
  lines: Iterable<string>,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const preamble =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="purpose"\r\n\r\n${purpose}\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: application/jsonl\r\n\r\n`;
  const it = lines[Symbol.iterator]();
  let state: 'preamble' | 'lines' | 'closed' = 'preamble';
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state === 'preamble') {
        controller.enqueue(enc.encode(preamble));
        state = 'lines';
        return;
      }
      if (state === 'lines') {
        const next = it.next();
        if (next.done === true) {
          controller.enqueue(enc.encode(`\r\n--${boundary}--\r\n`));
          state = 'closed';
          controller.close();
          return;
        }
        controller.enqueue(enc.encode(next.value));
      }
    },
  });
}

/** A boundary that cannot occur inside JSON: only hex and dashes. */
function newBoundary(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `----polyrouterBatch${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** One output/error line → an item outcome. The two files share a line shape;
 * only which of `response`/`error` is populated differs. */
function toOutcome(t: BatchTransport, raw: unknown): BatchItemOutcome | null {
  const rec = asRecord(raw);
  const customId = rec !== null ? asString(rec['custom_id']) : null;
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
  // The error file's line carries `{code, message}` — a code, never a status. The
  // message may quote the item, so only the CODE informs the taxonomy.
  const code = error !== null ? asString(error['code']) : null;
  return {
    customId,
    ok: false,
    statusCode: null,
    kind: code === 'rate_limit_exceeded' ? 'rate_limit' : 'upstream_rejected',
  };
}

export const createOpenAiBatchAdapter: BatchFactory = (t) => {
  // BESIDE the chat path on the same base, exactly as `chatPath` is: an
  // OpenAI-compatible `base_url` already carries its own version segment
  // (`https://api.openai.com/v1`), so a hardcoded `/v1/...` would address
  // `/v1/v1/batches` — which is what the contract test caught.
  const batches = joinUrl(t.baseUrl, '/batches');
  const files = joinUrl(t.baseUrl, '/files');
  const byId = (id: string): string => `${batches}/${encodeURIComponent(id)}`;

  const readBatch = async (id: string, ctx: CallContext | undefined): Promise<OpenAiBatchMeta> => {
    const { res, dispose } = await batchCall(
      t,
      byId(id),
      { method: 'GET', notFoundIsBatch: true },
      ctx,
    );
    try {
      return parseOpenAiBatch(await res.json());
    } finally {
      dispose();
    }
  };

  /** Stream one result file's JSONL through, yielding each item's outcome. A file
   * the batch does not have (no failures, or no successes) is simply skipped. */
  async function* linesOf(
    fileId: string | null,
    ctx: CallContext | undefined,
  ): AsyncGenerator<BatchItemOutcome> {
    if (fileId === null) return;
    const url = `${files}/${encodeURIComponent(fileId)}/content`;
    const { res, dispose } = await batchCall(t, url, { method: 'GET', notFoundIsBatch: true }, ctx);
    try {
      for await (const line of readJsonLines(bytesOf(res.body), MAX_LINE_BYTES)) {
        const outcome = toOutcome(t, line);
        if (outcome !== null) yield outcome;
      }
    } finally {
      dispose();
    }
  }

  return {
    limits: {
      maxItems: MAX_ITEMS,
      maxBytes: MAX_BYTES,
      customIdPattern: null,
      completionWindowMs: COMPLETION_WINDOW_MS,
    },

    async submit(input, ctx) {
      const model = input.model;
      const endpoint = upstreamEndpoint(t.protocol);
      const boundary = newBoundary();
      // One JSONL line per item, produced lazily: the upload streams from the
      // items already in memory and never writes a temp file (D15).
      const lines = (function* (): Generator<string> {
        for (const item of input.items) {
          yield `${JSON.stringify({
            custom_id: item.customId,
            method: 'POST',
            url: endpoint,
            body: t.translate.requestOut({ ...item.request, model, stream: false }),
          })}\n`;
        }
      })();
      const upload = await batchCall(
        t,
        files,
        {
          method: 'POST',
          body: multipartJsonl(boundary, 'batch', `polyrouter-${input.jobId}.jsonl`, lines),
          contentType: `multipart/form-data; boundary=${boundary}`,
          notFoundIsBatch: false,
        },
        ctx,
      );
      let inputFileId: string;
      try {
        const file = asRecord(await upload.res.json());
        const id = file !== null ? asString(file['id']) : null;
        if (id === null) throw malformed('file object');
        inputFileId = id;
      } finally {
        upload.dispose();
      }

      const { res, dispose } = await batchCall(
        t,
        batches,
        {
          method: 'POST',
          body: JSON.stringify({
            input_file_id: inputFileId,
            endpoint,
            completion_window: '24h',
            // The job id echoed back on every read and every list entry, which is
            // what lets reconciliation match a job by id rather than wait out its
            // window (D6). An opaque id — never anything a client authored.
            metadata: { [OPENAI_JOB_ID_KEY]: input.jobId },
          }),
          notFoundIsBatch: false,
          idempotencyKey: input.jobId,
        },
        ctx,
      );
      try {
        const meta = parseOpenAiBatch(await res.json());
        return {
          upstreamId: meta.id,
          status: meta.status,
          completionWindowMs: COMPLETION_WINDOW_MS,
          // An output file has no expiry unless one was requested at create time,
          // and polyrouter requests none: the deadline is honestly unknown rather
          // than invented (D23).
          resultsExpireAt: null,
        };
      } finally {
        dispose();
      }
    },

    async status(id, ctx): Promise<BatchStatusView> {
      const meta = await readBatch(id, ctx);
      return { status: meta.status, counts: meta.counts, resultsExpireAt: null };
    },

    async *results(id, ctx) {
      // Both files, streamed in turn: a partially-failed batch settles per item,
      // successes from the output file and failures from the error file (task 6.2).
      const meta = await readBatch(id, ctx);
      yield* linesOf(meta.outputFileId, ctx);
      yield* linesOf(meta.errorFileId, ctx);
    },

    async list(ctx): Promise<readonly BatchListEntry[]> {
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
          if (rec === null || asString(rec['id']) === null) continue;
          const meta = parseOpenAiBatch(rec);
          out.push({ upstreamId: meta.id, jobId: meta.jobId, status: meta.status });
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
