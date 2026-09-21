/** The `/v1/models` catalog builder and its two envelopes (expand-models-listing). */

import {
  CATALOG_CREATED,
  buildCatalog,
  renderAnthropicEntry,
  renderAnthropicList,
  renderOpenAiEntry,
  renderOpenAiList,
  type CatalogModel,
} from './models-catalog';

const model = (over: Partial<CatalogModel> = {}): CatalogModel => ({
  providerId: 'openai',
  externalModelId: 'gpt-4o',
  displayName: 'GPT-4o',
  contextWindow: 128_000,
  supportsTools: true,
  supportsVision: true,
  supportsReasoning: false,
  variant: null,
  effectivePrice: {
    inputPricePer1m: 2.5,
    outputPricePer1m: 10,
    isFree: false,
    source: 'bundled',
    estimated: false,
  },
  ...over,
});

const byId = (entries: ReturnType<typeof buildCatalog>, id: string) =>
  entries.find((e) => e.id === id);

describe('buildCatalog', () => {
  it('advertises auto, tier keys, qualified ids, and unambiguous bare ids', () => {
    const entries = buildCatalog([model()], ['default', 'cheap']);
    expect(entries.map((e) => e.id)).toEqual([
      'auto',
      'default',
      'cheap',
      'openai:gpt-4o',
      'gpt-4o',
    ]);
  });

  it('withholds a bare id shared by two routable providers, keeping both qualified', () => {
    const entries = buildCatalog([model(), model({ providerId: 'azure' })], ['default']);
    const ids = entries.map((e) => e.id);
    expect(ids).toContain('openai:gpt-4o');
    expect(ids).toContain('azure:gpt-4o');
    expect(ids).not.toContain('gpt-4o'); // ambiguous — would resolve to ambiguous_model
  });

  it('excludes a non-routable variant under both spellings without withdrawing a bare id', () => {
    const entries = buildCatalog(
      [model(), model({ externalModelId: 'gpt-4o:batch', variant: 'batch' })],
      [],
    );
    const ids = entries.map((e) => e.id);
    expect(ids).not.toContain('gpt-4o:batch');
    expect(ids).not.toContain('openai:gpt-4o:batch');
    // Ambiguity is counted over the ROUTABLE set, so the base keeps its bare id.
    expect(ids).toContain('gpt-4o');
  });

  // --- task 1.2 / 1.3: metadata, and absent-never-null ---

  it('carries metadata on a real model, qualified and bare alike', () => {
    for (const id of ['openai:gpt-4o', 'gpt-4o']) {
      const e = byId(buildCatalog([model()], []), id);
      expect(e).toMatchObject({
        contextWindow: 128_000,
        supportsTools: true,
        supportsVision: true,
        supportsReasoning: false,
        price: { inputPricePer1m: 2.5, outputPricePer1m: 10, estimated: false },
      });
    }
  });

  it('marks an estimating price source as estimated', () => {
    const e = byId(
      buildCatalog(
        [
          model({
            effectivePrice: {
              inputPricePer1m: 1,
              outputPricePer1m: 2,
              isFree: false,
              source: 'native_family',
              estimated: true,
            },
          }),
        ],
        [],
      ),
      'gpt-4o',
    );
    expect(e?.price).toMatchObject({ source: 'native_family', estimated: true });
  });

  it('omits an unset context window and an unknown price rather than nulling them', () => {
    const e = byId(
      buildCatalog([model({ contextWindow: null, effectivePrice: null })], []),
      'gpt-4o',
    );
    expect(e).not.toHaveProperty('contextWindow');
    expect(e).not.toHaveProperty('price');
    expect(e?.id).toBe('gpt-4o'); // the required fields survive
  });

  it('falls back to the id when no display name is stored', () => {
    const entries = buildCatalog([model({ displayName: null })], []);
    expect(byId(entries, 'gpt-4o')?.displayName).toBe('gpt-4o');
    expect(byId(entries, 'openai:gpt-4o')?.displayName).toBe('openai:gpt-4o');
  });

  // --- task 1.4: virtual ids describe nothing ---

  it('gives auto and tier keys no descriptive metadata at all', () => {
    for (const id of ['auto', 'default']) {
      const e = byId(buildCatalog([model()], ['default']), id);
      expect(e).toEqual({ id, displayName: id });
    }
  });

  it('does not change a tier entry when its membership changes', () => {
    const before = byId(buildCatalog([model()], ['default']), 'default');
    const after = byId(
      buildCatalog([model(), model({ providerId: 'azure', externalModelId: 'o3' })], ['default']),
      'default',
    );
    expect(after).toEqual(before);
  });
});

describe('catalog envelopes', () => {
  const entries = buildCatalog([model()], ['default']);

  // --- task 1.5: created is fixed and sync-independent ---

  it('reports one fixed created value across every entry', () => {
    const created = renderOpenAiList(entries).data as { created: number }[];
    expect(new Set(created.map((d) => d.created))).toEqual(new Set([CATALOG_CREATED]));
  });

  it('renders the same catalog identically on a rebuild', () => {
    // Nothing in the entry derives from a clock or a sync timestamp, so a second
    // build after a sync produces a byte-identical envelope.
    expect(renderOpenAiList(buildCatalog([model()], ['default']))).toEqual(
      renderOpenAiList(entries),
    );
  });

  // --- task 2.1: neither envelope leaks the other's keys ---

  it('renders the OpenAI shape without Anthropic keys', () => {
    const body = renderOpenAiList(entries) as { object: string; data: Record<string, unknown>[] };
    expect(body.object).toBe('list');
    expect(body).not.toHaveProperty('has_more');
    for (const d of body.data) {
      expect(d).toMatchObject({ object: 'model', owned_by: 'polyrouter' });
      expect(d).not.toHaveProperty('type');
      expect(d).not.toHaveProperty('display_name');
      expect(d).not.toHaveProperty('created_at');
    }
  });

  it('renders the Anthropic shape as one complete page without OpenAI keys', () => {
    const body = renderAnthropicList(entries) as {
      data: Record<string, unknown>[];
      has_more: boolean;
      first_id: string | null;
      last_id: string | null;
    };
    expect(body.has_more).toBe(false);
    expect(body.first_id).toBe('auto');
    expect(body.last_id).toBe(entries[entries.length - 1]!.id);
    expect(body).not.toHaveProperty('object');
    for (const d of body.data) {
      expect(d).toMatchObject({ type: 'model' });
      expect(d).toHaveProperty('display_name');
      expect(d).not.toHaveProperty('object');
      expect(d).not.toHaveProperty('owned_by');
      expect(d).not.toHaveProperty('created');
    }
  });

  it('reports null ends for an empty catalog', () => {
    const body = renderAnthropicList([]) as { first_id: null; last_id: null };
    expect(body.first_id).toBeNull();
    expect(body.last_id).toBeNull();
  });

  it('renders metadata in snake_case per-1M fields, and omits it for virtual ids', () => {
    const real = renderOpenAiEntry(byId(entries, 'gpt-4o')!);
    expect(real).toMatchObject({
      context_window: 128_000,
      supports_tools: true,
      supports_vision: true,
      supports_reasoning: false,
      pricing: { input_per_1m: 2.5, output_per_1m: 10, is_free: false, estimated: false },
    });
    for (const render of [renderOpenAiEntry, renderAnthropicEntry]) {
      const virtual = render(byId(entries, 'auto')!);
      expect(virtual).not.toHaveProperty('context_window');
      expect(virtual).not.toHaveProperty('supports_tools');
      expect(virtual).not.toHaveProperty('pricing');
    }
  });
});
