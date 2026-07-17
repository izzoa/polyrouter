// E11.1: a provider `base_url` is address-safe but its response is untrusted (no
// allow-list), so the buffered (non-streaming) drain must bound memory itself. A
// body over the cap rejects with a typed `bad_request` (neither trips the breaker
// nor falls back); a normal body drains; streaming is NOT subject to the buffered
// cap; and `parseModelList` bounds the entry count it will materialize.
import { createOpenaiProviderAdapter } from './openai-adapter';
import { parseModelList } from './http-adapter';
import { MAX_PARSED_MODELS } from './adapter';
import { readSseChunks, type HttpClient, type HttpResponse } from './http';
import type { NormalizedRequest } from '../proxy/translate';

const CAP = 64; // tiny cap so a small body overflows it (no real 10 MiB body needed)
const config = {
  protocol: 'openai_compatible' as const,
  baseUrl: 'https://api.openai.example/v1',
  credential: 'sk-secret',
  kind: 'api_key' as const,
  mode: 'cloud' as const,
  firstByteTimeoutMs: 5_000,
  idleTimeoutMs: 5_000,
  maxResponseBytes: CAP,
};

const request: NormalizedRequest = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  params: {},
};

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A 200 whose body streams `chunks` (each its own pull) then closes. */
function streamedResponse(chunks: string[]): HttpResponse {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc(chunks[i]!));
        i += 1;
      } else {
        controller.close();
      }
    },
  });
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    body,
    text: () => Promise.resolve(chunks.join('')),
    json: () => Promise.resolve({}),
  };
}

function adapterFor(chunks: string[]): ReturnType<typeof createOpenaiProviderAdapter> {
  const client: HttpClient = () => Promise.resolve(streamedResponse(chunks));
  return createOpenaiProviderAdapter(config, { httpClient: client });
}

describe('E11.1 — buffered response byte cap', () => {
  it('a buffered chat body over the cap rejects with a typed bad_request', async () => {
    // ~10 chunks of 20 bytes = 200 bytes, well over the 64-byte cap.
    const chunks = Array.from({ length: 10 }, () => 'x'.repeat(20));
    await expect(adapterFor(chunks).chat(request)).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'bad_request',
    });
  });

  it('a buffered listModels body over the cap rejects the same way (all buffered reads)', async () => {
    const chunks = Array.from({ length: 10 }, () => 'y'.repeat(20));
    await expect(adapterFor(chunks).listModels()).rejects.toMatchObject({ kind: 'bad_request' });
  });

  it('a normal-sized body under the cap still drains and parses', async () => {
    const ok = {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-4o',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const json = JSON.stringify(ok);
    // Raise the cap above this body only, to prove the drain itself is fine.
    const client: HttpClient = () => Promise.resolve(streamedResponse([json]));
    const adapter = createOpenaiProviderAdapter(
      { ...config, maxResponseBytes: json.length + 16 },
      { httpClient: client },
    );
    const res = await adapter.chat(request);
    expect(res.content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('a streaming SSE body of many chunks is NOT subject to the buffered cap', async () => {
    // Far more than CAP bytes across chunks — readSseChunks consumes incrementally.
    const frames = Array.from(
      { length: 50 },
      (_v, i) => `data: chunk-${String(i)} padding-padding\n\n`,
    );
    const res = streamedResponse(frames);
    let total = 0;
    for await (const piece of readSseChunks(res)) total += piece.length;
    expect(total).toBeGreaterThan(CAP); // consumed well past the buffered cap, no throw
  });
});

describe('E11.1 — parseModelList entry-count cap', () => {
  it('caps a pathologically large model array at MAX_PARSED_MODELS', () => {
    const data = Array.from({ length: MAX_PARSED_MODELS + 500 }, (_v, i) => ({
      id: `m-${String(i)}`,
    }));
    const out = parseModelList({ data });
    expect(out.length).toBe(MAX_PARSED_MODELS);
  });

  it('parses a normal list unchanged', () => {
    const out = parseModelList({ data: [{ id: 'a' }, { id: 'b', foo: 1 }, { bad: true }] });
    expect(out.map((m) => m.id)).toEqual(['a', 'b']); // the id-less entry is skipped
  });

  it('a flood of over-long ids does NOT consume the cap and starve the valid ids', () => {
    // MAX_PARSED_MODELS oversized ids (each > MAX_MODEL_ID_LEN) then a valid one.
    // The oversized ids are skipped before the cap, so the valid id survives — if
    // they counted toward the cap, parsing would stop before reaching it.
    const junk = Array.from({ length: MAX_PARSED_MODELS }, (_v, i) => ({
      id: `${'z'.repeat(600)}-${String(i)}`,
    }));
    const out = parseModelList({ data: [...junk, { id: 'real-model' }] });
    expect(out.map((m) => m.id)).toEqual(['real-model']);
  });

  it('a flood of duplicate ids does NOT consume the cap and starve the valid ids', () => {
    const dupes = Array.from({ length: MAX_PARSED_MODELS }, () => ({ id: 'same' }));
    const out = parseModelList({ data: [...dupes, { id: 'real-model' }] });
    expect(out.map((m) => m.id)).toEqual(['same', 'real-model']); // deduped, valid survives
  });
});
