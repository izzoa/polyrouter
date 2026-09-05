/**
 * A bounded, incremental scanner for ONE top-level JSON object whose named
 * members are arrays too large to buffer (add-batch-inference D1/D25): the
 * ingress `requests` array and OpenRouter's inlined `results` array. Every
 * other member is buffered and parsed whole (bounded); the named arrays are
 * emitted element by element, each element bounded, so peak memory is one
 * element plus the small members — never the document.
 *
 * It is a character-level state machine (strings and escapes are respected, so
 * a `]` inside a string never ends an element); it makes no attempt to be a
 * general JSON parser — each captured value is handed to `JSON.parse`, which is
 * the actual grammar authority. Malformed input is a typed failure, never a hang.
 */

export type JsonStreamEvent =
  | { readonly type: 'member'; readonly key: string; readonly value: unknown }
  | { readonly type: 'array_start'; readonly key: string }
  | {
      readonly type: 'element';
      readonly key: string;
      readonly value: unknown;
      readonly bytes: number;
    }
  | { readonly type: 'array_end'; readonly key: string; readonly count: number };

export interface JsonStreamOptions {
  /** Top-level keys whose ARRAY values are streamed element by element. */
  readonly arrayKeys: readonly string[];
  /** Byte cap on one buffered value — a non-streamed member or one array element. */
  readonly maxValueBytes: number;
}

export type JsonStreamFailure = 'not_object' | 'malformed' | 'too_large' | 'truncated';

export class JsonStreamError extends Error {
  constructor(
    readonly reason: JsonStreamFailure,
    message: string,
  ) {
    super(message);
    this.name = 'JsonStreamError';
  }
}

type Phase =
  | 'start' // expect `{`
  | 'key_or_end' // expect `"` (a key) or `}` (empty / trailing)
  | 'key' // inside the key string
  | 'colon' // expect `:`
  | 'value_start' // expect the first char of a value
  | 'value' // capturing a member value
  | 'element_start' // inside a streamed array: expect an element or `]`
  | 'element_required' // after `,` inside the array: an element MUST follow
  | 'element' // capturing an element
  | 'after_array' // the streamed array closed: expect `,` or `}`
  | 'done'; // after the closing `}`: whitespace only

const WS = new Set([' ', '\t', '\n', '\r']);

/** Chars ≤ bytes for UTF-8, so a char count under `max/3` can never exceed
 * `max` bytes; only past that cheap bound is the exact byte length measured. */
function exceeds(buf: string, max: number): boolean {
  if (buf.length * 3 <= max) return false;
  return Buffer.byteLength(buf, 'utf8') > max;
}

