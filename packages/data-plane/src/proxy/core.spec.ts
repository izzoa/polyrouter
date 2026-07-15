/* eslint-disable @typescript-eslint/require-await, require-yield -- fake async generators in tests */
import { openStream, runBuffered } from './core';
import { getAdapter, type NormalizedStreamEvent, type NormalizedResponse } from './translate';
import { ProviderError, type ProviderAdapter } from '../providers';

const OPTS = { firstEventTimeoutMs: 1000, created: 1_700_000_000 };

function providerFrom(
  gen: () => AsyncGenerator<NormalizedStreamEvent>,
  chat?: () => Promise<NormalizedResponse>,
): ProviderAdapter {
  return {
    protocol: 'openai_compatible',
    chat: chat ?? (() => Promise.reject(new Error('unused'))),
    chatStream: gen,
    listModels: () => Promise.resolve([]),
    testConnection: () => Promise.resolve({ ok: true, models: 0 }),
  } as unknown as ProviderAdapter;
}

async function collect(frames: AsyncGenerator<string>): Promise<string> {
  let out = '';
  for await (const f of frames) out += f;
  return out;
}

const START: NormalizedStreamEvent = {
  type: 'message_start',
  id: 'm1',
  model: 'gpt-4o',
  role: 'assistant',
};
const TEXT: NormalizedStreamEvent = { type: 'text_delta', index: 0, text: 'hi' };
const STOP: NormalizedStreamEvent = { type: 'message_delta', stopReason: 'stop' };
const END: NormalizedStreamEvent = { type: 'message_stop' };

describe('openStream — commit boundary', () => {
  const client = getAdapter('openai');

  it('commits and streams a clean completion (terminator, no error frame)', async () => {
    const provider = providerFrom(async function* () {
      yield START;
      yield TEXT;
      yield STOP;
      yield END;
    });
    const res = await openStream(provider, client, { model: 'x', messages: [], params: {} }, OPTS);
    expect(res.kind).toBe('stream');
    if (res.kind !== 'stream') throw new Error('unreachable');
    const out = await collect(res.frames);
    expect(out).toContain('"content":"hi"');
    expect(out).toContain('data: [DONE]');
    expect(out).not.toContain('"upstream_error"');
  });

  it('stays pre-commit when the first event is an error event', async () => {
    const provider = providerFrom(async function* () {
      yield { type: 'error', error: { type: 'overloaded', message: 'raw upstream detail' } };
    });
    const res = await openStream(provider, client, { model: 'x', messages: [], params: {} }, OPTS);
    expect(res.kind).toBe('error');
  });

  it('stays pre-commit when the upstream throws before the first event', async () => {
    const provider = providerFrom(async function* (): AsyncGenerator<NormalizedStreamEvent> {
      throw new ProviderError('rate_limit', 'boom');
    });
    const res = await openStream(provider, client, { model: 'x', messages: [], params: {} }, OPTS);
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.error.kind).toBe('rate_limit');
  });

  it('stays pre-commit on an empty stream', async () => {
    const provider = providerFrom(async function* () {
      // yields nothing
    });
    const res = await openStream(provider, client, { model: 'x', messages: [], params: {} }, OPTS);
    expect(res.kind).toBe('error');
  });

  it('classifies a first-event error to its typed kind (not a blanket 503)', async () => {
    const provider = providerFrom(async function* () {
      yield { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } };
    });
    const res = await openStream(provider, client, { model: 'x', messages: [], params: {} }, OPTS);
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.error.kind).toBe('rate_limit');
  });

  it('times out (and cancels the upstream) when no first event arrives', async () => {
    let cancelled = false;
    const stall = {
      protocol: 'openai_compatible',
      chat: () => Promise.reject(new Error('unused')),
      chatStream: async function* (_req: unknown, ctx?: { signal?: AbortSignal }) {
        await new Promise<void>((resolve) => {
          if (ctx?.signal?.aborted) return resolve();
          ctx?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        cancelled = true; // reached only because the timeout aborted us
      },
      listModels: () => Promise.resolve([]),
      testConnection: () => Promise.resolve({ ok: true, models: 0 }),
    } as unknown as ProviderAdapter;
    const res = await openStream(
      stall,
      client,
      { model: 'x', messages: [], params: {} },
      { firstEventTimeoutMs: 40, created: 1 },
    );
    expect(res.kind).toBe('error');
    expect(cancelled).toBe(true); // the upstream was aborted, not left hanging
  });

  it('emits a sanitized terminal error frame on a mid-stream failure (no swap, no raw detail)', async () => {
    const provider = providerFrom(async function* () {
      yield START;
      yield TEXT;
      yield { type: 'error', error: { type: 'overloaded', message: 'SECRET raw upstream detail' } };
    });
    const res = await openStream(provider, client, { model: 'x', messages: [], params: {} }, OPTS);
    expect(res.kind).toBe('stream');
    if (res.kind !== 'stream') throw new Error('unreachable');
    const out = await collect(res.frames);
    expect(out).toContain('"content":"hi"'); // content before the failure was delivered
    expect(out).toContain('"upstream_error"'); // terminal error frame
    expect(out).toContain('data: [DONE]');
    expect(out).not.toContain('SECRET'); // raw upstream text never leaks
  });
});

