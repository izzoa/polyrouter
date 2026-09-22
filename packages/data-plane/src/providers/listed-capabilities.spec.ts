// honest-model-capabilities — golden cases for the OpenRouter-style per-model
// CAPABILITY claim that `parseModelList` surfaces alongside the price estimate.
//
// Invariant: this is the provider's own CLAIM, not a fact. It is display-grade
// evidence only — the last tier of the description ladder, always surfaced as an
// estimate, and never routing evidence (routing admits the exact catalog key
// alone). The adapter transports it and never DERIVES one: no capability is
// inferred from a model id, a provider family, or any other heuristic.
import { parseModelList } from './http-adapter';

// Field names mirror the live OpenRouter `/models` endpoint; verify against it if
// the shape changes. A model states a capability by LISTING it, so a list that is
// present but omits an entry is a positive `false` — while a MISSING list is
// silence, which must stay unknown.
const PAGE = {
  data: [
    {
      id: 'anthropic/claude-sonnet-4-5',
      name: 'Anthropic: Claude Sonnet 4.5',
      context_length: 200000,
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      supported_parameters: ['tools', 'tool_choice', 'reasoning', 'max_tokens'],
    },
    {
      // Lists BOTH dimensions and excludes the capabilities — an asserted no.
      id: 'vendor/text-only',
      name: 'Vendor: Text Only',
      context_length: 8192,
      architecture: { input_modalities: ['text'] },
      supported_parameters: ['max_tokens', 'temperature'],
    },
    {
      // States nothing at all — silence, not a denial.
      id: 'vendor/undescribed',
      name: 'Vendor: Undescribed',
    },
  ],
};

const byId = (json: unknown) => new Map(parseModelList(json, 'name').map((m) => [m.id, m]));

describe('parseModelList — the provider capability claim', () => {
  it('carries a stated capability as an assertion, alongside id and name', () => {
    const m = byId(PAGE).get('anthropic/claude-sonnet-4-5');
    expect(m).toMatchObject({
      id: 'anthropic/claude-sonnet-4-5',
      displayName: 'Anthropic: Claude Sonnet 4.5',
    });
    expect(m?.capabilities).toEqual({
      supportsTools: true,
      supportsVision: true,
      supportsReasoning: true,
      contextWindow: 200000,
    });
  });

  it('reads an EXCLUSION from a present list as a positive false', () => {
    // The provider published both lists and this model is in neither — that is
    // information, and it is different from having published nothing.
    expect(byId(PAGE).get('vendor/text-only')?.capabilities).toEqual({
      supportsTools: false,
      supportsVision: false,
      supportsReasoning: false,
      contextWindow: 8192,
    });
  });

  it('omits the claim entirely when the provider states nothing', () => {
    const m = byId(PAGE).get('vendor/undescribed');
    expect(m).toBeDefined();
    expect(m).not.toHaveProperty('capabilities');
  });

  it('keeps silence on one dimension independent of the other', () => {
    // Enumerating accepted modalities says NOTHING about tool calling. A parser
    // that inferred a negative from that silence would manufacture exactly the
    // false-negative this field exists to prevent.
    const m = byId({
      data: [{ id: 'x/partial', architecture: { input_modalities: ['text', 'image'] } }],
    }).get('x/partial');
    expect(m?.capabilities).toEqual({ supportsVision: true });
    expect(m?.capabilities).not.toHaveProperty('supportsTools');
    expect(m?.capabilities).not.toHaveProperty('supportsReasoning');
  });

  it('a malformed claim costs only itself — never the id, name, or pricing', () => {
    const rows = byId({
      data: [
        {
          id: 'x/broken',
          name: 'Broken',
          pricing: { prompt: '0.000002', completion: '0.000008' },
          architecture: 'not-an-object',
          supported_parameters: 'not-a-list',
          context_length: -1,
        },
      ],
    });
    const m = rows.get('x/broken');
    expect(m).toMatchObject({ id: 'x/broken', displayName: 'Broken' });
    expect(m?.pricing).toMatchObject({ inputPricePer1m: 2, outputPricePer1m: 8 });
    expect(m).not.toHaveProperty('capabilities');
  });

  it('admits a context length only as a positive integer', () => {
    for (const bad of [0, -8192, 1.5, NaN, Infinity, '200000', null]) {
      const m = byId({ data: [{ id: 'x/ctx', context_length: bad }] }).get('x/ctx');
      expect(m).toBeDefined();
      expect(m?.capabilities?.contextWindow).toBeUndefined();
    }
    expect(
      byId({ data: [{ id: 'x/ctx', context_length: 32768 }] }).get('x/ctx')?.capabilities,
    ).toEqual({ contextWindow: 32768 });
  });

  it('ignores non-string entries in a list rather than coercing them', () => {
    const m = byId({
      data: [{ id: 'x/junk', supported_parameters: [{ tools: true }, 42, 'tools'] }],
    }).get('x/junk');
    // 'tools' is genuinely listed; the junk entries neither add nor remove.
    expect(m?.capabilities).toEqual({ supportsTools: true, supportsReasoning: false });
  });

  it('matches capability case-insensitively, as provider lists vary', () => {
    const m = byId({
      data: [{ id: 'x/case', architecture: { input_modalities: ['TEXT', 'Image'] } }],
    }).get('x/case');
    expect(m?.capabilities).toEqual({ supportsVision: true });
  });

  it('is absent for a native OpenAI/Anthropic list, which carries no such fields', () => {
    const rows = parseModelList({ data: [{ id: 'gpt-4o' }, { id: 'claude-sonnet-4-5' }] });
    expect(rows).toHaveLength(2);
    for (const m of rows) {
      expect(m).not.toHaveProperty('capabilities');
      expect(m).not.toHaveProperty('pricing'); // behaviour unchanged for these
    }
  });
});
