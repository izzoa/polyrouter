/**
 * OpenAI-Responses provider adapter (add-chatgpt-responses): the ChatGPT backend's
 * Responses API, reached only through a subscription-OAuth preset. OAuth-ONLY, and
 * exactly THREE identity-bearing headers — Bearer + `chatgpt-account-id` + the
 * ecosystem-established Responses beta — never `x-api-key`, never client
 * fingerprints (`originator`, a first-party user agent, session ids), never
 * imitation `instructions` (the sharpened no-spoofing rule).
 *
 * VERIFIED LIVE (2026-07-18): the backend accepts ONLY streaming requests
 * ("Stream must be set to true") — so `chat()` is implemented as
 * stream-and-collect over the SSE wire, folding the normalized events back into
 * a NormalizedResponse. It also rejects `max_output_tokens` and sampling params
 * (dropped in the translate module, documented).
 *
 * Model listing (add-live-subscription-models) reads the backend's OWN catalog —
 * the endpoint the Codex CLI reads — so no model id is ever bundled: a retired
 * model can't go stale in polyrouter, and `testConnection()` is that listing
 * (it names no model). VERIFIED LIVE 2026-09-24 with exactly the three identity
 * headers: `client_version` is REQUIRED (400 without it), and a lower value
 * withholds models whose `minimal_client_version` exceeds it — so a stale pin can
 * only hide the newest models, never fail the listing.
 */
import { createResponsesAdapter } from '../proxy/translate';
import type {
  ContentBlock,
  NormalizedRequest,
  NormalizedResponse,
  NormalizedStopReason,
  NormalizedStreamEvent,
  NormalizedUsage,
} from '../proxy/translate';
import { ProviderError, classifyStreamError } from './errors';
import {
  DEFAULT_FIRST_BYTE_TIMEOUT_MS,
  MAX_MODEL_ID_LEN,
  MAX_PARSED_MODELS,
  type CallContext,
  type ProviderAdapter,
  type ProviderConfig,
  type ProviderModelCapabilities,
  type ProviderModelInfo,
} from './adapter';
import { createHttpProviderAdapter, type AdapterDeps } from './http-adapter';

/** Ecosystem-established Responses beta header (verified live, 6.2). */
const RESPONSES_BETA = 'responses=experimental';
const CHAT_PATH = '/backend-api/codex/responses';
/** The catalog's REQUIRED compatibility parameter (verified live 2026-09-24) — the
 * current Codex CLI release. Not identity: no user agent, `originator`, or session
 * rides with it. Bump when a new model family needs a newer value to be listed
 * (scripts/verify-chatgpt-oauth.md); a stale value only withholds the newest models. */
export const CHATGPT_CATALOG_CLIENT_VERSION = '0.156.1';
const MODELS_PATH = `/backend-api/codex/models?client_version=${CHATGPT_CATALOG_CLIENT_VERSION}`;

/** Parse the backend catalog `{ models: [...] }` defensively. A body without a
 * `models` array is catalog-shape DRIFT and fails typed — never "ok, zero models",
 * which would pass Test and hide the drift. An entry is OFFERED
 * only with a non-empty string `slug` and `visibility` `list` (or absent) — `hide` /
 * `none` entries are purpose-built or withheld (e.g. `codex-auto-review`). The
 * catalog states a context window and input modalities, so those ride as the
 * provider-listed capability CLAIM; it says nothing about tools or reasoning, so
 * those stay absent (silence is never a claim). Malformed entries drop alone. */
export function parseChatgptCatalog(json: unknown): ProviderModelInfo[] {
  const list =
    typeof json === 'object' && json !== null && 'models' in json ? json.models : undefined;
  if (!Array.isArray(list)) {
    throw new ProviderError('unavailable', 'unrecognized model catalog response');
  }
  const out: ProviderModelInfo[] = [];
  const seen = new Set<string>();
  for (const entry of list as unknown[]) {
    if (out.length >= MAX_PARSED_MODELS) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const slug = rec['slug'];
    if (typeof slug !== 'string' || slug.trim() === '' || slug.length > MAX_MODEL_ID_LEN) continue;
    const visibility = rec['visibility'];
    if (visibility !== undefined && visibility !== 'list') continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const display = rec['display_name'];
    const capabilities: { contextWindow?: number; supportsVision?: boolean } = {};
    const ctxWindow = rec['context_window'];
    if (typeof ctxWindow === 'number' && Number.isInteger(ctxWindow) && ctxWindow > 0) {
      capabilities.contextWindow = ctxWindow;
    }
    const modalities = rec['input_modalities'];
    if (Array.isArray(modalities)) capabilities.supportsVision = modalities.includes('image');
    const claim: ProviderModelCapabilities = capabilities;
    out.push({
      id: slug,
      ...(typeof display === 'string' && display !== '' ? { displayName: display } : {}),
      ...(Object.keys(claim).length > 0 ? { capabilities: claim } : {}),
    });
  }
  return out;
}

