/**
 * Canonicalizer for the golden contract suite. Byte-exact round-trip is
 * impossible and dishonest (providers carry fields the IR intentionally drops,
 * and equivalent encodings differ) — so the contract is
 *   canon(Out(In(x))) deep-equals canon(x).
 * `canon` neutralizes exactly the representational choices In/Out make
 * differently from a hand-authored fixture: content string ⟷ block array,
 * tool-argument JSON string ⟷ parsed object (whitespace/key-order), the
 * `max_tokens`/`max_completion_tokens` spelling, `stop` string ⟷ array — and
 * drops a known set of provider-only fields the IR does not model.
 */
import type { Protocol } from './ir';

type Json = unknown;
type JsonObject = Record<string, Json>;

// `response_format`, `reasoning_effort` (OpenAI) and `cache_control`, `thinking`
// (Anthropic) are deliberately NOT dropped: they must round-trip on the same
// protocol (E2.4/E2.5). Crossing protocols they are dropped at the adapter (a
// documented loss — see golden/README.md), never mapped to a wrong value.
const DROP_KEYS = new Set([
  'object',
  'system_fingerprint',
  'logprobs',
  'service_tier',
  'stream_options',
  'n',
  'user',
  'metadata',
  'seed',
]);

function isObject(v: Json): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function tryParseJson(s: string): Json {
  try {
    return JSON.parse(s) as Json;
  } catch {
    return s; // malformed model JSON: keep raw (parse-error path)
  }
}

/** Coerce a string-or-parts content field to a canonical parts array. */
function canonOpenaiContent(content: Json): Json {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (content === null || content === undefined) return [];
  return content;
}

function canonOpenaiToolCalls(calls: Json): Json {
  if (!Array.isArray(calls)) return calls;
  return (calls as Json[]).map((c): Json => {
    if (!isObject(c)) return c;
    const fn = c['function'];
    if (isObject(fn) && typeof fn['arguments'] === 'string') {
      return {
        ...c,
        function: { ...fn, arguments: tryParseJson(fn['arguments']) },
      };
    }
    return c;
  });
}

function canonOpenaiMessage(msg: Json): Json {
  if (!isObject(msg)) return msg;
  const out: JsonObject = { ...msg };
  if ('content' in out) out['content'] = canonOpenaiContent(out['content']);
  if ('tool_calls' in out) out['tool_calls'] = canonOpenaiToolCalls(out['tool_calls']);
  return out;
}

function canonOpenaiRequest(req: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(req)) {
    if (DROP_KEYS.has(k)) continue;
    out[k] = v;
  }
  if (Array.isArray(out['messages'])) {
    out['messages'] = out['messages'].map(canonOpenaiMessage);
  }
  // Unify the max-output-tokens spelling under `max_tokens`.
  if (out['max_completion_tokens'] !== undefined) {
    out['max_tokens'] = out['max_completion_tokens'];
    delete out['max_completion_tokens'];
  }
  // `stop` string ⟷ single-element array.
  if (typeof out['stop'] === 'string') out['stop'] = [out['stop']];
  return out;
}

function canonOpenaiResponse(res: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(res)) {
    if (DROP_KEYS.has(k)) continue;
    out[k] = v;
  }
  if (Array.isArray(out['choices'])) {
    out['choices'] = (out['choices'] as Json[]).map((c): Json => {
      if (!isObject(c)) return c;
      const choice: JsonObject = { ...c };
      if (isObject(choice['message'])) {
        choice['message'] = canonOpenaiMessage(choice['message']);
      }
      return choice;
    });
  }
  return out;
}

/** Anthropic content/system string ⟷ text-block array. */
function canonAntTextish(v: Json): Json {
  if (typeof v === 'string') return [{ type: 'text', text: v }];
  return v;
}

function canonAntBlocks(blocks: Json): Json {
  if (!Array.isArray(blocks)) return canonAntTextish(blocks);
  return (blocks as Json[]).map((b): Json => {
    if (!isObject(b)) return b;
    if (b['type'] === 'tool_result' && 'content' in b) {
      return { ...b, content: canonAntTextish(b['content']) };
    }
    return b;
  });
}

function canonAnthropicRequest(req: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(req)) {
    if (DROP_KEYS.has(k)) continue;
    out[k] = v;
  }
  if ('system' in out) out['system'] = canonAntTextish(out['system']);
  if (Array.isArray(out['messages'])) {
    out['messages'] = (out['messages'] as Json[]).map((m): Json => {
      if (!isObject(m)) return m;
      return { ...m, content: canonAntBlocks(m['content']) };
    });
  }
  return out;
}

function canonAnthropicResponse(res: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(res)) {
    if (DROP_KEYS.has(k)) continue;
    out[k] = v;
  }
  if ('content' in out) out['content'] = canonAntBlocks(out['content']);
  if (out['stop_sequence'] === null) delete out['stop_sequence'];
  return out;
}

export function canonRequest(protocol: Protocol, wire: unknown): JsonObject {
  if (!isObject(wire)) throw new TypeError('canonRequest expects an object');
  return protocol === 'openai' ? canonOpenaiRequest(wire) : canonAnthropicRequest(wire);
}

export function canonResponse(protocol: Protocol, wire: unknown): JsonObject {
  if (!isObject(wire)) throw new TypeError('canonResponse expects an object');
  return protocol === 'openai' ? canonOpenaiResponse(wire) : canonAnthropicResponse(wire);
}
