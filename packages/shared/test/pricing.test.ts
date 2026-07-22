import { describe, expect, it } from 'vitest';
import {
  canonicalModelKey,
  deriveModelKey,
  deriveNativeFamilyKey,
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
  it('maps §8 BYOK international (USD) hosts but NOT the CNY-domestic ones (E5.3)', () => {
    // International/USD endpoints → resolvable family key.
    const intl: [string, string, string][] = [
      ['https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'qwen-max', 'dashscope:qwen-max'],
      ['https://api.moonshot.ai/v1', 'kimi-k2-0905-preview', 'moonshot:kimi-k2-0905-preview'],
      ['https://api.minimax.io/v1', 'MiniMax-M2', 'minimax:minimax-m2'],
      ['https://api.z.ai/api/paas/v4', 'glm-4.5', 'zai:glm-4.5'],
    ];
    for (const [url, model, key] of intl) expect(deriveModelKey(url, model)).toBe(key);
    // CNY-domestic endpoints → null (unknown, never a currency-wrong USD price).
    const cny = [
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
      'https://api.moonshot.cn/v1',
      'https://api.minimax.chat/v1',
      'https://api.minimaxi.com/v1', // the CNY MiniMax endpoint (intl is api.minimax.io)
      'https://open.bigmodel.cn/api/paas/v4',
    ];
    for (const url of cny) expect(deriveModelKey(url, 'some-model')).toBeNull();
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
    listedInputPricePer1m: null,
    listedOutputPricePer1m: null,
    listedIsFree: false,
  };

  it('prefers explicit Model-own prices for a custom/local provider', () => {
    const snap = resolveModelPrice(
      {
        ...base,
        providerKind: 'custom',
        modelInputPricePer1m: 5,
        modelOutputPricePer1m: 12,
        modelIsFree: false,
      },
      catalogRow(),
    );
    expect(snap).toMatchObject({ source: 'model', inputPricePer1m: 5, outputPricePer1m: 12 });
  });

  it('IGNORES a model-own price on an api_key/subscription provider (E5.4) — uses the catalog', () => {
    for (const providerKind of ['api_key', 'subscription'] as const) {
      const snap = resolveModelPrice(
        { ...base, providerKind, modelInputPricePer1m: 5, modelOutputPricePer1m: 12 },
        catalogRow(),
      );
      // A stale/raced model price on a known provider must not override the catalog.
      expect(snap).toMatchObject({ source: 'bundled', inputPricePer1m: 2.5 });
    }
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

describe('deriveNativeFamilyKey (add-native-price-fallback)', () => {
  it('pins the derivation matrix — mapped vendors, aliases, identity', () => {
    expect(deriveNativeFamilyKey('openrouter', 'minimax/minimax-m3')).toBe('minimax:minimax-m3');
    // Mixed case normalizes BEFORE the allowlist lookups.
    expect(deriveNativeFamilyKey('openrouter', 'MiniMax/MiniMax-M3')).toBe('minimax:minimax-m3');
    expect(deriveNativeFamilyKey('openrouter', 'x-ai/grok-4.5')).toBe('xai:grok-4.5');
    expect(deriveNativeFamilyKey('openrouter', 'google/gemini-3-pro')).toBe('gemini:gemini-3-pro');
    expect(deriveNativeFamilyKey('openrouter', 'moonshotai/kimi-k3')).toBe('moonshot:kimi-k3');
    expect(deriveNativeFamilyKey('openrouter', 'mistralai/mistral-large')).toBe('mistral:mistral-large');
    expect(deriveNativeFamilyKey('openrouter', 'deepseek/deepseek-chat')).toBe('deepseek:deepseek-chat');
  });

  it('trims each segment independently (stray whitespace from provider lists)', () => {
    expect(deriveNativeFamilyKey('openrouter', ' MiniMax / MiniMax-M3 ')).toBe('minimax:minimax-m3');
    expect(deriveNativeFamilyKey('openrouter', '  / model')).toBeNull(); // empty vendor after trim
    expect(deriveNativeFamilyKey('openrouter', 'minimax /  ')).toBeNull(); // empty id after trim
  });

  it('preserves variant suffixes — the paid unsuffixed key is never produced for :free', () => {
    expect(deriveNativeFamilyKey('openrouter', 'minimax/minimax-m3:free')).toBe(
      'minimax:minimax-m3:free',
    );
  });

  it('yields null for everything outside the conservative allowlists', () => {
    expect(deriveNativeFamilyKey('openrouter', 'somevendor/model-1')).toBeNull(); // unmapped vendor
    expect(deriveNativeFamilyKey('openrouter', 'gpt-4o')).toBeNull(); // no vendor prefix
    expect(deriveNativeFamilyKey('openai', 'minimax/minimax-m3')).toBeNull(); // not an aggregator
    expect(deriveNativeFamilyKey('openrouter', 'minimax/')).toBeNull(); // empty id after prefix
    expect(deriveNativeFamilyKey('openrouter', '/model')).toBeNull(); // empty vendor
  });
});

describe('resolveModelPrice — native-family fallback', () => {
  const input = {
    providerKind: 'api_key',
    modelInputPricePer1m: null,
    modelOutputPricePer1m: null,
    modelIsFree: false,
    listedInputPricePer1m: null,
    listedOutputPricePer1m: null,
    listedIsFree: false,
  };
  const nativeRow = catalogRow({
    id: 'v-native',
    modelKey: 'minimax:minimax-m3',
    inputPricePer1m: 0.3,
    outputPricePer1m: 1.2,
    cacheReadPricePer1m: 0.06,
    source: 'refresh',
  });

  it('the exact row always beats the native row', () => {
    const exact = catalogRow({ id: 'v-exact', modelKey: 'openrouter:minimax/minimax-m3' });
    const snap = resolveModelPrice(input, exact, nativeRow);
    expect(snap?.priceVersionId).toBe('v-exact');
    expect(snap?.source).toBe('bundled');
  });

  it('the live minimax case: exact miss + native row → flagged native_family snapshot', () => {
    const snap = resolveModelPrice(input, null, nativeRow);
    expect(snap).toMatchObject({
      priceVersionId: 'v-native',
      modelKey: 'minimax:minimax-m3',
      inputPricePer1m: 0.3,
      outputPricePer1m: 1.2,
      cacheReadPricePer1m: 0.06,
      source: 'native_family', // NEVER the native row's own 'refresh' label
    });
  });

  it('model-own and local precedence are unaffected; both-miss stays null', () => {
    const own = resolveModelPrice(
      {
        providerKind: 'custom',
        modelInputPricePer1m: 1,
        modelOutputPricePer1m: 2,
        modelIsFree: false,
        listedInputPricePer1m: null,
        listedOutputPricePer1m: null,
        listedIsFree: false,
      },
      null,
      nativeRow,
    );
    expect(own?.source).toBe('model');
    const local = resolveModelPrice(
      {
        providerKind: 'local',
        modelInputPricePer1m: null,
        modelOutputPricePer1m: null,
        modelIsFree: false,
        listedInputPricePer1m: null,
        listedOutputPricePer1m: null,
        listedIsFree: false,
      },
      null,
      nativeRow,
    );
    expect(local?.source).toBe('local');
    expect(resolveModelPrice(input, null, null)).toBeNull();
  });
});

describe('resolveModelPrice — listed fallback (record-listed-price-fallback)', () => {
  const withListed = {
    providerKind: 'api_key',
    modelInputPricePer1m: null,
    modelOutputPricePer1m: null,
    modelIsFree: false,
    listedInputPricePer1m: 3,
    listedOutputPricePer1m: 15,
    listedIsFree: false,
  };
  const nativeRow = catalogRow({ id: 'v-native', modelKey: 'openai:gpt-4o', source: 'refresh' });

  it('is the LAST resort: used only when exact + native both miss', () => {
    const snap = resolveModelPrice(withListed, null, null);
    expect(snap?.source).toBe('listed');
    expect(snap?.inputPricePer1m).toBe(3);
    expect(snap?.outputPricePer1m).toBe(15);
    // A per-model captured estimate, not a catalog version.
    expect(snap?.priceVersionId).toBeNull();
    expect(snap?.validFrom).toBeNull();
  });

  it('never beats an exact catalog hit', () => {
    const snap = resolveModelPrice(withListed, catalogRow(), null);
    expect(snap?.source).not.toBe('listed');
    expect(['bundled', 'refresh', 'manual']).toContain(snap?.source);
  });

  it('never beats the native-family estimate', () => {
    const snap = resolveModelPrice(withListed, null, nativeRow);
    expect(snap?.source).toBe('native_family');
  });

  it('never beats a custom model-own price', () => {
    const snap = resolveModelPrice(
      { ...withListed, providerKind: 'custom', modelInputPricePer1m: 1, modelOutputPricePer1m: 2 },
      null,
      null,
    );
    expect(snap?.source).toBe('model');
  });

  it('a half listed price (one rate null) is skipped → null', () => {
    expect(resolveModelPrice({ ...withListed, listedOutputPricePer1m: null }, null, null)).toBeNull();
    expect(resolveModelPrice({ ...withListed, listedInputPricePer1m: null }, null, null)).toBeNull();
  });

  it('carries listedIsFree for a zero-priced listed estimate', () => {
    const snap = resolveModelPrice(
      { ...withListed, listedInputPricePer1m: 0, listedOutputPricePer1m: 0, listedIsFree: true },
      null,
      null,
    );
    expect(snap?.source).toBe('listed');
    expect(snap?.isFree).toBe(true);
  });

  it('a 0/0 listed price that is NOT free is skipped (uncapturable non-token charge) → null', () => {
    // e.g. token rates 0 but a per-request charge → not free, and we can't
    // capture the real cost, so record unknown rather than a false "$0 free".
    const snap = resolveModelPrice(
      { ...withListed, listedInputPricePer1m: 0, listedOutputPricePer1m: 0, listedIsFree: false },
      null,
      null,
    );
    expect(snap).toBeNull();
  });
});
