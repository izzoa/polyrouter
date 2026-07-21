/**
 * OpenAI-Responses provider adapter (add-chatgpt-responses): the ChatGPT backend's
 * Responses API, reached only through a subscription-OAuth preset. OAuth-ONLY, and
 * exactly THREE identity-bearing headers — Bearer + `chatgpt-account-id` + the
 * ecosystem-established Responses beta — never `x-api-key`, never client
 * fingerprints (`originator`, session ids), never imitation `instructions`
 * (the sharpened no-spoofing rule). No models endpoint is used: `listModels()`
 * rejects typed, and `testConnection()` is the designated minimal probe against
 * the preset's trusted `probeModel`.
 *
 * VERIFIED LIVE (2026-07-18): the backend accepts ONLY streaming requests
 * ("Stream must be set to true") — so `chat()` is implemented as
 * stream-and-collect over the SSE wire, folding the normalized events back into
 * a NormalizedResponse. It also rejects `max_output_tokens` and sampling params
 * (dropped in the translate module, documented).
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
import { SsrfError } from '@polyrouter/shared/server';
import { CallCancelledError, ProviderError, classifyStreamError } from './errors';
import {
  DEFAULT_FIRST_BYTE_TIMEOUT_MS,
  type CallContext,
  type ConnectionResult,
  type ProviderAdapter,
  type ProviderConfig,
} from './adapter';
import { createHttpProviderAdapter, type AdapterDeps } from './http-adapter';

/** Ecosystem-established Responses beta header (verified live, 6.2). */
const RESPONSES_BETA = 'responses=experimental';
const CHAT_PATH = '/backend-api/codex/responses';

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
        throw new ProviderError(
          classifyStreamError(ev.error.type),
          'provider stream failed before completion',
          {
            ...(ev.diagnostic?.providerMessage !== undefined
              ? { providerMessage: ev.diagnostic.providerMessage }
              : {}),
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
  if (config.probeModel === undefined || config.probeModel === '') {
    throw new ProviderError('credential', 'openai_responses requires the preset probe model');
  }
  const accountId = config.oauthAccountId;
  const probeModel = config.probeModel;
  const inner = createHttpProviderAdapter(config, deps, {
    protocol: 'openai_responses',
    translate: createResponsesAdapter(config.quirks ?? {}),
    chatPath: CHAT_PATH,
    // No modelsPath/parseModels: listModels() rejects typed; testConnection is
    // OVERRIDDEN below (the spec-level probe would ride the inner buffered chat,
    // which this streaming-only wire rejects).
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
  // The designated validating probe (the backend has no cap param — the prompt
  // itself keeps the answer minimal; subscription usage is flat-rate). Mirrors the
  // shared adapter's testConnection error mapping.
  async function testConnection(ctx?: CallContext): Promise<ConnectionResult> {
    try {
      await chat(
        {
          model: probeModel,
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'Reply with exactly: pong' }] },
          ],
          params: {},
        },
        ctx,
      );
      return { ok: true, models: 0 };
    } catch (err) {
      if (err instanceof ProviderError) return { ok: false, kind: err.kind, message: err.message };
      if (err instanceof CallCancelledError) {
        return { ok: false, kind: 'unavailable', message: 'call cancelled' };
      }
      if (err instanceof SsrfError) return { ok: false, kind: 'unavailable', message: err.message };
      return { ok: false, kind: 'unavailable', message: 'connection failed' };
    }
  }
  return { ...inner, chat, testConnection };
}
