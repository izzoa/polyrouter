import {
  usageFromAnthropic,
  usageToAnthropic,
  usageFromOpenai,
  usageToOpenai,
  mergePartialUsage,
  partialToNormalized,
} from './usage';

describe('usage conversion — uncached components (invariant 4, §7.7)', () => {
  it('Anthropic components map 1:1 (input already excludes cache)', () => {
    const ir = usageFromAnthropic({
      input_tokens: 20,
      output_tokens: 5,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 10,
    });
    expect(ir).toEqual({
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
    });
  });

  it('Anthropic {20 fresh, 80 read, 10 write} → OpenAI prompt_tokens 110, cached 80', () => {
    const ir = usageFromAnthropic({
      input_tokens: 20,
      output_tokens: 5,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 10,
    });
    expect(ir).toBeDefined();
    const oai = usageToOpenai(ir!);
    expect(oai).toEqual({
      prompt_tokens: 110,
      completion_tokens: 5,
      total_tokens: 115,
      prompt_tokens_details: { cached_tokens: 80 },
    });
  });

  it('OpenAI subtracts cached_tokens to get uncached input', () => {
    const ir = usageFromOpenai({
      prompt_tokens: 100,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 80 },
    });
    expect(ir).toEqual({ inputTokens: 20, outputTokens: 5, cacheReadTokens: 80 });
  });

  it('OpenAI round-trips prompt_tokens and cached_tokens', () => {
    const wire = {
      prompt_tokens: 100,
      completion_tokens: 5,
      total_tokens: 105,
      prompt_tokens_details: { cached_tokens: 80 },
    };
    const ir = usageFromOpenai(wire);
    expect(ir).toBeDefined();
    expect(usageToOpenai(ir!)).toEqual(wire);
  });

  it('cache-write-only maps through OpenAI folding write into prompt_tokens', () => {
    const ir = usageFromAnthropic({
      input_tokens: 30,
      output_tokens: 7,
      cache_creation_input_tokens: 50,
    });
    expect(ir).toEqual({ inputTokens: 30, outputTokens: 7, cacheWriteTokens: 50 });
    // OpenAI has no cache-write price → folds into prompt_tokens, no cached_tokens.
    expect(usageToOpenai(ir!)).toEqual({
      prompt_tokens: 80,
      completion_tokens: 7,
      total_tokens: 87,
    });
  });

  it('Anthropic usage round-trips through the IR', () => {
    const wire = {
      input_tokens: 20,
      output_tokens: 5,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 10,
    };
    const ir = usageFromAnthropic(wire);
    expect(ir).toBeDefined();
    expect(usageToAnthropic(ir!)).toEqual(wire);
  });

  it('missing usage stays undefined, never zero', () => {
    expect(usageFromAnthropic(undefined)).toBeUndefined();
    expect(usageFromOpenai(undefined)).toBeUndefined();
  });
});

describe('streaming partial usage', () => {
  it('merges components with later values winning', () => {
    const merged = mergePartialUsage(
      { inputTokens: 100, cacheReadTokens: 80 },
      { outputTokens: 2 },
    );
    expect(merged).toEqual({ inputTokens: 100, cacheReadTokens: 80, outputTokens: 2 });
  });

  it('finalizes only when input and output are present', () => {
    expect(partialToNormalized({ inputTokens: 100 })).toBeUndefined();
    expect(partialToNormalized({ inputTokens: 100, outputTokens: 2, cacheReadTokens: 80 })).toEqual(
      { inputTokens: 100, outputTokens: 2, cacheReadTokens: 80 },
    );
  });
});
