/**
 * add-request-error-detail: the sanitization contract. Invariant 8 floor under
 * "provider-verbatim" — secrets AND prompt content must never reach storage.
 */
import { getAdapter } from '../proxy/translate';
import type {
  NormalizedRequest,
  NormalizedStreamEvent,
  SanitizedMessage,
} from '../proxy/translate';

// Tests simulate the adapter — the one legitimate producer besides the factory.
const asSanitized = (s: string): SanitizedMessage => s as SanitizedMessage;
import {
  POLICY_WITHHELD,
  VALIDATION_WITHHELD,
  captureProviderMessage,
  classifyResponse,
  parseErrorEnvelope,
  sanitizeRequestId,
  scrubSecrets,
} from './errors';
import { createOpenaiProviderAdapter } from './openai-adapter';
import { createResponsesProviderAdapter } from './responses-adapter';
import { oaiSse, recordingClient, sseResponse } from './testkit.testkit';

describe('scrubSecrets', () => {
  it('redacts the EXACT configured credential first — including short/custom ones no heuristic catches', () => {
    expect(scrubSecrets('key "hunter2" rejected', ['hunter2'])).toBe('key "[redacted]" rejected');
  });

  it('redacts URL-encoded and base64 variants of the exact credential', () => {
    const secret = 'p@ss w0rd+x';
    const enc = encodeURIComponent(secret);
    const b64 = Buffer.from(secret, 'utf8').toString('base64');
    const out = scrubSecrets(`a ${enc} b ${b64} c`, [secret]);
    expect(out).not.toContain(enc);
    expect(out).not.toContain(b64);
  });

  it('redacts key-shaped tokens, Bearer/Basic values, JWTs, cookies, and field values', () => {
    expect(scrubSecrets('bad key sk-abc123def456ghi789')).not.toContain('sk-abc123def456');
    expect(scrubSecrets('Authorization: Bearer abcdef012345')).not.toContain('abcdef012345');
    expect(scrubSecrets('Authorization: Basic dXNlcjpwYXNz')).not.toContain('dXNlcjpwYXNz');
    expect(scrubSecrets('api_key=supersecretvalue1 more')).toContain('api_key=[redacted]');
    expect(scrubSecrets('set-cookie: session=deadbeef; Path=/')).toContain('cookie: [redacted]');
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
    expect(scrubSecrets(`token ${jwt} expired`)).not.toContain(jwt);
    expect(scrubSecrets('poly_abcdefghijklmnop rejected')).not.toContain('poly_abcdefghijklmnop');
  });

  it('redacts bare long opaque runs (hex/base64 ≥ 32)', () => {
    const hex = 'a'.repeat(40);
    expect(scrubSecrets(`trace ${hex} end`)).not.toContain(hex);
  });

  it('normalizes zero-width/bidi evasion before matching', () => {
    const evasive = 'sk-​abc123def456ghi789';
    expect(scrubSecrets(`key ${evasive}`)).not.toContain('abc123def456ghi789');
  });

  it('redacts a LINE-WRAPPED exact credential (r3: all C0 controls stripped before matching)', () => {
    const secret = 'sk-wrapme123456789';
    const wrapped = 'sk-\nwrapme123\t456789';
    expect(scrubSecrets(`key ${wrapped} bad`, [secret])).not.toContain('wrapme123');
  });

  it('redacts LOWERCASE percent-encoded and unpadded/URL-safe base64 variants (r3)', () => {
    const secret = 'p+ss/w=rd';
    const lowerPct = encodeURIComponent(secret).toLowerCase();
    const std = Buffer.from(secret, 'utf8').toString('base64');
    const urlSafeUnpadded = std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const out = scrubSecrets(`a ${lowerPct} b ${urlSafeUnpadded} c`, [secret]);
    expect(out.toLowerCase()).not.toContain(lowerPct);
    expect(out).not.toContain(urlSafeUnpadded);
  });

  it('is idempotent and total', () => {
    const once = scrubSecrets('Bearer abcdef012345 plus sk-abc123def456ghi789', ['x']);
    expect(scrubSecrets(once, ['x'])).toBe(once);
    expect(scrubSecrets('', [])).toBe('');
    expect(scrubSecrets('plain text stays', [''])).toBe('plain text stays');
  });
});

describe('sanitizeRequestId', () => {
  it('passes conventional ids and drops everything else', () => {
    expect(sanitizeRequestId('req_abc-123.XY')).toBe('req_abc-123.XY');
    expect(sanitizeRequestId('evil\r\nheader')).toBeUndefined();
    expect(sanitizeRequestId('with space')).toBeUndefined();
    expect(sanitizeRequestId('x'.repeat(129))).toBeUndefined();
    expect(sanitizeRequestId('')).toBeUndefined();
    expect(sanitizeRequestId(null)).toBeUndefined();
    expect(sanitizeRequestId(undefined)).toBeUndefined();
  });
});

