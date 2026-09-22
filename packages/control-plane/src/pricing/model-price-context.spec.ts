/** The shared catalog context: the capability ladder and the bulk price lookup
 * both surfaces resolve through (honest-model-capabilities). */

import {
  deriveModelKey,
  deriveNativeFamilyKey,
  type ModelPriceRow,
  type ModelRow,
  type PersistencePort,
  type Principal,
} from '@polyrouter/shared/server';
import { loadPriceContext, toEffectiveCapabilities } from './model-price-context';

const priceRow = (over: Partial<ModelPriceRow> = {}): ModelPriceRow =>
  ({
    id: 'p1',
    modelKey: 'openai:gpt-4o',
    inputPricePer1m: 2.5,
    outputPricePer1m: 10,
    cacheReadPricePer1m: null,
    cacheWritePricePer1m: null,
    contextWindow: null,
    maxOutputTokens: null,
    supportsTools: null,
    supportsVision: null,
    supportsReasoning: null,
    isFree: false,
    batchInputPricePer1m: null,
    batchOutputPricePer1m: null,
    source: 'bundled',
    validFrom: new Date(0),
    createdAt: new Date(0),
    ...over,
  }) as ModelPriceRow;

describe('toEffectiveCapabilities — the describe ladder', () => {
  it('reports an exact-key row unmarked, carrying an asserted false as a false', () => {
    const caps = toEffectiveCapabilities(
      priceRow({ supportsTools: true, supportsVision: false, contextWindow: 128_000 }),
    );
    expect(caps).toEqual({
      supportsTools: true,
      supportsVision: false,
      contextWindow: 128_000,
      estimated: false,
    });
    // Silence on reasoning is unknown — absent, never rendered as a negative.
    expect(caps).not.toHaveProperty('supportsReasoning');
  });

  it('omits every field when no tier describes the model', () => {
    expect(toEffectiveCapabilities(null)).toEqual({ estimated: false });
    expect(toEffectiveCapabilities(priceRow())).toEqual({ estimated: false });
  });

  it('falls back to the native-family row and marks the result estimated', () => {
    const caps = toEffectiveCapabilities(
      null,
      priceRow({ supportsVision: true, contextWindow: 200_000 }),
    );
    expect(caps).toMatchObject({ supportsVision: true, contextWindow: 200_000, estimated: true });
  });

  it('falls back to the provider-listed claim last, also marked estimated', () => {
    const caps = toEffectiveCapabilities(null, null, {
      supportsTools: true,
      contextWindow: 64_000,
    });
    expect(caps).toMatchObject({ supportsTools: true, contextWindow: 64_000, estimated: true });
  });

  it('never lets a lower tier override a value the exact key states', () => {
    const caps = toEffectiveCapabilities(
      priceRow({ supportsVision: false }),
      priceRow({ supportsVision: true }),
      { supportsVision: true },
    );
    // The catalog says no; neither the adjacent channel nor the provider's own
    // claim may talk it into a yes.
    expect(caps.supportsVision).toBe(false);
    expect(caps.estimated).toBe(false);
  });

  it('descends PER FIELD, so a partial exact row still gets the rest answered', () => {
    const caps = toEffectiveCapabilities(
      priceRow({ supportsTools: true }), // exact key knows tools only
      priceRow({ supportsVision: true }), // native family knows vision
      { supportsReasoning: false }, // the provider claims no reasoning
    );
    expect(caps).toMatchObject({
      supportsTools: true,
      supportsVision: true,
      supportsReasoning: false,
      estimated: true, // something came from below the exact key
    });
  });

  it('treats a null claim field as silence, not as a false', () => {
    const caps = toEffectiveCapabilities(null, null, {
      supportsTools: null,
      supportsVision: false,
    });
    expect(caps).not.toHaveProperty('supportsTools');
    expect(caps.supportsVision).toBe(false);
  });

  it('marks estimated only when a resolved value came from below the exact key', () => {
    // A lower tier that answers NOTHING must not mark an exact-key result.
    expect(toEffectiveCapabilities(priceRow({ supportsTools: true }), priceRow()).estimated).toBe(
      false,
    );
    // …and an all-unknown result is not "estimated" either — it is silent.
    expect(toEffectiveCapabilities(null, priceRow(), {}).estimated).toBe(false);
  });
});

describe('loadPriceContext — one providers read, one catalog read', () => {
  const principal = { userId: 'u1' } as unknown as Principal;
  const BASE = 'https://openrouter.ai/api/v1';
  const EXTERNAL = 'anthropic/claude-sonnet-4-5';

  const model = { id: 'm1', providerId: 'pr1', externalModelId: EXTERNAL } as unknown as ModelRow;
  const provider = { id: 'pr1', baseUrl: BASE, kind: 'openrouter' };

  const makePort = (rows: readonly ModelPriceRow[]) => {
    const calls = { providersList: 0, priceAtMany: 0 };
    const keysSeen: string[][] = [];
    const port = {
      providers: {
        list: () => {
          calls.providersList += 1;
          return Promise.resolve([provider]);
        },
      },
      pricing: {
        priceAtMany: (keys: readonly string[]) => {
          calls.priceAtMany += 1;
          keysSeen.push([...keys]);
          return Promise.resolve(rows.filter((r) => keys.includes(r.modelKey)));
        },
      },
    } as unknown as PersistencePort;
    return { port, calls, keysSeen };
  };

  it('issues exactly one providers read and one catalog read for a model set', async () => {
    const { port, calls } = makePort([]);
    const ctx = await loadPriceContext(port, principal, [model, { ...model, id: 'm2' }]);
    expect(calls).toEqual({ providersList: 1, priceAtMany: 1 });
    // Resolving from the returned context issues nothing further (invariant 9).
    ctx.catalogRowOf(model);
    ctx.nativeRowOf(model);
    ctx.providerOf(model);
    ctx.kindOf(model);
    expect(calls).toEqual({ providersList: 1, priceAtMany: 1 });
  });

  it('carries the native-family key in the SAME batch as the exact key', async () => {
    const { port, keysSeen } = makePort([]);
    await loadPriceContext(port, principal, [model]);
    const exact = deriveModelKey(BASE, EXTERNAL);
    expect(exact).not.toBeNull();
    const native = deriveNativeFamilyKey(exact!.slice(0, exact!.indexOf(':')), EXTERNAL);
    expect(keysSeen).toHaveLength(1); // never a follow-up query per exact-key miss
    expect(keysSeen[0]).toContain(exact);
    if (native !== null) expect(keysSeen[0]).toContain(native);
  });

  it('feeds the capability ladder the rows a single batch returned', async () => {
    const exact = deriveModelKey(BASE, EXTERNAL)!;
    const native = deriveNativeFamilyKey(exact.slice(0, exact.indexOf(':')), EXTERNAL);
    const { port, calls } = makePort(
      native === null
        ? [priceRow({ modelKey: exact, supportsVision: true })]
        : [priceRow({ modelKey: native, supportsVision: true, contextWindow: 200_000 })],
    );
    const ctx = await loadPriceContext(port, principal, [model]);
    const caps = toEffectiveCapabilities(ctx.catalogRowOf(model), ctx.nativeRowOf(model));
    expect(caps.supportsVision).toBe(true);
    expect(calls.priceAtMany).toBe(1); // the whole ladder cost ONE read
  });
});