/** Byte-re-armable idle guard for the buffered facade (fix-long-call-timeouts).
 * The streaming-only wire's buffered `chat` folds a stream OUTSIDE core, so
 * core's watchdog never sees it — without this, post-headers silence was
 * bounded only by undici's wider untyped backstop. Each event wait is a
 * deadline the composed `onBytes` re-arms (keepalives count as liveness); TRUE
 * byte-silence aborts with the typed, trip-eligible `unavailable`. Mirrors
 * core's `nextWithTimeout` loop (private to the proxy layer, which imports
 * this package — duplicated to avoid a cycle). Exported for unit tests. */
export async function* guardEventIdle(
  open: (ctx: CallContext) => AsyncGenerator<NormalizedStreamEvent>,
  idleMs: number,
  ctx?: CallContext,
): AsyncGenerator<NormalizedStreamEvent> {
  const abort = new AbortController();
  const onCallerAbort = (): void => abort.abort();
  if (ctx?.signal) {
    if (ctx.signal.aborted) abort.abort();
    else ctx.signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const liveness = { lastByteAt: 0 };
  const inner = open({
    ...ctx,
    signal: abort.signal,
    onBytes: () => {
      liveness.lastByteAt = Date.now();
      ctx?.onBytes?.();
    },
  })[Symbol.asyncIterator]();
  try {
    for (;;) {
      const nextP = inner.next();
      const settled = nextP.then(
        (r) => ({ ok: true as const, r }),
        (e: unknown) => ({ ok: false as const, e }),
      );
      let armedAt = Date.now();
      let result: IteratorResult<NormalizedStreamEvent> | undefined;
      for (;;) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timed = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), idleMs - (Date.now() - armedAt));
        });
        const winner = await Promise.race([settled, timed]);
        if (timer) clearTimeout(timer);
        if (winner !== 'timeout') {
          if (!winner.ok) throw winner.e;
          result = winner.r;
          break;
        }
        const lastByteAt = liveness.lastByteAt;
        if (lastByteAt > armedAt && lastByteAt + idleMs > Date.now()) {
          armedAt = lastByteAt;
          continue;
        }
        abort.abort();
        await nextP.catch(() => undefined);
        throw new ProviderError('unavailable', 'upstream event timeout');
      }
      if (result.done) return;
      yield result.value;
    }
  } finally {
    ctx?.signal?.removeEventListener('abort', onCallerAbort);
    try {
      await inner.return?.(undefined);
    } catch {
      // best-effort teardown
    }
  }
}

/** Fold a normalized event stream into a buffered NormalizedResponse (the wire has
 * no non-streaming mode). An in-stream `error` event — including the parser's
 * truncation error — surfaces as a typed ProviderError with a FIXED message (the
 * event's classified type only), never a silent partial. */
