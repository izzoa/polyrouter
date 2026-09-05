/**
 * The batch submission parser (add-batch-inference D1, task 3.1): ONE pass over
 * the raw request stream. `endpoint` and `model` must precede `requests` (the
 * array is stream-parsed, so a document that leads with the array is refused
 * before any item is read); every item is validated and translated as it parses
 * into the SAME `Normalized*` IR a synchronous request produces (invariant 2), and
 * only the translated items are kept — bounded by `BATCH_MAX_ITEMS` and the byte
 * bound, which is the honest memory bound because a translated item is at most a
 * small fixed factor larger than its wire form.
 */
import {
  JsonStreamError,
  SerializationError,
  getAdapter,
  scanTopLevelObject,
  type NormalizedRequest,
} from '@polyrouter/data-plane';
import { BATCH_ENDPOINTS, type BatchEndpoint } from '@polyrouter/shared';
import type { ProxyError } from '../proxy/proxy-errors';
import { batchError, batchItemError, protocolForEndpoint } from './batch-errors';

export interface ParsedBatchItem {
  readonly customId: string;
  readonly request: NormalizedRequest;
  /** The wire body's serialized length — the `chars/4` estimate input. */
  readonly chars: number;
  /** The item's own output cap, when the body carried one. */
  readonly maxOutputTokens: number | null;
}

export interface ParsedBatchSubmission {
  readonly endpoint: BatchEndpoint;
  readonly model: string;
  readonly items: readonly ParsedBatchItem[];
  readonly bytes: number;
}

export interface BatchIngressBounds {
  readonly maxItems: number;
  readonly maxBodyBytes: number;
  /** An upstream-declared bound (the adapter's `limits`), when known. */
  readonly maxUpstreamItems?: number | null;
  readonly customIdPattern?: RegExp | null;
}

/** A single element's wire size is bounded well under the body bound; a
 * translated item costs at most a small fixed factor more (D1). */
const MAX_ITEM_BYTES = 16 * 1024 * 1024;

/** Thrown by the parser: a ready-to-render ProxyError plus the protocol the
 * envelope must use — OpenAI until `endpoint` is known, then the endpoint's. */
export class BatchIngressError extends Error {
  constructor(
    readonly proxyError: ProxyError,
    readonly protocol: 'openai' | 'anthropic',
  ) {
    super(proxyError.publicMessage);
    this.name = 'BatchIngressError';
  }
}

function isEndpoint(v: unknown): v is BatchEndpoint {
  return typeof v === 'string' && (BATCH_ENDPOINTS as readonly string[]).includes(v);
}

/** Count bytes as they flow, refusing past the bound without reading further. */
async function* bounded(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
  onBytes: (total: number) => void,
  overflow: () => Error,
): AsyncGenerator<Uint8Array> {
  let total = 0;
  for await (const chunk of source) {
    total += chunk.byteLength;
    if (total > maxBytes) throw overflow();
    onBytes(total);
    yield chunk;
  }
}

/**
 * Parse and translate a submission. `onEndpoint` fires as soon as the endpoint is
 * known so the caller can switch its error envelope (D22) before any later
 * failure. `beforeItems` runs once, after `endpoint` and `model` are known and
 * BEFORE the first item is read — the caller resolves the route there, so a batch
 * bound for `auto` or an unsupported provider is refused without parsing a single
 * item (and can supply the upstream's own bounds).
 */
