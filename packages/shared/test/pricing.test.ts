import { describe, expect, it } from 'vitest';
import {
  canonicalModelKey,
  deriveModelKey,
  resolveModelPrice,
} from '../src/server/pricing/resolve';
import { parseLiteLlmCatalog } from '../src/server/pricing/litellm';
import type { ModelPriceRow } from '../src/server/db/schema';

const catalogRow = (over: Partial<ModelPriceRow> = {}): ModelPriceRow => ({
  id: 'v1',
  modelKey: 'openai:gpt-4o',
  inputPricePer1m: 2.5,
  outputPricePer1m: 10,
  cacheReadPricePer1m: 1.25,
  cacheWritePricePer1m: null,
  contextWindow: 128000,
  supportsTools: true,
  supportsVision: true,
  supportsReasoning: false,
  isFree: false,
  source: 'bundled',
  validFrom: new Date('2026-07-15T00:00:00Z'),
  createdAt: new Date('2026-07-15T00:00:00Z'),
  ...over,
});

describe('canonicalModelKey', () => {
  it('namespaces and normalizes', () => {
    expect(canonicalModelKey('openai', 'gpt-4o')).toBe('openai:gpt-4o');
    expect(canonicalModelKey('OpenAI', ' GPT-4O ')).toBe('openai:gpt-4o');
  });
  it('strips exactly one leading <family>/ prefix', () => {
    expect(canonicalModelKey('gemini', 'gemini/gemini-1.5-pro')).toBe('gemini:gemini-1.5-pro');
    expect(canonicalModelKey('openrouter', 'openrouter/meta/llama')).toBe('openrouter:meta/llama');
  });
});

describe('deriveModelKey', () => {
  it('maps known hosts to the LiteLLM family', () => {
    expect(deriveModelKey('https://api.openai.com/v1', 'gpt-4o')).toBe('openai:gpt-4o');
    expect(deriveModelKey('https://generativelanguage.googleapis.com', 'gemini-1.5-pro')).toBe(
      'gemini:gemini-1.5-pro',
    );
  });
  it('returns null for an unknown/reseller host or bad url (never a wrong price)', () => {
    expect(deriveModelKey('https://reseller.example/v1', 'gpt-4o')).toBeNull();
    expect(deriveModelKey('not a url', 'gpt-4o')).toBeNull();
  });
  it('round-trips with the parser key for a prefixed Gemini entry', () => {
    const parsed = parseLiteLlmCatalog({
      'gemini/gemini-1.5-pro': {
        litellm_provider: 'gemini',
        mode: 'chat',
        input_cost_per_token: 0.00000125,
        output_cost_per_token: 0.000005,
      },
    });
    expect(parsed[0]?.modelKey).toBe('gemini:gemini-1.5-pro');
    expect(deriveModelKey('https://generativelanguage.googleapis.com', 'gemini-1.5-pro')).toBe(
      parsed[0]?.modelKey,
    );
  });
});

describe('resolveModelPrice', () => {
  const base = {
    providerKind: 'api_key',
    modelInputPricePer1m: null,
    modelOutputPricePer1m: null,
    modelIsFree: false,
  };

  it('prefers explicit Model-own prices', () => {
    const snap = resolveModelPrice(
      { ...base, modelInputPricePer1m: 5, modelOutputPricePer1m: 12, modelIsFree: false },
      catalogRow(),
    );
    expect(snap).toMatchObject({ source: 'model', inputPricePer1m: 5, outputPricePer1m: 12 });
  });
  it('treats local as free', () => {
    const snap = resolveModelPrice({ ...base, providerKind: 'local' }, null);
    expect(snap).toMatchObject({
      source: 'local',
      inputPricePer1m: 0,
      outputPricePer1m: 0,
      isFree: true,
    });
  });
  it('uses the catalog row with version + nullable cache rates', () => {
    const snap = resolveModelPrice(base, catalogRow());
    expect(snap).toMatchObject({
      source: 'bundled',
      priceVersionId: 'v1',
      inputPricePer1m: 2.5,
      cacheReadPricePer1m: 1.25,
      cacheWritePricePer1m: null,
    });
    expect(snap?.validFrom).toBeInstanceOf(Date);
  });
  it('returns null for an unknown price (distinct from usage_estimated)', () => {
    expect(resolveModelPrice(base, null)).toBeNull();
  });
});

describe('parseLiteLlmCatalog', () => {
  const fixture = {
    sample_spec: { note: 'placeholder' },
    'gpt-4o': {
      litellm_provider: 'openai',
      mode: 'chat',
      input_cost_per_token: 0.0000025,
      output_cost_per_token: 0.00001,
      cache_read_input_token_cost: 0.00000125,
      max_input_tokens: 128000,
      supports_function_calling: true,
      supports_vision: true,
    },
    'text-embedding-3-small': {
      litellm_provider: 'openai',
      mode: 'embedding',
      input_cost_per_token: 0.00000002,
      output_cost_per_token: 0,
    },
    'openrouter/free-model:free': {
      litellm_provider: 'openrouter',
      mode: 'chat',
      input_cost_per_token: 0,
      output_cost_per_token: 0,
    },
    broken: { litellm_provider: 'openai', mode: 'chat' }, // missing costs → skipped
  };

  it('maps chat entries to per-1M USD, strips prefixes, skips non-chat/placeholder/malformed', () => {
    const rows = parseLiteLlmCatalog(fixture);
    const byKey = new Map(rows.map((r) => [r.modelKey, r]));
    expect(byKey.get('openai:gpt-4o')).toMatchObject({
      inputPricePer1m: 2.5,
      outputPricePer1m: 10,
      cacheReadPricePer1m: 1.25,
      contextWindow: 128000,
      supportsTools: true,
      supportsVision: true,
    });
    expect(byKey.get('openrouter:free-model:free')?.isFree).toBe(true);
    expect(byKey.has('openai:text-embedding-3-small')).toBe(false); // embedding skipped
    expect(rows.some((r) => r.modelKey.includes('broken'))).toBe(false); // missing costs skipped
    expect(rows.some((r) => r.modelKey === 'sample_spec')).toBe(false);
  });
});