async function collectStream(
  events: AsyncGenerator<NormalizedStreamEvent>,
): Promise<NormalizedResponse> {
  let id = 'resp';
  let model = '';
  let stopReason: NormalizedStopReason = 'stop';
  let rawStopReason: string | undefined;
  let usage: NormalizedUsage | undefined;
  const order: number[] = [];
  const texts = new Map<number, string>();
  const tools = new Map<number, Extract<ContentBlock, { type: 'tool_use' }>>();
  const seen = (index: number): void => {
    if (!order.includes(index)) order.push(index);
  };
  for await (const ev of events) {
    switch (ev.type) {
      case 'message_start':
        id = ev.id;
        model = ev.model;
        break;
      case 'text_delta':
        seen(ev.index);
        texts.set(ev.index, (texts.get(ev.index) ?? '') + ev.text);
        break;
      case 'tool_use_start':
        seen(ev.index);
        break;
      case 'block_stop':
        if (ev.finalizedToolUse !== undefined) {
          seen(ev.index);
          tools.set(ev.index, ev.finalizedToolUse);
        }
        break;
      case 'message_delta':
        if (ev.stopReason !== undefined) stopReason = ev.stopReason;
        if (ev.rawStopReason !== undefined) rawStopReason = ev.rawStopReason;
        // The event carries a PartialUsage; a buffered response's usage is whole
        // or absent — adopt it only when both required counters arrived.
        if (ev.usage?.inputTokens !== undefined && ev.usage.outputTokens !== undefined) {
          usage = {
            inputTokens: ev.usage.inputTokens,
            outputTokens: ev.usage.outputTokens,
            ...(ev.usage.cacheReadTokens !== undefined
              ? { cacheReadTokens: ev.usage.cacheReadTokens }
              : {}),
            ...(ev.usage.cacheWriteTokens !== undefined
              ? { cacheWriteTokens: ev.usage.cacheWriteTokens }
              : {}),
          };
        }
        break;
      case 'error':
        // Preserve the adapter-stage sanitized diagnostic (r3-Medium-3): the
        // inner chatStream already ran the capture factory, so the buffered
        // facade must carry providerMessage/requestId, not discard them.
        // The carried cross-field kind wins over a re-derivation from the outward
        // type (fix-4xx-error-taxonomy) — this buffered facade is the ONLY path a
        // Responses-protocol chat() takes, so losing a `code`-only marker here
        // would misroute every non-streaming call to that provider.
        throw new ProviderError(
          ev.diagnostic?.kind ?? classifyStreamError(ev.error.type),
          'provider stream failed before completion',
          {
            ...(ev.diagnostic?.providerMessage !== undefined
              ? { providerMessage: ev.diagnostic.providerMessage }
              : {}),
            ...(ev.diagnostic?.markers !== undefined ? { markers: ev.diagnostic.markers } : {}),
            ...(ev.diagnostic?.requestId !== undefined
              ? { requestId: ev.diagnostic.requestId }
              : {}),
          },
        );
      default:
        break;
    }
  }
  const content: ContentBlock[] = [];
  for (const index of order) {
    const tool = tools.get(index);
    if (tool !== undefined) {
      content.push(tool);
      continue;
    }
    const text = texts.get(index);
    if (text !== undefined && text !== '') content.push({ type: 'text', text });
  }
  return {
    id,
    model,
    content,
    stopReason,
    ...(rawStopReason !== undefined ? { rawStopReason } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
}

export function createResponsesProviderAdapter(
  config: ProviderConfig,
  deps: AdapterDeps = {},
): ProviderAdapter {
  // OAuth-only, fully configured — anything else is a typed, breaker-NEUTRAL
  // credential/config failure (never a header-less or fingerprint-less guess).
  if (config.authScheme !== 'oauth_bearer') {
    throw new ProviderError('credential', 'openai_responses requires an OAuth credential');
  }
  if (config.oauthAccountId === undefined || config.oauthAccountId === '') {
    throw new ProviderError('credential', 'openai_responses requires the account id');
  }
  const accountId = config.oauthAccountId;
  const inner = createHttpProviderAdapter(config, deps, {
    protocol: 'openai_responses',
    translate: createResponsesAdapter(config.quirks ?? {}),
    chatPath: CHAT_PATH,
    // The backend's own catalog (add-live-subscription-models): listModels() reads
    // it, and the shared testConnection() aliases it — no probe chat, no model id.
    modelsPath: MODELS_PATH,
    parseModels: parseChatgptCatalog,
    authHeaders: (credential) => ({
      Authorization: `Bearer ${credential}`,
      'chatgpt-account-id': accountId,
      'OpenAI-Beta': RESPONSES_BETA,
    }),
  });
  // Streaming-only wire: buffered chat rides the SSE path and folds the events —
  // under the byte-re-armable idle guard (fix-long-call-timeouts), since core's
  // stream watchdog never sees this fold.
  const idleTimeoutMs =
    config.idleTimeoutMs ?? config.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS;
  const chat = (request: NormalizedRequest, ctx?: CallContext): Promise<NormalizedResponse> =>
    collectStream(guardEventIdle((c) => inner.chatStream(request, c), idleTimeoutMs, ctx));
  return { ...inner, chat };
}
