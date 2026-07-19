/**
 * Layer-3 cascade primitives (#14, spec §7.2). Pure: a structural, language-
 * neutral, tokenizer-free quality score (invariant 9), and a synthesizer that
 * turns a fully-buffered response into stream events so a passing cheap answer
 * can be replayed to a streaming client. The orchestration (cheap-first, gate,
 * escalate) lives in the control-plane proxy; the commit-safe replay wrapper is
 * `replayBufferedStream` in `core.ts`.
 */
import type {
  ContentBlock,
  NormalizedResponse,
  NormalizedStreamEvent,
  PartialUsage,
} from './translate';

/**
 * A graded quality lattice (harden-cascade-quality-gate): `0` structurally
 * unusable → escalate; `0.5` uncertain (length truncation with no hard
 * failure — at the default strictly-below 0.5 threshold the DECISION is
 * unchanged from the old never-penalized contract, while the persisted
 * quality_signal visibly sharpens to 0.5; thresholds above 0.5 escalate);
 * `1` structurally sound. Detections are cheap capability failures — no
 * tokenizer, no LLM, no keywords, so the score is language-neutral.
 * Conformance: when the request declared machine-parseable output
 * (`ctx.structuredDemand`), the final text answer — its text blocks
 * concatenated in order, trimmed — must `JSON.parse`, else 0. A tool-calling
 * TURN is exempt from conformance (a `tool_use` block, or a `tool_use`/`pause`
 * stop — intermediate flow; the demand binds the final answer); those stops
 * score 1 when no hard failure applies. Hard failures take precedence over the
 * truncation grade — deliberately: demanded JSON cut off by the token cap is
 * invalid JSON and escalates. Absent `ctx` disables ONLY the conformance
 * check; truncation grading always applies.
 */
export function evaluateQuality(
  response: NormalizedResponse,
  ctx?: { structuredDemand?: boolean },
): number {
  if (response.stopReason === 'error' || response.stopReason === 'content_filter') return 0;
  let hasText = false;
  let hasTool = false;
  let text = '';
  for (const b of response.content) {
    if (b.type === 'text') {
      if (b.text.trim().length > 0) hasText = true;
      text += b.text;
    } else if (b.type === 'tool_use') {
      hasTool = true;
      if ('inputParseError' in b && b.inputParseError) return 0; // malformed JSON args
    }
  }
  if (!hasText && !hasTool) return 0; // empty
  const toolTurn = hasTool || response.stopReason === 'tool_use' || response.stopReason === 'pause';
  if (ctx?.structuredDemand === true && hasText && !toolTurn) {
    try {
      JSON.parse(text.trim());
    } catch {
      return 0; // prose (or a truncated document) where JSON was demanded
    }
  }
  if (response.stopReason === 'length') return 0.5; // uncertainty, not failure
  return 1;
}

/** Output-character estimate for a buffered response (text + tool name/args),
 * matching the proxy's streamed count so a replayed answer records consistently. */
export function responseOutputChars(content: readonly ContentBlock[]): number {
  let n = 0;
  for (const b of content) {
    if (b.type === 'text') n += b.text.length;
    else if (b.type === 'tool_use') {
      n += b.name.length + ('inputRaw' in b ? b.inputRaw.length : JSON.stringify(b.input).length);
    }
  }
  return n;
}

/**
 * Synthesize the stream events for a fully-buffered response: usage split as a
 * real upstream (input/cache up front, output at the delta), a `block_stop` for
 * EVERY block (so the Anthropic serializer closes each `content_block`), and the
 * stop reason preserved. Fed through `client.streamSerialize` to produce client
 * SSE identical in shape to a live stream of the same response.
 */
export function responseToStreamEvents(response: NormalizedResponse): NormalizedStreamEvent[] {
  const events: NormalizedStreamEvent[] = [];
  const u = response.usage;
  const startUsage: PartialUsage | undefined =
    u === undefined
      ? undefined
      : {
          inputTokens: u.inputTokens,
          ...(u.cacheReadTokens !== undefined ? { cacheReadTokens: u.cacheReadTokens } : {}),
          ...(u.cacheWriteTokens !== undefined ? { cacheWriteTokens: u.cacheWriteTokens } : {}),
        };
  events.push({
    type: 'message_start',
    id: response.id,
    model: response.model,
    role: 'assistant',
    ...(startUsage !== undefined ? { usage: startUsage } : {}),
  });

  let index = 0;
  for (const block of response.content) {
    if (block.type === 'text') {
      events.push({ type: 'text_delta', index, text: block.text });
      events.push({ type: 'block_stop', index });
      index += 1;
    } else if (block.type === 'tool_use') {
      events.push({ type: 'tool_use_start', index, id: block.id, name: block.name });
      const partialJson = 'inputRaw' in block ? block.inputRaw : JSON.stringify(block.input);
      events.push({ type: 'tool_use_delta', index, partialJson });
      events.push({ type: 'block_stop', index, finalizedToolUse: block });
      index += 1;
    }
    // image / tool_result blocks do not occur in an assistant response.
  }

  events.push({
    type: 'message_delta',
    stopReason: response.stopReason,
    ...(response.rawStopReason !== undefined ? { rawStopReason: response.rawStopReason } : {}),
    ...(response.stopSequence !== undefined ? { stopSequence: response.stopSequence } : {}),
    ...(u !== undefined ? { usage: { outputTokens: u.outputTokens } } : {}),
  });
  events.push({ type: 'message_stop' });
  return events;
}