describe('captureProviderMessage — the ONLY producer of a persistable message', () => {
  const op = { kind: 'rate_limit' as const };

  it('walks nested error envelopes for the first string message (operational kind → verbatim)', () => {
    expect(
      captureProviderMessage(
        {
          source: 'parsed-envelope',
          envelope: { error: { message: 'Rate limit exceeded: free-models-per-day' } },
        },
        op,
      ),
    ).toBe('Rate limit exceeded: free-models-per-day');
    expect(
      captureProviderMessage(
        {
          source: 'parsed-envelope',
          envelope: { error: { error: { message: 'nested', code: 'x' } } },
        },
        op,
      ),
    ).toBe('nested');
  });

  it('yields null for shapeless/non-JSON bodies — raw text NEVER persists', () => {
    expect(parseErrorEnvelope('<html>proxy error: secret prompt echo</html>')).toBeNull();
    expect(captureProviderMessage({ source: 'parsed-envelope', envelope: null }, op)).toBeNull();
    expect(
      captureProviderMessage(
        { source: 'parsed-envelope', envelope: { detail: 'no message field' } },
        op,
      ),
    ).toBeNull();
  });

  it('withholds bad_request/validation messages (they echo submitted content)', () => {
    expect(
      captureProviderMessage(
        {
          source: 'parsed-envelope',
          envelope: { error: { message: 'invalid value at messages[3]: "my secret prompt"' } },
        },
        { kind: 'bad_request' },
      ),
    ).toBe(VALIDATION_WITHHELD);
  });

  it('withholds content-policy messages via type OR code — with precedence over the validation marker', () => {
    expect(
      captureProviderMessage(
        {
          source: 'parsed-envelope',
          envelope: {
            error: {
              type: 'invalid_request_error',
              code: 'content_filter',
              message: 'flagged: <prompt>',
            },
          },
        },
        { kind: 'bad_request' },
      ),
    ).toBe(POLICY_WITHHELD);
    expect(
      captureProviderMessage(
        { source: 'stream-wire', type: 'moderation_block', message: 'quoted prompt here' },
        { kind: 'unavailable' },
      ),
    ).toBe(POLICY_WITHHELD);
  });

  it('scrubs secrets from operational messages (auth included) and caps AFTER scrubbing', () => {
    expect(
      captureProviderMessage(
        {
          source: 'parsed-envelope',
          envelope: { error: { message: 'Incorrect API key provided: sk-abc123def456ghi789' } },
        },
        { kind: 'auth', secrets: [] },
      ),
    ).toBe('Incorrect API key provided: [redacted]');
    const long = `padding ${'x '.repeat(160)}tail-secretvalue`;
    const out = captureProviderMessage(
      { source: 'parsed-envelope', envelope: { error: { message: long } } },
      { kind: 'unavailable', secrets: ['tail-secretvalue'] },
    );
    expect(out).not.toBeNull();
    expect(out).not.toContain('tail-secretvalue'); // scrub ran on the FULL text, then the cap
    expect((out as string).length).toBeLessThanOrEqual(300);
  });

  it('a generic outward type cannot launder a validation CODE into verbatim (r3-High-1)', () => {
    // The Responses wire shape: type='error', code carries the real category.
    expect(
      captureProviderMessage(
        {
          source: 'stream-wire',
          type: 'error',
          code: 'invalid_request_error',
          message: 'invalid messages[2]: <prompt>',
        },
        { kind: 'unavailable' }, // even a misderived caller kind must not leak it
      ),
    ).toBe(VALIDATION_WITHHELD);
  });

  it('a policy marker behind an OUTER wrapper is still seen (r3-High-1, nested envelope)', () => {
    expect(
      captureProviderMessage(
        {
          source: 'parsed-envelope',
          envelope: {
            type: 'error',
            error: { type: 'content_filter', message: 'flagged: <prompt>' },
          },
        },
        { kind: 'unavailable' },
      ),
    ).toBe(POLICY_WITHHELD);
  });

  it('stream-wire input carries verbatim operational messages', () => {
    expect(
      captureProviderMessage(
        { source: 'stream-wire', type: 'overloaded_error', message: 'Overloaded' },
        { kind: 'unavailable' },
      ),
    ).toBe('Overloaded');
  });
});