describe('openStream — outcome (usage capture for #11)', () => {
  const client = getAdapter('openai');
  const REQ = { model: 'x', messages: [], params: {} };

  it('captures merged usage + output chars on a clean completion', async () => {
    const provider = providerFrom(async function* () {
      yield {
        type: 'message_start',
        id: 'm',
        model: 'gpt-4o',
        role: 'assistant',
        usage: { inputTokens: 10 },
      };
      yield { type: 'text_delta', index: 0, text: 'hello' };
      yield { type: 'message_delta', stopReason: 'stop', usage: { outputTokens: 7 } };
      yield { type: 'message_stop' };
    });
    const res = await openStream(provider, client, REQ, OPTS);
    if (res.kind !== 'stream') throw new Error('unreachable');
    await collect(res.frames);
    const o = await res.outcome;
    expect(o.status).toBe('success');
    expect(o.usage).toMatchObject({ inputTokens: 10, outputTokens: 7 }); // merged, not summed
    expect(o.outputChars).toBe(5); // 'hello'
  });

  it('settles outcome as error on a mid-stream failure', async () => {
    const provider = providerFrom(async function* () {
      yield START;
      yield TEXT;
      yield { type: 'error', error: { type: 'overloaded', message: 'x' } };
    });
    const res = await openStream(provider, client, REQ, OPTS);
    if (res.kind !== 'stream') throw new Error('unreachable');
    await collect(res.frames);
    expect((await res.outcome).status).toBe('error');
  });

  it('settles outcome as error on an immediate pre-iteration return() (client disconnect)', async () => {
    const provider = providerFrom(async function* () {
      yield START;
      yield TEXT;
      yield STOP;
      yield END;
    });
    const res = await openStream(provider, client, REQ, OPTS);
    if (res.kind !== 'stream') throw new Error('unreachable');
    await res.frames.return(undefined); // never called next()
    expect((await res.outcome).status).toBe('error');
  });
});

describe('runBuffered', () => {
  it('serializes the IR response to the client wire', async () => {
    const response: NormalizedResponse = {
      id: 'r1',
      model: 'gpt-4o',
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'stop',
    };
    const provider = providerFrom(
      async function* () {
        /* unused */
      },
      () => Promise.resolve(response),
    );
    const result = await runBuffered(
      provider,
      getAdapter('openai'),
      { model: 'x', messages: [], params: {} },
      { created: 1 },
    );
    expect((result.wire as { object: string }).object).toBe('chat.completion');
    expect(result.response.content).toHaveLength(1); // IR exposed for #11 usage capture
  });
});
