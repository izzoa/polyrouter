/**
 * SSE plumbing shared by both adapters' streaming paths. `sseFrames` is a
 * chunk-boundary-tolerant parser: it buffers partial lines so a `data:` line
 * split across chunks is only dispatched once its terminating newline arrives
 * (spec: "tolerate SSE frames split across chunk boundaries").
 */

export interface SseFrame {
  readonly event?: string;
  readonly data: string;
}

/** Turn a stream of raw SSE text chunks into dispatched frames. */
export async function* sseFrames(chunks: AsyncIterable<string>): AsyncGenerator<SseFrame> {
  let buffer = '';
  let dataLines: string[] = [];
  let eventName: string | undefined;

  const flush = function* (): Generator<SseFrame> {
    if (dataLines.length > 0) {
      const frame: SseFrame =
        eventName !== undefined
          ? { event: eventName, data: dataLines.join('\n') }
          : { data: dataLines.join('\n') };
      dataLines = [];
      eventName = undefined;
      yield frame;
    } else {
      // A blank line with only an event: and no data: is not dispatched.
      eventName = undefined;
    }
  };

  const handleLine = function* (line: string): Generator<SseFrame> {
    if (line === '') {
      yield* flush();
      return;
    }
    if (line.startsWith(':')) return; // comment
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') eventName = value;
    // id/retry and unknown fields are ignored
  };

  for await (const chunk of chunks) {
    buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      yield* handleLine(line);
    }
  }
  // Flush any trailing buffered line and a final undispatched frame (some
  // servers omit the terminating blank line).
  if (buffer.length > 0) yield* handleLine(buffer);
  yield* flush();
}

export function formatSseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export function formatSseEvent(event: string, obj: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;
}

/** Convert an array of chunk strings into an async iterable (test helper). */
// eslint-disable-next-line @typescript-eslint/require-await -- a synchronous source presented as an async iterable
export async function* fromChunks(chunks: readonly string[]): AsyncGenerator<string> {
  for (const c of chunks) yield c;
}

/** Collect an async iterable into an array (test helper). */
export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}
