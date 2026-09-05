/** Shared plumbing for the batch implementations: streamed JSON documents, the
 * guarded call with batch-aware error mapping, and the taxonomy helpers. */
import type { CallContext } from '../adapter';
import { BatchUpstreamNotFoundError } from '../batch';
import { ProviderError, classifyResponse, type ProviderErrorKind } from '../errors';
import { errMeta, rethrowTyped } from '../http-adapter';
import { openRequest, type HttpBody, type HttpResponse } from '../http';
import type { BatchTransport } from './transport';

/**
 * Stream `{...head, "<arrayKey>": [item, item, ...]}` as bytes, serializing ONE
 * item per pull. The items already live in memory (D1); the document never does —
 * a 200 MB batch is not doubled by `JSON.stringify` of the envelope.
 */
export function streamJsonDocument(
  head: Readonly<Record<string, unknown>>,
  arrayKey: string,
  items: Iterable<unknown>,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const it = items[Symbol.iterator]();
  const headJson = JSON.stringify(head);
  const opening = `${headJson.slice(0, -1)}${headJson.length > 2 ? ',' : ''}${JSON.stringify(arrayKey)}:[`;
  let state: 'opening' | 'items' | 'closed' = 'opening';
  let first = true;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state === 'opening') {
        controller.enqueue(enc.encode(opening));
        state = 'items';
        return;
      }
      if (state === 'items') {
        const next = it.next();
        if (next.done === true) {
          controller.enqueue(enc.encode(']}'));
          state = 'closed';
          controller.close();
          return;
        }
        controller.enqueue(enc.encode(`${first ? '' : ','}${JSON.stringify(next.value)}`));
        first = false;
      }
    },
  });
}

export interface BatchCallInit {
  readonly method: 'GET' | 'POST';
  readonly body?: HttpBody;
  /** polyrouter's job id, sent as `Idempotency-Key` on a create (D6). An upstream
   * that honours it collapses a retried create onto one job; one that ignores it
   * is unaffected, and reconciliation falls back to its bounded window. */
  readonly idempotencyKey?: string;
  /** Overrides the JSON content type for a body that is not JSON (the OpenAI
   * file upload's multipart envelope, which must carry its own boundary). */
  readonly contentType?: string;
  /** Treat 404/410 as "the upstream no longer knows this job" rather than as a
   * provider-misconfiguration `unavailable` (status/results/cancel only — a
   * create's 404 is a wrong path or model and classifies normally). */
  readonly notFoundIsBatch: boolean;
}

export interface OpenedBatchCall {
  readonly res: HttpResponse;
  readonly dispose: () => void;
}

/** One guarded upstream call for the batch seam: the adapter's client, headers
 * and bounds; a non-2xx classifies through the taxonomy with the credential
 * scrubbed, or maps to not-found where the caller said a 404 means that. */
export async function batchCall(
  t: BatchTransport,
  url: string,
  init: BatchCallInit,
  ctx: CallContext | undefined,
): Promise<OpenedBatchCall> {
  let opened: OpenedBatchCall;
  try {
    opened = await openRequest(
      t.httpClient,
      url,
      {
        method: init.method,
        headers: {
          ...t.headers(init.body !== undefined),
          ...(init.contentType !== undefined ? { 'Content-Type': init.contentType } : {}),
          ...(init.idempotencyKey !== undefined ? { 'Idempotency-Key': init.idempotencyKey } : {}),
        },
        ...(init.body !== undefined ? { body: init.body } : {}),
      },
      t.firstByteTimeoutMs,
      ctx,
      t.idleTimeoutMs,
      t.maxResponseBytes,
    );
  } catch (err) {
    rethrowTyped(err);
  }
  const { res, dispose } = opened;
  if (res.ok) return opened;
  try {
    const text = await res.text();
    if (init.notFoundIsBatch && (res.status === 404 || res.status === 410)) {
      throw new BatchUpstreamNotFoundError();
    }
    throw classifyResponse(res.status, text, errMeta(res), [t.credential]);
  } catch (err) {
    if (err instanceof BatchUpstreamNotFoundError) throw err;
    rethrowTyped(err);
  } finally {
    dispose();
  }
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** An RFC 3339 / ISO timestamp → Date, or null when absent or unparseable. */
export function asDate(v: unknown): Date | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** The taxonomy kind for a per-item failure that carries an HTTP status: the
 * SAME classifier the synchronous path uses (only its kind is kept — the
 * message, which may quote the body, is discarded). */
export function kindForStatus(
  status: number,
  body: unknown,
  credential: string,
): ProviderErrorKind {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  return classifyResponse(status, text, {}, [credential]).kind;
}

export function malformed(what: string): ProviderError {
  // A malformed upstream batch object is provider ill-health, not a client fault.
  return new ProviderError('unavailable', `provider returned a malformed ${what}`);
}