export async function* scanTopLevelObject(
  source: AsyncIterable<Uint8Array>,
  opts: JsonStreamOptions,
): AsyncGenerator<JsonStreamEvent> {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const streamed = new Set(opts.arrayKeys);
  let phase: Phase = 'start';
  let key = '';
  let buf = '';
  let depth = 0;
  let inString = false;
  let escape = false;
  let count = 0;
  const pending: JsonStreamEvent[] = [];

  const fail = (reason: JsonStreamFailure, message: string): never => {
    throw new JsonStreamError(reason, message);
  };
  const parse = (text: string, what: string): unknown => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return fail('malformed', `malformed JSON ${what}`);
    }
  };
  const beginCapture = (): void => {
    buf = '';
    depth = 0;
    inString = false;
    escape = false;
  };
  /** Feed one char of a value/element being captured; true when the value ended
   * at this char (the char itself is a delimiter, not part of the value). */
  const capture = (c: string, closer: '}' | ']'): boolean => {
    if (inString) {
      buf += c;
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      buf += c;
    } else if (c === '{' || c === '[') {
      depth += 1;
      buf += c;
    } else if (c === '}' || c === ']') {
      if (depth === 0) {
        if (c !== closer) fail('malformed', `unexpected "${c}"`);
        return true;
      }
      depth -= 1;
      buf += c;
    } else if (c === ',' && depth === 0) {
      return true;
    } else {
      buf += c;
    }
    if (exceeds(buf, opts.maxValueBytes)) {
      fail('too_large', `a JSON value exceeds ${String(opts.maxValueBytes)} bytes`);
    }
    return false;
  };

  const step = (c: string): void => {
    switch (phase) {
      case 'start':
        if (WS.has(c)) return;
        if (c !== '{') fail('not_object', 'expected a JSON object');
        phase = 'key_or_end';
        return;
      case 'key_or_end':
        if (WS.has(c)) return;
        if (c === '}') {
          phase = 'done';
          return;
        }
        if (c !== '"') fail('malformed', 'expected a member name');
        buf = '';
        escape = false;
        phase = 'key';
        return;
      case 'key':
        if (escape) {
          escape = false;
          buf += c;
          return;
        }
        if (c === '\\') {
          escape = true;
          buf += c;
          return;
        }
        if (c === '"') {
          key = parse(`"${buf}"`, 'member name') as string;
          buf = '';
          phase = 'colon';
          return;
        }
        buf += c;
        if (exceeds(buf, opts.maxValueBytes)) fail('too_large', 'a member name is too long');
        return;
      case 'colon':
        if (WS.has(c)) return;
        if (c !== ':') fail('malformed', `expected ":" after "${key}"`);
        phase = 'value_start';
        return;
      case 'value_start':
        if (WS.has(c)) return;
        if (c === '[' && streamed.has(key)) {
          pending.push({ type: 'array_start', key });
          count = 0;
          phase = 'element_start';
          return;
        }
        if (c === ',' || c === '}' || c === ']') fail('malformed', `missing value for "${key}"`);
        beginCapture();
        phase = 'value';
        capture(c, '}');
        return;
      case 'value':
        if (capture(c, '}')) {
          pending.push({ type: 'member', key, value: parse(buf, `value for "${key}"`) });
          buf = '';
          phase = c === '}' ? 'done' : 'key_or_end';
        }
        return;
      case 'element_start':
      case 'element_required':
        if (WS.has(c)) return;
        if (c === ']') {
          if (phase === 'element_required') fail('malformed', `trailing comma in "${key}"`);
          pending.push({ type: 'array_end', key, count });
          phase = 'after_array';
          return;
        }
        if (c === ',') fail('malformed', `empty element in "${key}"`);
        beginCapture();
        phase = 'element';
        capture(c, ']');
        return;
      case 'element':
        if (capture(c, ']')) {
          const bytes = Buffer.byteLength(buf, 'utf8');
          pending.push({ type: 'element', key, value: parse(buf, `element of "${key}"`), bytes });
          buf = '';
          count += 1;
          if (c === ']') {
            pending.push({ type: 'array_end', key, count });
            phase = 'after_array';
          } else {
            phase = 'element_required';
          }
        }
        return;
      case 'after_array':
        if (WS.has(c)) return;
        if (c === ',') phase = 'key_or_end';
        else if (c === '}') phase = 'done';
        else fail('malformed', `expected "," or "}" after "${key}"`);
        return;
      case 'done':
        if (!WS.has(c)) fail('malformed', 'unexpected content after the object');
        return;
    }
  };

  for await (const chunk of source) {
    const text = decoder.decode(chunk, { stream: true });
    for (const c of text) {
      step(c);
      if (pending.length > 0) {
        for (const ev of pending) yield ev;
        pending.length = 0;
      }
    }
  }
  for (const c of decoder.decode()) step(c);
  for (const ev of pending) yield ev;
  pending.length = 0;
  // Read through a call: `phase` is mutated inside `step`, which control-flow
  // narrowing cannot see.
  const finalPhase = ((): Phase => phase)();
  if (finalPhase !== 'done') fail('truncated', 'unexpected end of JSON input');
}

/** Split a byte stream into JSON Lines, yielding each non-empty line parsed.
 * Lines are bounded like values; a malformed line is a typed failure. */
export async function* readJsonLines(
  source: AsyncIterable<Uint8Array>,
  maxLineBytes: number,
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let buf = '';
  const flush = (line: string): unknown => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return undefined;
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      throw new JsonStreamError('malformed', 'malformed JSON line');
    }
  };
  for await (const chunk of source) {
    buf += decoder.decode(chunk, { stream: true });
    if (exceeds(buf, maxLineBytes) && !buf.includes('\n')) {
      throw new JsonStreamError('too_large', `a JSON line exceeds ${String(maxLineBytes)} bytes`);
    }
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (exceeds(line, maxLineBytes)) {
        throw new JsonStreamError('too_large', `a JSON line exceeds ${String(maxLineBytes)} bytes`);
      }
      const value = flush(line);
      if (value !== undefined) yield value;
      nl = buf.indexOf('\n');
    }
  }
  buf += decoder.decode();
  const last = flush(buf);
  if (last !== undefined) yield last;
}

/** Adapt a web `ReadableStream` (an `HttpResponse.body`) to the async iterable
 * the scanners consume; a null body is an empty source. */
export async function* bytesOf(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<Uint8Array> {
  if (body === null) return;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined) yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
