// add-provider-price-sync-and-edit — golden cases for the OpenRouter-style per-model
// `pricing` extension that `parseModelList` surfaces as a per-1M USD DISPLAY estimate.
// Invariant: this is display only, never billing (cost comes from the bundled catalog).
import { parseModelList } from './http-adapter';

// A representative OpenRouter `/models` page (per-token USD as decimal strings). Field
// names mirror the live endpoint; verify against it if OpenRouter changes the shape.
const OPENROUTER_PAGE = {
  data: [
    {
      id: 'moonshotai/kimi-k3',
      name: 'MoonshotAI: Kimi K3',
      pricing: { prompt: '0.000003', completion: '0.000015', request: '0', image: '0' },
    },
    {
      id: 'meta/muse-spark-1.1:free',
      name: 'Meta: Muse Spark (free)',
      pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
    },
    {
      // zero token rates but a non-zero per-request charge → $0 but NOT free
      id: 'vendor/metered-x',
      name: 'Vendor: Metered X',
      pricing: { prompt: '0', completion: '0', request: '0.01', image: '0' },
    },
    {
      // malformed price → whole pricing block omitted, id still parsed
      id: 'vendor/broken',
      name: 'Vendor: Broken',
      pricing: { prompt: 'n/a', completion: '0.00001' },
    },
    { id: 'vendor/no-pricing', name: 'Vendor: No Pricing' },
  ],
};

describe('parseModelList — provider-listed pricing (display estimate)', () => {
  const byId = (id: string) => parseModelList(OPENROUTER_PAGE).find((m) => m.id === id);

  it('scales per-token USD strings to per-1M USD exactly', () => {
    expect(byId('moonshotai/kimi-k3')?.pricing).toEqual({
      inputPricePer1m: 3,
      outputPricePer1m: 15,
    });
  });

  it('normalizes ×1e6 float noise at the boundary (never stores $0.19999999999999998)', () => {
    // 0.0000002 × 1e6 = 0.19999999999999998 in float64 — the stored estimate must be
    // the clean value the provider actually lists.
    const page = {
      data: [
        {
          id: 'tencent/hy3',
          pricing: { prompt: '0.0000002', completion: '0.0000008' },
        },
      ],
    };
    expect(parseModelList(page).find((m) => m.id === 'tencent/hy3')?.pricing).toEqual({
      inputPricePer1m: 0.2,
      outputPricePer1m: 0.8,
    });
  });

  it('marks isFree only when every listed monetary dimension is zero', () => {
    expect(byId('meta/muse-spark-1.1:free')?.pricing).toEqual({
      inputPricePer1m: 0,
      outputPricePer1m: 0,
      isFree: true,
    });
  });

  it('does NOT mark free when a non-token charge is non-zero (shows $0, not free)', () => {
    expect(byId('vendor/metered-x')?.pricing).toEqual({
      inputPricePer1m: 0,
      outputPricePer1m: 0,
    });
    expect(byId('vendor/metered-x')?.pricing?.isFree).toBeUndefined();
  });

  it('omits the pricing block on a malformed rate but keeps the model', () => {
    const m = byId('vendor/broken');
    expect(m).toBeDefined();
    expect(m?.pricing).toBeUndefined();
  });

  it('leaves pricing absent when the endpoint carries none (native OpenAI/Anthropic)', () => {
    expect(byId('vendor/no-pricing')?.pricing).toBeUndefined();
    // a bare OpenAI-style list is completely unaffected
    const plain = parseModelList({ data: [{ id: 'gpt-x' }, { id: 'gpt-y' }] });
    expect(plain.every((m) => m.pricing === undefined)).toBe(true);
  });

  it('ignores a negative rate (omits the block, never a wrong number)', () => {
    const out = parseModelList({
      data: [{ id: 'neg', pricing: { prompt: '-0.01', completion: '0.01' } }],
    });
    expect(out[0]?.pricing).toBeUndefined();
  });

  it('omits the block when per-1M scaling overflows to Infinity', () => {
    const out = parseModelList({
      data: [{ id: 'huge', pricing: { prompt: '1e308', completion: '0.01' } }],
    });
    expect(out[0]?.pricing).toBeUndefined();
  });
});