export async function parseBatchSubmission(
  source: AsyncIterable<Uint8Array>,
  bounds: BatchIngressBounds,
  hooks: {
    onEndpoint?: (endpoint: BatchEndpoint) => void;
    beforeItems?: (head: {
      endpoint: BatchEndpoint;
      model: string;
    }) => Promise<Partial<BatchIngressBounds> | void>;
  } = {},
): Promise<ParsedBatchSubmission> {
  let endpoint: BatchEndpoint | null = null;
  let model: string | null = null;
  let protocol: 'openai' | 'anthropic' = 'openai';
  let effective: BatchIngressBounds = bounds;
  // Declared with an explicit `never` signature so control flow narrows after a call.
  const fail: (err: ProxyError) => never = (err) => {
    throw new BatchIngressError(err, protocol);
  };
  let bytes = 0;
  const stream = bounded(
    source,
    bounds.maxBodyBytes,
    (total) => {
      bytes = total;
    },
    () =>
      new BatchIngressError(
        batchError('batch_too_large', `body exceeds ${String(bounds.maxBodyBytes)} bytes`),
        protocol,
      ),
  );

  const items: ParsedBatchItem[] = [];
  const seen = new Set<string>();
  let itemsStarted = false;
  let sawRequests = false;

  try {
    for await (const ev of scanTopLevelObject(stream, {
      arrayKeys: ['requests'],
      maxValueBytes: MAX_ITEM_BYTES,
    })) {
      if (ev.type === 'member') {
        if (ev.key === 'endpoint') {
          if (itemsStarted) fail(batchError('batch_invalid', 'endpoint must precede requests'));
          if (!isEndpoint(ev.value)) {
            fail(
              batchError('batch_invalid', `endpoint must be one of ${BATCH_ENDPOINTS.join(', ')}`),
            );
          }
          endpoint = ev.value;
          protocol = protocolForEndpoint(endpoint);
          hooks.onEndpoint?.(endpoint);
        } else if (ev.key === 'model') {
          if (itemsStarted) fail(batchError('batch_invalid', 'model must precede requests'));
          if (typeof ev.value !== 'string' || ev.value.trim().length === 0) {
            fail(batchError('batch_invalid', 'model must be a non-empty string'));
          }
          model = ev.value.trim();
          if (model.toLowerCase() === 'auto') fail(batchError('batch_auto_not_allowed'));
        } else if (ev.key === 'requests') {
          // A non-array `requests` never streams; refuse it by name.
          fail(batchError('batch_invalid', 'requests must be a non-empty array'));
        }
        // Other top-level members (metadata, completion_window) are accepted and
        // ignored — the only completion window is the provider's.
        continue;
      }
      if (ev.type === 'array_start') {
        if (sawRequests) fail(batchError('batch_invalid', 'requests appears twice'));
        sawRequests = true;
        if (endpoint === null || model === null) {
          fail(batchError('batch_invalid', 'endpoint and model must precede requests'));
        }
        const extra = await hooks.beforeItems?.({ endpoint, model });
        if (extra !== undefined) effective = { ...effective, ...extra };
        itemsStarted = true;
        continue;
      }
      if (ev.type === 'element') {
        const upstreamMax = effective.maxUpstreamItems ?? null;
        const maxItems =
          upstreamMax === null ? effective.maxItems : Math.min(effective.maxItems, upstreamMax);
        if (items.length >= maxItems) {
          fail(batchError('batch_too_large', `more than ${String(maxItems)} items`));
        }
        items.push(parseItem(ev.value, ev.bytes, endpoint!, model!, seen, effective, fail));
        continue;
      }
      // array_end: nothing to do — the trailing members (if any) are ignored.
    }
  } catch (err) {
    if (err instanceof BatchIngressError) throw err;
    if (err instanceof JsonStreamError) {
      if (err.reason === 'too_large')
        fail(batchError('batch_too_large', 'an item exceeds the per-item bound'));
      fail(batchError('batch_invalid', 'malformed JSON body'));
    }
    throw err;
  }
  if (endpoint === null || model === null) {
    fail(batchError('batch_invalid', 'endpoint and model are required'));
  }
  if (!sawRequests || items.length === 0)
    fail(batchError('batch_invalid', 'requests must be a non-empty array'));
  return { endpoint, model, items, bytes };
}

function parseItem(
  raw: unknown,
  bytes: number,
  endpoint: BatchEndpoint,
  model: string,
  seen: Set<string>,
  bounds: BatchIngressBounds,
  fail: (err: ProxyError) => never,
): ParsedBatchItem {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(batchItemError(null, 'must be an object with custom_id and body'));
  }
  const rec = raw as Record<string, unknown>;
  const customId = rec['custom_id'];
  if (typeof customId !== 'string' || customId.length === 0) {
    fail(batchItemError(null, 'must carry a non-empty string custom_id'));
  }
  if (seen.has(customId)) fail(batchItemError(customId, 'duplicates an earlier custom_id'));
  const pattern = bounds.customIdPattern ?? null;
  if (pattern !== null && !pattern.test(customId)) {
    fail(
      batchItemError(
        customId,
        `has a custom_id the provider does not accept (must match ${pattern.source})`,
      ),
    );
  }
  const body = rec['body'];
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail(batchItemError(customId, 'must carry an object body'));
  }
  const b = body as Record<string, unknown>;
  if (b['stream'] === true)
    fail(batchItemError(customId, 'sets stream: true (batches are never streamed)'));
  if (typeof b['n'] === 'number' && b['n'] > 1)
    fail(batchItemError(customId, 'sets n > 1 (one choice per item)'));
  if (b['model'] !== undefined && b['model'] !== model) {
    fail(batchItemError(customId, 'names a model different from the batch model'));
  }
  const protocol = protocolForEndpoint(endpoint);
  let request: NormalizedRequest;
  try {
    // The item's own `model` (equal to the batch's, or absent) is irrelevant: the
    // resolved route retargets every item; parse with the batch model in place so
    // the translate module's own validation runs on a complete body.
    request = getAdapter(protocol).requestIn({ ...b, model });
  } catch (err) {
    if (err instanceof SerializationError || err instanceof Error) {
      fail(batchItemError(customId, 'has an invalid body for the batch endpoint'));
    }
    throw err;
  }
  seen.add(customId);
  const cap = request.params.maxOutputTokens;
  return {
    customId,
    request,
    chars: bytes,
    maxOutputTokens: cap !== undefined && Number.isFinite(cap) && cap > 0 ? cap : null,
  };
}
