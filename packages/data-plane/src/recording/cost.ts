/**
 * Pure cost + usage math for request logging (#11, spec §7.7; invariants 4, 9).
 * No DB, no clock, no network, no tokenizer. `input`/`output` tokens are the IR's
 * UNCACHED components; cache tokens are separate (total input = input + cache-read
 * + cache-write). Cost is per-component per-1M USD.
 */
import type { PriceSnapshot } from '@polyrouter/shared/server';
import type { PartialUsage } from '../proxy/translate';

export interface ResolvedUsage {
  /** Uncached input tokens. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  /** True when any component was estimated rather than reported by the provider. */
  readonly estimated: boolean;
}

/**
 * Cost in USD, or `null` when it is genuinely unknown: no price at all, OR a
 * non-zero cache component whose rate the catalog lacks (returning an understated
 * cost would corrupt immutable spend). A free model is 0.
 */
export function computeCost(usage: ResolvedUsage, price: PriceSnapshot | null): number | null {
  if (price === null) return null;
  if (price.isFree) return 0;

  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  if (cacheRead > 0 && price.cacheReadPricePer1m === null) return null;
  if (cacheWrite > 0 && price.cacheWritePricePer1m === null) return null;

  let cost =
    (usage.inputTokens / 1_000_000) * price.inputPricePer1m +
    (usage.outputTokens / 1_000_000) * price.outputPricePer1m;
  if (cacheRead > 0) cost += (cacheRead / 1_000_000) * (price.cacheReadPricePer1m ?? 0);
  if (cacheWrite > 0) cost += (cacheWrite / 1_000_000) * (price.cacheWritePricePer1m ?? 0);
  return cost;
}

/** Routing-grade token estimate (`chars/4`) — never a billing tokenizer (invariant 9). */
export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

export interface UsageInputs {
  /** The provider's reported usage (from the IR) — may be undefined or partial. */
  readonly providerUsage?: PartialUsage;
  /** Character count of the request (for the input estimate). */
  readonly requestChars: number;
  /** Character count of the response output — assistant text + tool name/args. */
  readonly outputChars: number;
}

/**
 * Prefer complete provider usage; otherwise estimate the missing components and
 * flag `estimated`. When input is estimated but cache tokens are known, the
 * uncached input is `estimatedTotal − knownCache` so cached tokens aren't
 * double-counted (input is uncached by definition).
 */
export function resolveUsage(inputs: UsageInputs): ResolvedUsage {
  const u = inputs.providerUsage;
  const cacheRead = u?.cacheReadTokens;
  const cacheWrite = u?.cacheWriteTokens;
  const cacheCols = {
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
  };

  if (u?.inputTokens !== undefined && u.outputTokens !== undefined) {
    return {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      ...cacheCols,
      estimated: false,
    };
  }

  const knownCache = (cacheRead ?? 0) + (cacheWrite ?? 0);
  const inputTokens =
    u?.inputTokens ?? Math.max(0, estimateTokens(inputs.requestChars) - knownCache);
  const outputTokens = u?.outputTokens ?? estimateTokens(inputs.outputChars);
  return { inputTokens, outputTokens, ...cacheCols, estimated: true };
}
