/** Test-only helpers (excluded from the build). Fake `HttpClient`/`HttpResponse`
 * so adapter tests need no network; SSE builders for the streaming paths. */
import type { HttpClient, HttpInit, HttpResponse } from './http';

function sliceBytes(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out.length > 0 ? out : [bytes];
}

export function streamFromChunks(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]!);
      else controller.close();
    },
  });
}

function makeResponse(
  status: number,
  text: string | undefined,
  headers: Record<string, string>,
  bodyChunks?: readonly Uint8Array[],
): HttpResponse {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const body =
    bodyChunks !== undefined
      ? streamFromChunks(bodyChunks)
      : text !== undefined
        ? streamFromChunks([new TextEncoder().encode(text)])
        : null;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n) => h.get(n.toLowerCase()) ?? null },
    body,
    text: () => Promise.resolve(text ?? ''),
    json: () => Promise.resolve(JSON.parse(text ?? '{}') as unknown),
  };
}

export function jsonResponse(
  obj: unknown,
  status = 200,
  headers: Record<string, string> = {},
): HttpResponse {
  return makeResponse(status, JSON.stringify(obj), headers);
}

export function errorResponse(
  status: number,
  bodyText = '',
  headers: Record<string, string> = {},
): HttpResponse {
  return makeResponse(status, bodyText, headers);
}

export function sseResponse(
  sse: string,
  opts: { status?: number; headers?: Record<string, string>; chunkSize?: number } = {},
): HttpResponse {
  const bytes = new TextEncoder().encode(sse);
  const chunks = opts.chunkSize !== undefined ? sliceBytes(bytes, opts.chunkSize) : [bytes];
  return makeResponse(
    opts.status ?? 200,
    sse,
    { 'content-type': 'text/event-stream', ...(opts.headers ?? {}) },
    chunks,
  );
}

export interface RecordedCall {
  readonly url: string;
  readonly init: HttpInit;
}

export function recordingClient(
  responder: (url: string, init: HttpInit) => HttpResponse | Promise<HttpResponse>,
): { client: HttpClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client: HttpClient = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  return { client, calls };
}

/** OpenAI chat-completion chunks → an SSE string terminated by [DONE]. */
export function oaiSse(chunks: readonly unknown[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

/** Anthropic events (`{event, data}`) → an SSE string. */
export function antSse(events: readonly { event: string; data: unknown }[]): string {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
}