describe('adapter-stage stream sanitization (the layer holding the credential)', () => {
  const config = {
    protocol: 'openai_compatible' as const,
    baseUrl: 'https://api.openai.example/v1',
    credential: 'zz9', // deliberately SHORT — only exact-match redaction can catch it
    kind: 'api_key' as const,
    mode: 'cloud' as const,
  };
  const request: NormalizedRequest = {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    params: {},
  };
  const collect = async (
    gen: AsyncGenerator<NormalizedStreamEvent>,
  ): Promise<NormalizedStreamEvent[]> => {
    const out: NormalizedStreamEvent[] = [];
    for await (const ev of gen) out.push(ev);
    return out;
  };

  it('replaces raw wire fields with the branded sanitized message + allowlisted request id', async () => {
    const sse = `data: ${JSON.stringify({ error: { type: 'server_error', message: 'credential zz9 rejected upstream' } })}\n\n`;
    const { client } = recordingClient(() =>
      sseResponse(sse, { headers: { 'x-request-id': 'req_777' } }),
    );
    const adapter = createOpenaiProviderAdapter(config, { httpClient: client });
    const events = await collect(adapter.chatStream(request));
    const err = events.find((e) => e.type === 'error');
    if (err?.type !== 'error') throw new Error('no error event');
    expect(err.diagnostic?.wire).toBeUndefined(); // raw text never leaves the adapter
    expect(err.diagnostic?.providerMessage).toBe('credential [redacted] rejected upstream');
    expect(err.diagnostic?.requestId).toBe('req_777');
  });

  it('drops a malicious response-header request id and passes synthetic events untouched', async () => {
    const chunks = oaiSse([
      {
        id: 'c',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
      },
    ]); // no terminator → synthetic truncated error event (no wire diagnostic)
    const { client } = recordingClient(() =>
      sseResponse(chunks, { headers: { 'x-request-id': 'evil\r\nvalue' } }),
    );
    const adapter = createOpenaiProviderAdapter(config, { httpClient: client });
    const events = await collect(adapter.chatStream(request));
    const err = events.find((e) => e.type === 'error');
    if (err?.type !== 'error') throw new Error('no error event');
    expect(err.error.type).toBe('truncated');
    expect(err.diagnostic).toBeUndefined(); // synthetic — nothing provider-said, nothing enriched
  });
});

describe('Responses buffered facade preserves the sanitized diagnostic (r3-Medium-3)', () => {
  it('chat() carries providerMessage (credential-scrubbed) + request id into the thrown ProviderError', async () => {
    const sse =
      'event: response.created\ndata: {"type":"response.created","response":{}}\n\n' +
      'event: response.failed\ndata: ' +
      JSON.stringify({
        type: 'response.failed',
        response: { error: { code: 'server_error', message: 'upstream broke with token zz9' } },
      }) +
      '\n\n';
    const { client } = recordingClient(() =>
      sseResponse(sse, { headers: { 'x-request-id': 'req_resp_1' } }),
    );
    const adapter = createResponsesProviderAdapter(
      {
        protocol: 'openai_responses',
        baseUrl: 'https://chatgpt.example',
        credential: 'zz9',
        kind: 'subscription',
        mode: 'selfhosted',
        authScheme: 'oauth_bearer',
        oauthAccountId: 'acct-123',
        probeModel: 'gpt-5.4-mini',
      },
      { httpClient: client },
    );
    const req: NormalizedRequest = {
      model: 'gpt-5.4-mini',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      params: {},
    };
    let thrown: unknown;
    try {
      await adapter.chat(req);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const pe = thrown as { providerMessage?: string; requestId?: string };
    expect(pe.providerMessage).toBe('upstream broke with token [redacted]');
    expect(pe.requestId).toBe('req_resp_1');
  });
});

describe('serializers never emit the diagnostic (client frames byte-identical)', () => {
  it.each(['anthropic', 'openai'] as const)('%s streamSerialize', async (proto) => {
    // eslint-disable-next-line @typescript-eslint/require-await -- AsyncGenerator by contract
    const gen = async function* (withDiag: boolean): AsyncGenerator<NormalizedStreamEvent> {
      yield {
        type: 'error',
        error: { type: 'overloaded', message: 'upstream stream error' },
        ...(withDiag
          ? {
              diagnostic: { providerMessage: asSanitized('SECRET-detail zz9'), requestId: 'req_1' },
            }
          : {}),
      };
    };
    const frames = async (withDiag: boolean): Promise<string> => {
      let out = '';
      for await (const f of getAdapter(proto).streamSerialize(gen(withDiag), { created: 1 })) {
        out += f;
      }
      return out;
    };
    const [withD, withoutD] = await Promise.all([frames(true), frames(false)]);
    expect(withD).toBe(withoutD); // byte-identical — the diagnostic never hits the wire
    expect(withD).not.toContain('SECRET-detail');
  });
});

describe('classifyResponse — providerMessage capture', () => {
  it('attaches the factory result for operational kinds', () => {
    const err = classifyResponse(429, '{"error":{"message":"Rate limit exceeded"}}', {}, []);
    expect(err.kind).toBe('rate_limit');
    expect(err.providerMessage).toBe('Rate limit exceeded');
  });

  it('withholds validation detail on 400s while keeping the curated snippet message', () => {
    const err = classifyResponse(400, '{"error":{"message":"invalid messages[0]: <prompt>"}}');
    expect(err.kind).toBe('bad_request');
    expect(err.providerMessage).toBe(VALIDATION_WITHHELD);
  });

  it('records no providerMessage for non-JSON bodies', () => {
    const err = classifyResponse(502, '<html>Bad Gateway</html>');
    expect(err.kind).toBe('unavailable');
    expect(err.providerMessage).toBeUndefined();
  });

  it('exact-redacts the configured credential in an auth body', () => {
    const err = classifyResponse(401, '{"error":{"message":"key zz9 is not valid"}}', {}, ['zz9']);
    expect(err.providerMessage).toBe('key [redacted] is not valid');
  });
});
