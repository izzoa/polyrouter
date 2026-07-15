/**
 * Token-usage conversion. The two providers count input differently:
 *   - Anthropic `input_tokens` EXCLUDES cache tokens
 *     (totalInput = input_tokens + cache_read + cache_creation).
 *   - OpenAI `prompt_tokens` INCLUDES cached tokens (cached ⊆ prompt).
 * So we convert by formula, storing UNCACHED components in the IR
 * (`inputTokens` = fresh). A field-for-field copy would corrupt cost
 * (invariant 4, §7.7). Missing usage → `undefined`, never a silent zero.
 */
import type { NormalizedUsage, PartialUsage } from './ir';
import type { AntUsage } from './wire/anthropic';
import type { OaiUsage } from './wire/openai';

export function usageFromAnthropic(u: AntUsage | undefined): NormalizedUsage | undefined {
  if (u === undefined) return undefined;
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    ...(u.cache_read_input_tokens !== undefined
      ? { cacheReadTokens: u.cache_read_input_tokens }
      : {}),
    ...(u.cache_creation_input_tokens !== undefined
      ? { cacheWriteTokens: u.cache_creation_input_tokens }
      : {}),
  };
}

export function usageToAnthropic(u: NormalizedUsage): AntUsage {
  return {
    input_tokens: u.inputTokens,
    output_tokens: u.outputTokens,
    ...(u.cacheReadTokens !== undefined ? { cache_read_input_tokens: u.cacheReadTokens } : {}),
    ...(u.cacheWriteTokens !== undefined
      ? { cache_creation_input_tokens: u.cacheWriteTokens }
      : {}),
  };
}

export function usageFromOpenai(u: OaiUsage | undefined): NormalizedUsage | undefined {
  if (u === undefined) return undefined;
  const cached = u.prompt_tokens_details?.cached_tokens;
  const cacheRead = cached ?? 0;
  return {
    inputTokens: u.prompt_tokens - cacheRead,
    outputTokens: u.completion_tokens,
    ...(cached !== undefined ? { cacheReadTokens: cached } : {}),
    // OpenAI has no separate cache-write billing.
  };
}

export function usageToOpenai(u: NormalizedUsage): OaiUsage {
  const cacheRead = u.cacheReadTokens ?? 0;
  const cacheWrite = u.cacheWriteTokens ?? 0;
  // A cross-translated Anthropic cache-write folds into prompt_tokens; OpenAI
  // bills it at input rate (it has no cache-write price) — correct.
  const promptTokens = u.inputTokens + cacheRead + cacheWrite;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: u.outputTokens,
    total_tokens: promptTokens + u.outputTokens,
    ...(u.cacheReadTokens !== undefined
      ? { prompt_tokens_details: { cached_tokens: u.cacheReadTokens } }
      : {}),
  };
}

// --- Streaming: partial usage arrives across events, merged per component ---

const USAGE_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;

/** Component-wise merge; a later defined value wins over an earlier one. */
export function mergePartialUsage(...parts: readonly (PartialUsage | undefined)[]): PartialUsage {
  const out: { -readonly [K in keyof NormalizedUsage]?: number } = {};
  for (const part of parts) {
    if (part === undefined) continue;
    for (const key of USAGE_KEYS) {
      const v = part[key];
      if (v !== undefined) out[key] = v;
    }
  }
  return out;
}

/** A complete `NormalizedUsage` requires input + output; otherwise `undefined`
 * (an interrupted stream leaves the missing components unset — never zero). */
export function partialToNormalized(p: PartialUsage): NormalizedUsage | undefined {
  if (p.inputTokens === undefined || p.outputTokens === undefined) {
    return undefined;
  }
  return {
    inputTokens: p.inputTokens,
    outputTokens: p.outputTokens,
    ...(p.cacheReadTokens !== undefined ? { cacheReadTokens: p.cacheReadTokens } : {}),
    ...(p.cacheWriteTokens !== undefined ? { cacheWriteTokens: p.cacheWriteTokens } : {}),
  };
}

/** Anthropic `message_start` usage → partial (input/cache up front). */
export function partialUsageFromAnthropicStart(
  u: (Partial<AntUsage> & { output_tokens?: number }) | undefined,
): PartialUsage {
  if (u === undefined) return {};
  return {
    ...(u.input_tokens !== undefined ? { inputTokens: u.input_tokens } : {}),
    ...(u.output_tokens !== undefined ? { outputTokens: u.output_tokens } : {}),
    ...(u.cache_read_input_tokens !== undefined
      ? { cacheReadTokens: u.cache_read_input_tokens }
      : {}),
    ...(u.cache_creation_input_tokens !== undefined
      ? { cacheWriteTokens: u.cache_creation_input_tokens }
      : {}),
  };
}

/** OpenAI's terminal chunk carries the COMPLETE usage → partial. */
export function partialUsageFromOpenai(u: OaiUsage): PartialUsage {
  const normalized = usageFromOpenai(u);
  return normalized ?? {};
}
