import { SsrfError } from '@polyrouter/shared/server';
import { batchFactoryFor, createProviderAdapter } from './factory';
import type { NormalizedRequest } from '../proxy/translate';

const base = {
  baseUrl: 'https://api.example/v1',
  credential: 'k',
  kind: 'api_key' as const,
  mode: 'cloud' as const,
};

const request: NormalizedRequest = {
  model: 'm',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  params: {},
};

describe('provider adapter factory', () => {
  it('selects the adapter by protocol', () => {
    expect(createProviderAdapter({ ...base, protocol: 'openai_compatible' }).protocol).toBe(
      'openai_compatible',
    );
    expect(createProviderAdapter({ ...base, protocol: 'anthropic_compatible' }).protocol).toBe(
      'anthropic_compatible',
    );
  });

  it('rejects a local provider under MODE=cloud', () => {
    expect(() =>
      createProviderAdapter({
        ...base,
        protocol: 'openai_compatible',
        kind: 'local',
        mode: 'cloud',
      }),
    ).toThrow(/selfhosted/i);
  });

  it('defaults to the guarded HTTP client (a private base_url is refused)', async () => {
    const adapter = createProviderAdapter({
      ...base,
      protocol: 'openai_compatible',
      baseUrl: 'http://10.0.0.1/v1',
    });
    await expect(adapter.chat(request)).rejects.toBeInstanceOf(SsrfError);
  });
});

describe('batch seam attachment by family (add-batch-inference task 2.10)', () => {
  const api = { credential: 'k', kind: 'api_key' as const, mode: 'cloud' as const };

  it('attaches OpenRouter and Anthropic batch implementations by family + protocol', () => {
    const or = createProviderAdapter({
      ...api,
      protocol: 'openai_compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    expect(or.batch).toBeDefined();
    expect(or.batch!.limits.maxItems).toBeNull();
    // OpenAI's files + batches implementation (Phase C), on the API-key wire.
    // `openai_responses` is the ChatGPT subscription protocol and carries no seam:
    // it cannot even be built without an OAuth credential, and a flat-rate plan has
    // no Batch API behind it (asserted in the negative case below).
    const oai = createProviderAdapter({
      ...api,
      protocol: 'openai_compatible',
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(oai.batch).toBeDefined();
    expect(oai.batch!.limits.maxItems).toBe(50_000);
    const ant = createProviderAdapter({
      ...api,
      protocol: 'anthropic_compatible',
      baseUrl: 'https://api.anthropic.com',
    });
    expect(ant.batch).toBeDefined();
    expect(ant.batch!.limits.maxItems).toBe(100_000);
    // A subscription (OAuth) Anthropic provider is the same family — it carries the seam
    // and answers with the provider's own auth error if the plan lacks batches.
    const sub = createProviderAdapter({
      ...api,
      kind: 'subscription',
      protocol: 'anthropic_compatible',
      baseUrl: 'https://api.anthropic.com',
    });
    expect(sub.batch).toBeDefined();
  });

  it('attaches none for custom/local kinds, families without a batch API, or a mismatched protocol', () => {
    expect(
      createProviderAdapter({
        ...api,
        kind: 'custom',
        protocol: 'openai_compatible',
        baseUrl: 'https://openrouter.ai/api/v1',
      }).batch,
    ).toBeUndefined();
    expect(
      createProviderAdapter({
        ...api,
        kind: 'local',
        mode: 'selfhosted',
        protocol: 'openai_compatible',
        baseUrl: 'http://127.0.0.1:11434/v1',
      }).batch,
    ).toBeUndefined();
    expect(
      createProviderAdapter({
        ...api,
        protocol: 'openai_compatible',
        baseUrl: 'https://api.deepseek.com',
      }).batch,
    ).toBeUndefined();
    expect(
      createProviderAdapter({
        ...api,
        protocol: 'openai_compatible',
        baseUrl: 'https://api.anthropic.com',
      }).batch,
    ).toBeUndefined();
    // An Anthropic-protocol provider on the OpenAI host has no batch API of that
    // shape: the family alone never decides, the protocol has to agree.
    expect(
      createProviderAdapter({
        ...api,
        protocol: 'anthropic_compatible',
        baseUrl: 'https://api.openai.com/v1',
      }).batch,
    ).toBeUndefined();
    // The ChatGPT subscription wire: no batch surface behind a flat-rate plan.
    expect(
      batchFactoryFor({
        ...api,
        kind: 'subscription',
        protocol: 'openai_responses',
        baseUrl: 'https://api.openai.com/v1',
      }),
    ).toBeUndefined();
    expect(
      createProviderAdapter({ ...api, protocol: 'openai_compatible', baseUrl: 'not a url' }).batch,
    ).toBeUndefined();
  });

  it('honours an injected batch factory (the test seam) over the family rule', () => {
    const fake = {
      limits: { maxItems: 1, maxBytes: 1, customIdPattern: null, completionWindowMs: 1 },
    } as unknown as import('./batch').BatchAdapter;
    const adapter = createProviderAdapter(
      { ...api, protocol: 'openai_compatible', baseUrl: 'https://api.deepseek.com' },
      { batch: () => fake },
    );
    expect(adapter.batch).toBe(fake);
  });
});
