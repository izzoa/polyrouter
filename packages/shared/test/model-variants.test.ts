// model-variants (add-model-variant-detection): the classifier's pinned matrix.
// Each case guards a specific decision from the design:
//   D1 allowlist-not-shape, D2 aggregator scoping, D9 suffix-only normalization.
import { describe, expect, it } from 'vitest';
import {
  MODEL_VARIANTS,
  NON_ROUTABLE_VARIANTS,
  isNonRoutableVariant,
  modelBatchCapable,
  parseModelVariant,
  variantForProvider,
} from '../src/server';

describe('parseModelVariant — pinned matrix', () => {
  it('classifies known suffixes and preserves the base id byte-for-byte', () => {
    expect(parseModelVariant('openai/gpt-6-astra:batch')).toEqual({
      base: 'openai/gpt-6-astra',
      variant: 'batch',
    });
    expect(parseModelVariant('meta-llama/llama-3.3-70b-instruct:free')).toEqual({
      base: 'meta-llama/llama-3.3-70b-instruct',
      variant: 'free',
    });
  });

  it('lower-cases ONLY the suffix — the base keeps its original casing (D9)', () => {
    // A lower-cased base would not match the stored, case-sensitive sibling row,
    // which is the entire point of the pairing.
    expect(parseModelVariant('MiniMax/MiniMax-M3:BATCH')).toEqual({
      base: 'MiniMax/MiniMax-M3',
      variant: 'batch',
    });
  });

  it('never classifies by shape — a colon that is not a variant is part of the id (D1)', () => {
    // The regression this allowlist exists for: "text after the last colon"
    // would read `0` as the variant of a real Bedrock-style id.
    expect(parseModelVariant('anthropic.claude-haiku-4-5-20251001-v1:0')).toBeNull();
    expect(parseModelVariant('openai/gpt-6-astra:experimental')).toBeNull();
    expect(parseModelVariant('gpt-4o')).toBeNull();
    expect(parseModelVariant('openai/gpt-6-astra:')).toBeNull();
    expect(parseModelVariant(':batch')).toBeNull();
  });

  it('classifies at most one suffix, from the end', () => {
    expect(parseModelVariant('vendor/model:free:batch')).toEqual({
      base: 'vendor/model:free',
      variant: 'batch',
    });
  });
});

describe('variantForProvider — aggregator scoping (D2)', () => {
  it('classifies for an aggregator family', () => {
    expect(variantForProvider('openrouter', 'openai/gpt-6-astra:batch')).toEqual({
      base: 'openai/gpt-6-astra',
      variant: 'batch',
    });
  });

  it('classifies nothing for a direct, custom, or unmapped provider', () => {
    // A self-hosted gateway may legitimately serve a model named `foo:batch`;
    // blocking it would be wrong, not conservative.
    expect(variantForProvider('openai', 'openai/gpt-6-astra:batch')).toBeNull();
    expect(variantForProvider(null, 'openai/gpt-6-astra:batch')).toBeNull();
    expect(variantForProvider('', 'openai/gpt-6-astra:batch')).toBeNull();
  });

  it('is case- and whitespace-insensitive about the family itself', () => {
    expect(variantForProvider(' OpenRouter ', 'openai/gpt-6-astra:batch')).not.toBeNull();
  });
});

describe('routability is derived from the variant', () => {
  it('treats only batch as non-routable', () => {
    expect(isNonRoutableVariant('batch')).toBe(true);
    expect(isNonRoutableVariant('free')).toBe(false);
    expect(isNonRoutableVariant(null)).toBe(false);
    expect(isNonRoutableVariant(undefined)).toBe(false);
  });

  it('keeps the non-routable set a subset of the known tokens', () => {
    for (const v of NON_ROUTABLE_VARIANTS) expect(MODEL_VARIANTS).toContain(v);
  });
});

// The ONE rule the dashboard's `batchCapable` flag and the routing-entry write path both
// apply (fix-batch-capability-and-chain-alignment). Two predicates for this question would
// let the interface offer a reservation the API refuses, or refuse one it offers.
describe('modelBatchCapable — the seam, plus per-model evidence on an aggregator', () => {
  const base = { seam: true, billingFamily: 'openrouter', hasBatchTwin: false } as const;

  it('requires a batch-priced sibling twin on an aggregator family', () => {
    // OpenRouter sells batch as a per-model SKU — 69 of 431 models carried one when
    // add-model-variant-detection measured it — so the seam does not make the catalog
    // batchable and the twin is the aggregator's own record of which models are.
    expect(modelBatchCapable({ ...base, hasBatchTwin: true })).toBe(true);
    expect(modelBatchCapable({ ...base, hasBatchTwin: false })).toBe(false);
  });

  it('lets the seam alone decide on a native family, twin or no twin', () => {
    // Native Anthropic publishes NO batch rate polyrouter can resolve and mints no
    // twins. Demanding evidence here would report every Anthropic model unbatchable.
    expect(modelBatchCapable({ seam: true, billingFamily: 'anthropic', hasBatchTwin: false })).toBe(
      true,
    );
    expect(modelBatchCapable({ seam: true, billingFamily: 'openai', hasBatchTwin: false })).toBe(
      true,
    );
  });

  it('refuses whenever the provider has no seam, however the catalog looks', () => {
    expect(modelBatchCapable({ ...base, seam: false, hasBatchTwin: true })).toBe(false);
    expect(
      modelBatchCapable({ seam: false, billingFamily: 'anthropic', hasBatchTwin: false }),
    ).toBe(false);
  });

  it('is case- and whitespace-insensitive about the family, like every other family test', () => {
    expect(modelBatchCapable({ ...base, billingFamily: ' OpenRouter ', hasBatchTwin: false })).toBe(
      false,
    );
  });

  it('lets the seam decide for an unmapped family', () => {
    // Unreachable today (the seam is granted only to the three known families), and if
    // one ever held it, it would not be an aggregator — so no per-model convention exists
    // to demand evidence from.
    expect(modelBatchCapable({ seam: true, billingFamily: null, hasBatchTwin: false })).toBe(true);
  });
});
